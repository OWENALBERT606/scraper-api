import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { baseKey, searchContent, seasonEpisode, seriesBase } from "../scrapers/freewatch";
import { freewatchSource, Source, SourceDetail } from "./sources";
import { B2Store } from "./b2";
import { b2ObjectUrl, ImportConfig, loadImportConfig } from "./config";
import {
  bestTmdbMatch,
  bytesToSize,
  cleanTitle,
  cleanVj,
  durationToSeconds,
  extensionOf,
  looksLikeFilm,
  normalizeTitle,
  safeKeyPart,
  secondsToLength,
  sizeToBytes,
} from "./parse";
import { Platform, PlatformError } from "./platform";

export type ItemStatus = "queued" | "checking" | "ready" | "downloading" | "saving" | "imported" | "skipped" | "failed";

export interface ImportItem {
  sourceId: string;
  title: string;
  vj: string;
  status: ItemStatus;
  /** why it was skipped or failed, or what it would do in a dry run */
  reason?: string;
  bytes: number;
  total: number;
  movieId?: string;
  tmdbMatched?: boolean;
  updatedAt: string;
}

export interface RunOptions {
  /** look, check and report, but download, upload and create nothing */
  dryRun?: boolean;
  /** stop after this many films have been imported (or, in a dry run, would be) */
  limit?: number;
  /** only these FreeWatch ids */
  ids?: (string | number)[];
  /** forget earlier failures so those films are tried again (films already imported are still skipped) */
  retryFailed?: boolean;
}

export interface ImportStatus {
  /** which site is being copied from */
  source: string;
  sourceLabel: string;
  configured: boolean;
  missing: string[];
  running: boolean;
  dryRun: boolean;
  startedAt?: string;
  finishedAt?: string;
  message: string;
  counts: Record<ItemStatus, number>;
  items: ImportItem[];
}

interface Ledger {
  imported: Record<string, { movieId: string; title: string; at: string }>;
  failed: Record<string, { attempts: number; reason: string; at: string }>;
}

interface SeriesState {
  /** the platform's series id, or null while the series does not exist yet */
  id: string | null;
  /** season number -> its id and the episode numbers already on the platform */
  tree: Map<number, { id: string; episodes: Set<number> }>;
  tmdbId?: number | string | null;
  lock: Promise<void>;
}

const MAX_ATTEMPTS = 3;
export class Importer {
  private cfg: ImportConfig;
  private missing: string[];
  private platform: Platform;
  private store: B2Store;
  private items = new Map<string, ImportItem>();
  private seriesCache = new Map<string, Promise<SeriesState>>();
  private running = false;
  private stopRequested = false;
  private dryRun = false;
  private startedAt?: string;
  private finishedAt?: string;
  private message = "Idle";
  private timer: NodeJS.Timeout | null = null;

  private source: Source;

  constructor(env: NodeJS.ProcessEnv = process.env, deps?: { platform?: Platform; store?: B2Store; source?: Source }) {
    const { config, missing } = loadImportConfig(env);
    this.source = deps?.source ?? freewatchSource();
    this.cfg = config;
    this.missing = [...missing, ...this.source.missing()];
    this.platform = deps?.platform ?? new Platform(config);
    this.store = deps?.store ?? new B2Store(config);
  }

  isConfigured(): boolean {
    return this.missing.length === 0;
  }

  status(): ImportStatus {
    const counts: Record<ItemStatus, number> = { queued: 0, checking: 0, ready: 0, downloading: 0, saving: 0, imported: 0, skipped: 0, failed: 0 };
    const items = Array.from(this.items.values());
    for (const i of items) counts[i.status]++;
    return {
      source: this.source.name,
      sourceLabel: this.source.label,
      configured: this.isConfigured(),
      missing: this.missing,
      running: this.running,
      dryRun: this.dryRun,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      message: this.message,
      counts,
      items: items.slice(-300),
    };
  }

  /** Starts a run in the background and returns at once; follow it with status(). */
  start(opts: RunOptions = {}): { started: boolean; reason?: string } {
    if (!this.isConfigured()) return { started: false, reason: `Not configured: set ${this.missing.join(", ")}` };
    if (this.running) return { started: false, reason: "An import is already running" };
    void this.run(opts);
    return { started: true };
  }

  stop(): void {
    this.stopRequested = true;
    this.message = "Stopping after the current film…";
  }

  /** Runs automatically every IMPORT_AUTORUN_MINUTES (does nothing when that is 0 or the importer is not configured). */
  startAutorun(): void {
    if (this.timer || this.cfg.autorunMinutes <= 0 || !this.isConfigured()) return;
    this.timer = setInterval(() => void this.start({}), this.cfg.autorunMinutes * 60_000);
    this.timer.unref?.();
    // the first run starts shortly after the server boots, so a restart or redeploy never waits a whole interval
    const first = setTimeout(() => void this.start({}), 30_000);
    first.unref?.();
  }

  stopAutorun(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── ledger: which source films were already handled, so a re-run never repeats work ───────────────────────────

  private ledgerPath(): string {
    return path.join(this.cfg.dataDir, this.source.name === "freewatch" ? "import-ledger.json" : `import-ledger-${this.source.name}.json`);
  }

  private async readLedger(): Promise<Ledger> {
    try {
      const l = JSON.parse(await fs.readFile(this.ledgerPath(), "utf8")) as Partial<Ledger>;
      return { imported: l.imported ?? {}, failed: l.failed ?? {} };
    } catch {
      return { imported: {}, failed: {} };
    }
  }

  private async writeLedger(l: Ledger): Promise<void> {
    await fs.mkdir(this.cfg.dataDir, { recursive: true });
    const tmp = `${this.ledgerPath()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(l, null, 2));
    await fs.rename(tmp, this.ledgerPath());
  }

  // ── finding what the source has ─────────────────────────────────────────────────────────────────────────────

  private discover(): Promise<{ ids: string[]; groupSize: Map<string, number> }> {
    return this.source.discover((m) => (this.message = m));
  }

  // ── the run ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private touch(item: ImportItem, patch: Partial<ImportItem>): void {
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
  }

  async run(opts: RunOptions = {}): Promise<ImportStatus> {
    if (this.running) return this.status();
    this.running = true;
    this.stopRequested = false;
    this.dryRun = !!opts.dryRun;
    this.startedAt = new Date().toISOString();
    this.finishedAt = undefined;
    this.items.clear();
    this.seriesCache.clear();
    this.message = "Looking at what the source has…";
    try {
      await this.platform.signIn(); // a wrong address or password stops the run here, before any film is touched
      const ledger = await this.readLedger();
      if (opts.retryFailed && !this.dryRun) {
        ledger.failed = {};
        await this.writeLedger(ledger);
      }
      const found = opts.ids?.length
        ? { ids: this.source.expand ? await this.source.expand(opts.ids.map(String)) : opts.ids.map(String), groupSize: new Map<string, number>() }
        : await this.discover();
      if (this.source.name === "freewatch" && this.cfg.series && !opts.ids?.length && !this.stopRequested) {
        // series already on the platform: look for episodes the source has that the platform does not
        const missing = await this.missingEpisodes();
        const all = new Set(found.ids);
        for (const id of missing.map(String)) {
          all.add(id);
          found.groupSize.set(id, Math.max(found.groupSize.get(id) ?? 0, 2));
        }
        found.ids = [...all];
      }
      const fresh = found.ids.filter((id) => !ledger.imported[id] && (ledger.failed[id]?.attempts ?? 0) < MAX_ATTEMPTS);
      this.message = `${found.ids.length} titles found, ${found.ids.length - fresh.length} already handled earlier. Checking the rest…`;

      const sections = await this.sectionGenres();
      let done = 0;
      let next = 0;
      const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
      const worker = async () => {
        while (!this.stopRequested) {
          const id = fresh[next++];
          if (id === undefined) return;
          const imported = [...this.items.values()].filter((i) => i.status === "imported" || i.status === "ready").length;
          if (imported >= limit) return;
          await this.processOne(id, found.groupSize.get(id) ?? 1, sections, ledger).catch(() => undefined);
          done++;
          this.message = `${done} of ${fresh.length} checked`;
        }
      };
      await Promise.all(Array.from({ length: this.dryRun ? 4 : this.cfg.concurrency }, worker));
      if (!this.message.startsWith("The import stopped")) this.message = this.stopRequested ? "Stopped" : "Finished";
    } catch (e) {
      this.message = `The import stopped: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.running = false;
      this.finishedAt = new Date().toISOString();
    }
    return this.status();
  }

  /**
   * For every series already on the platform, searches the source for the same series under the same VJ and returns the
   * ids of episodes the platform does not have yet. Nothing is downloaded here; the normal episode path does the copying.
   */
  private async missingEpisodes(): Promise<number[]> {
    const ids: number[] = [];
    let list: Awaited<ReturnType<Platform["listSeries"]>> = [];
    try {
      list = await this.platform.listSeries();
    } catch (e) {
      this.message = `Series on the platform could not be listed (${e instanceof Error ? e.message : e}); skipping the missing-episode check`;
      return ids;
    }
    let checked = 0;
    let next = 0;
    const worker = async () => {
      while (!this.stopRequested) {
        const s = list[next++];
        if (!s) return;
        this.message = `Checking existing series for missing episodes (${++checked} of ${list.length})…`;
        try {
          const key = baseKey(s.title);
          const vjKey = normalizeTitle(cleanVj(s.vjName));
          const tree = await this.platform.seriesTree(s.id);
          const maxSeason = Math.max(1, ...tree.keys());
          // the source's search shows only a few results, so ask for the series and for each of its seasons
          const queries = [seriesBase(s.title) || s.title, ...Array.from({ length: Math.min(8, maxSeason + 1) }, (_, i) => `${seriesBase(s.title) || s.title} season ${i + 1}`)];
          const seen = new Set<number>();
          for (const q of queries) {
            const res = await searchContent(q).catch(() => null);
            for (const g of res?.series ?? []) {
              for (const ep of g.episodes ?? []) {
                const title = ep.title || g.title || "";
                if (baseKey(title) !== key || normalizeTitle(cleanVj(ep.vj)) !== vjKey) continue;
                const [sn, en] = seasonEpisode(title);
                if (!en || seen.has(Number(ep.id))) continue;
                seen.add(Number(ep.id));
                if (!tree.get(sn || 1)?.episodes.has(en)) ids.push(Number(ep.id));
              }
            }
          }
        } catch {
          /* this series is checked again on the next run */
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return ids;
  }

  private sectionGenres(): Promise<Map<number, string>> {
    return this.source.sections();
  }

  private async processOne(sourceId: string, groupSize: number, sections: Map<number, string>, ledger: Ledger): Promise<void> {
    const item: ImportItem = { sourceId, title: `#${sourceId}`, vj: "", status: "checking", bytes: 0, total: 0, updatedAt: new Date().toISOString() };
    this.items.set(sourceId, item);
    const skip = (reason: string) => this.touch(item, { status: "skipped", reason });
    let uploadedKey: string | null = null;

    try {
      const detail = await this.source.detail(sourceId);
      if (!detail) return skip("The source no longer has it (or it has no video)");
      const { title, year } = cleanTitle(detail.title || "");
      this.touch(item, { title: title || item.title, vj: cleanVj(detail.vj) });

      // ── 1. is it a film we can copy? ────────────────────────────────────────────────────────────────────────────
      const url = detail.playingurl || "";
      if (!title) return skip("The source has no title for it");
      if (!url) return skip("The source has no video address");
      if (detail.episode || (!detail.isFilm && !looksLikeFilm(detail.title || "", groupSize))) {
        if (!this.cfg.series) return skip("It looks like a series episode, not a film (series import is off)");
        return await this.processEpisode(item, detail, ledger, sections, skip);
      }
      const ext = extensionOf(url);
      if (this.cfg.mode === "copy" && (ext === "m3u8" || ext === "mpd")) return skip("The video is a streaming playlist, not a file that can be copied");
      if (/\b(part\s*(\d+|[a-d])|s\d{1,2}\s*e\d{1,3})\b/i.test(decodeURIComponent(url.split("/").pop() ?? ""))) {
        return skip("The file looks like one part of a longer film or an episode");
      }
      let vjName = cleanVj(detail.vj);
      if (!vjName) vjName = cleanVj(process.env.IMPORT_DEFAULT_VJ);
      if (!vjName) return skip("The source names no VJ (set IMPORT_DEFAULT_VJ to give such films one)");

      // ── 2. does it already exist? Decided BEFORE anything is downloaded ─────────────────────────────────────────
      const vj = await this.platform.findVj(vjName);
      const first = await this.platform.checkTitle(title, vj?.id);
      if (vj && first.duplicate) return skip("Already on the platform (same title and VJ)");
      if (this.cfg.skipAnyVj && first.existsAnyVj) return skip("Already on the platform (same title, any VJ)");

      // ── 3. metadata: the best match on TMDB (through the platform), else what the source gives ─────────────────
      const hit = detail.tmdbId ? { tmdbId: detail.tmdbId, title, year: null } : bestTmdbMatch(title, year, await this.platform.searchTmdb(title));
      const meta = hit?.tmdbId ? await this.platform.enrich(hit.tmdbId) : null;
      this.touch(item, { tmdbMatched: !!meta });
      const officialTitle = String(meta?.title || title).trim();
      if (normalizeTitle(officialTitle) !== normalizeTitle(title)) {
        const second = await this.platform.checkTitle(officialTitle, vj?.id);
        if (vj && second.duplicate) return skip("Already on the platform (same title and VJ)");
        if (this.cfg.skipAnyVj && second.existsAnyVj) return skip("Already on the platform (same title, any VJ)");
      }

      if (this.dryRun) {
        return this.touch(item, {
          status: "ready",
          reason: `Would ${this.cfg.mode === "copy" ? "copy to B2 and import" : "import (link only, no download)"} "${officialTitle}" by ${vjName}${meta ? " (full metadata from TMDB)" : " (source metadata only)"}`,
          total: sizeToBytes(detail.size),
        });
      }

      // ── 4. everything the platform needs: VJ, genre, year ────────────────────────────────────────────────────────
      const vjRow = vj ?? (await this.platform.ensureVj(vjName));
      let genreId = (meta?.genreId as string | null) || "";
      if (!genreId) {
        const name = detail.genreName || sections.get(Number(detail.category_id));
        if (name) genreId = (await this.platform.ensureGenre(name)).id;
      }
      if (!genreId) return this.fail(item, ledger, sourceId, "No genre could be decided (no metadata match and an unknown category)");
      let yearId = (meta?.yearId as string | null) || "";
      if (!yearId) {
        const y = year ?? detail.year ?? (detail.timestamp ? new Date(detail.timestamp.replace(" ", "T") + "Z").getUTCFullYear() : new Date().getUTCFullYear());
        yearId = (await this.platform.ensureYear(y)).id;
      }

      // ── 5. the video goes to B2 while it downloads ─────────────────────────────────────────────────────────────
      let videoUrl = url;
      let sizeBytes = sizeToBytes(detail.size);
      if (this.cfg.mode === "copy") {
        this.touch(item, { status: "downloading", reason: undefined });
        const key = `${randomUUID()}-${safeKeyPart(officialTitle)} ${safeKeyPart(vjName)}.${ext || "mp4"}`;
        uploadedKey = key;
        const copied = await this.store.copy(url, key, (bytes, total) => this.touch(item, { bytes, total }), undefined, this.source.referer);
        videoUrl = b2ObjectUrl(this.cfg.b2, key.split("/").map(encodeURIComponent).join("/"));
        sizeBytes = copied.bytes;
      }

      // ── 6. the movie, with every piece of metadata we have ─────────────────────────────────────────────────────
      this.touch(item, { status: "saving" });
      const lengthSeconds = Number(meta?.lengthSeconds) || durationToSeconds(detail.duration);
      const description = String(meta?.description || "").trim() || String(detail.description || "").replace(/\s*\.{3}\s*$/, "").trim();
      const poster = String(meta?.poster || detail.image || "");
      const created = await this.platform.createMovie({
        title: officialTitle,
        description,
        poster,
        image: String(meta?.image || poster),
        trailerPoster: String(meta?.trailerPoster || ""),
        trailerUrl: String(meta?.trailerUrl || ""),
        director: String(meta?.director || ""),
        cast: Array.isArray(meta?.cast) ? meta?.cast : [],
        rating: Number(meta?.rating) || 0,
        vjId: vjRow.id,
        genreIds: [genreId],
        yearId,
        length: String(meta?.length || secondsToLength(lengthSeconds)),
        lengthSeconds,
        size: bytesToSize(sizeBytes),
        sizeBytes,
        videoUrl,
        isComingSoon: false,
        isTrending: false,
      });
      uploadedKey = null; // the movie now owns the file
      ledger.imported[String(sourceId)] = { movieId: created.id, title: officialTitle, at: new Date().toISOString() };
      delete ledger.failed[String(sourceId)];
      await this.writeLedger(ledger);
      this.touch(item, { status: "imported", movieId: created.id, title: officialTitle, reason: meta ? "Imported with TMDB metadata" : "Imported with the source's metadata" });
    } catch (e) {
      if (uploadedKey) await this.store.remove(uploadedKey).catch(() => undefined); // never leave an orphaned file in the bucket
      if (e instanceof PlatformError && e.fatal) {
        this.stopRequested = true;
        this.message = `The import stopped: ${e.message}`;
      }
      if (e instanceof PlatformError && e.status === 409) return skip("Already on the platform (created while this ran)");
      await this.fail(item, ledger, sourceId, e instanceof Error ? e.message : String(e));
    }
  }

  // ── series episodes ─────────────────────────────────────────────────────────────────────────────────────────────

  /** One series on the platform, shared by all of its episodes in a run. Changes to it are made one at a time (lock). */
  private seriesState(key: string, load: () => Promise<SeriesState>): Promise<SeriesState> {
    let p = this.seriesCache.get(key);
    if (!p) {
      p = load();
      this.seriesCache.set(key, p);
      p.catch(() => this.seriesCache.delete(key)); // a failed lookup is tried again for the next episode
    }
    return p;
  }

  private async processEpisode(
    item: ImportItem,
    detail: SourceDetail,
    ledger: Ledger,
    sections: Map<number, string>,
    skip: (reason: string) => void
  ): Promise<void> {
    const sourceId = item.sourceId;
    const raw = detail.title || "";
    const given = detail.episode;
    const parsed = given ? { title: given.base, year: detail.year ?? null } : cleanTitle(seriesBase(raw));
    const base = parsed.title || seriesBase(raw);
    const [seasonRead, episodeRead] = given ? [given.season, given.episode] : seasonEpisode(raw);
    const episode = episodeRead;
    const season = seasonRead || 1;
    if (!base) return skip("The series name could not be read from the title");
    if (!episode) return skip("The episode number could not be read from the title");
    this.touch(item, { title: `${base} S${season} E${episode}` });

    const url = detail.playingurl || "";
    if (!url) return skip("The source has no video address");
    const ext = extensionOf(url);
    if (this.cfg.mode === "copy" && (ext === "m3u8" || ext === "mpd")) return skip("The video is a streaming playlist, not a file that can be copied");
    const vjName = cleanVj(detail.vj) || cleanVj(process.env.IMPORT_DEFAULT_VJ);
    if (!vjName) return skip("The source names no VJ (set IMPORT_DEFAULT_VJ to give such series one)");

    // does it already exist? Decided BEFORE anything is downloaded
    const vj = await this.platform.findVj(vjName);
    const state = await this.seriesState(`${normalizeTitle(base)}|${normalizeTitle(vjName)}`, async () => {
      const found = vj ? await this.platform.findSeries(base, vj.id) : null;
      return { id: found?.id ?? null, tree: found ? await this.platform.seriesTree(found.id) : new Map(), lock: Promise.resolve() };
    });
    if (state.tree.get(season)?.episodes.has(episode)) return skip("Already on the platform (same series, season, episode and VJ)");
    if (this.dryRun) {
      return this.touch(item, {
        status: "ready",
        reason: `Would ${this.cfg.mode === "copy" ? "copy to B2 and import" : "import (link only)"} ${base} season ${season} episode ${episode} by ${vjName}${state.id ? "" : " (a new series)"}`,
        total: sizeToBytes(detail.size),
      });
    }

    let uploadedKey: string | null = null;
    try {
      // the series and the season exist before the video is copied (made one at a time per series)
      const seasonId = await this.exclusive(state, async () => {
        if (!state.id) {
          const hit = detail.tmdbId ? { tmdbId: detail.tmdbId, title: base, year: null } : bestTmdbMatch(base, parsed.year, await this.platform.searchTmdbSeries(base));
          const meta = hit?.tmdbId ? await this.platform.enrichSeries(hit.tmdbId) : null;
          state.tmdbId = hit?.tmdbId ?? null;
          const vjRow = vj ?? (await this.platform.ensureVj(vjName));
          let genreId = (meta?.genreId as string | null) || "";
          if (!genreId) {
            const name = detail.genreName || sections.get(Number(detail.category_id));
            if (name) genreId = (await this.platform.ensureGenre(name)).id;
          }
          if (!genreId) throw new Error("No genre could be decided for the series (no metadata match and an unknown category)");
          let yearId = (meta?.yearId as string | null) || "";
          if (!yearId) yearId = (await this.platform.ensureYear(parsed.year ?? new Date().getUTCFullYear())).id;
          const poster = String(meta?.poster || detail.image || "");
          try {
            state.id = (
              await this.platform.createSeries({
                title: String(meta?.title || base).trim(),
                description: String(meta?.description || "").trim() || String(detail.description || "").replace(/\s*\.{3}\s*$/, "").trim(),
                poster,
                trailerPoster: String(meta?.trailerPoster || ""),
                trailerUrl: String(meta?.trailerUrl || ""),
                director: String(meta?.director || ""),
                cast: Array.isArray(meta?.cast) ? meta?.cast : [],
                rating: Number(meta?.rating) || 0,
                vjId: vjRow.id,
                genreIds: [genreId],
                yearId,
                isComingSoon: false,
                isTrending: false,
                seasons: [],
              })
            ).id;
          } catch (e) {
            if (!(e instanceof PlatformError && e.status === 409)) throw e;
            state.id = (await this.platform.findSeries(String(meta?.title || base), vjRow.id))?.id ?? null; // made a moment ago by someone else
            if (!state.id) throw e;
            state.tree = await this.platform.seriesTree(state.id);
          }
        }
        const have = state.tree.get(season);
        if (have) return have.id;
        const id = await this.platform.createSeason(state.id, season);
        state.tree.set(season, { id, episodes: new Set() });
        return id;
      });
      if (state.tree.get(season)?.episodes.has(episode)) return skip("Already on the platform (created while this ran)");

      // the video goes to B2 while it downloads
      let videoUrl = url;
      let sizeBytes = sizeToBytes(detail.size);
      if (this.cfg.mode === "copy") {
        this.touch(item, { status: "downloading", reason: undefined });
        const key = `${randomUUID()}-${safeKeyPart(base)} S${season}E${episode} ${safeKeyPart(vjName)}.${ext || "mp4"}`;
        uploadedKey = key;
        const copied = await this.store.copy(url, key, (bytes, total) => this.touch(item, { bytes, total }), undefined, this.source.referer);
        videoUrl = b2ObjectUrl(this.cfg.b2, key.split("/").map(encodeURIComponent).join("/"));
        sizeBytes = copied.bytes;
      }

      // the episode, with the metadata TMDB has for it
      this.touch(item, { status: "saving" });
      const ep = state.tmdbId ? await this.platform.enrichEpisode(state.tmdbId, season, episode) : null;
      const lengthSeconds = Number(ep?.lengthSeconds) || durationToSeconds(detail.duration);
      const created = await this.platform.createEpisode(seasonId, {
        episodeNumber: episode,
        title: String(ep?.title || (given?.title && !/^(episode|ep\.?)\s*\d+$/i.test(given.title.trim()) ? given.title : "") || `Episode ${episode}`),
        description: String(ep?.description || given?.overview || ""),
        videoUrl,
        poster: String(ep?.poster || detail.image || ""),
        length: String(ep?.length || secondsToLength(lengthSeconds)),
        lengthSeconds,
        size: bytesToSize(sizeBytes),
        releaseDate: ep?.releaseDate ?? undefined,
      });
      uploadedKey = null; // the episode now owns the file
      state.tree.get(season)?.episodes.add(episode);
      ledger.imported[String(sourceId)] = { movieId: created.id, title: `${base} S${season} E${episode}`, at: new Date().toISOString() };
      delete ledger.failed[String(sourceId)];
      await this.writeLedger(ledger);
      this.touch(item, { status: "imported", movieId: created.id, reason: ep ? "Imported with TMDB metadata" : "Imported with the source's metadata" });
    } catch (e) {
      if (uploadedKey) await this.store.remove(uploadedKey).catch(() => undefined);
      if (e instanceof PlatformError && e.fatal) {
        this.stopRequested = true;
        this.message = `The import stopped: ${e.message}`;
      }
      if (e instanceof PlatformError && e.status === 409) return skip("Already on the platform (created while this ran)");
      await this.fail(item, ledger, sourceId, e instanceof Error ? e.message : String(e));
    }
  }

  /** Runs fn after every earlier change to this series has finished. */
  private exclusive<T>(state: SeriesState, fn: () => Promise<T>): Promise<T> {
    const run = state.lock.then(fn, fn);
    state.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  private async fail(item: ImportItem, ledger: Ledger, sourceId: string, reason: string): Promise<void> {
    if (this.dryRun) return void this.touch(item, { status: "failed", reason }); // a dry run leaves no trace in the ledger
    const attempts = (ledger.failed[String(sourceId)]?.attempts ?? 0) + 1;
    ledger.failed[String(sourceId)] = { attempts, reason, at: new Date().toISOString() };
    await this.writeLedger(ledger).catch(() => undefined);
    this.touch(item, { status: "failed", reason: attempts >= MAX_ATTEMPTS ? `${reason} (gave up after ${attempts} attempts)` : reason });
  }
}
