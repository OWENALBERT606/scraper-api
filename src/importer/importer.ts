import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { fetchDashboard, fetchMovieDetail, searchContent, FWMovieDetail } from "../scrapers/freewatch";
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
  sourceId: number;
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
  ids?: number[];
}

export interface ImportStatus {
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

const MAX_ATTEMPTS = 3;
const GENRE_BY_SECTION: Record<string, string> = {
  action: "Action",
  "sci fi": "Science Fiction",
  romance: "Romance",
  horror: "Horror",
  drama: "Drama",
  comedy: "Comedy",
  thriller: "Thriller",
  animation: "Animation",
  crime: "Crime",
  adventure: "Adventure",
  fantasy: "Fantasy",
  war: "War",
  documentary: "Documentary",
};

export class Importer {
  private cfg: ImportConfig;
  private missing: string[];
  private platform: Platform;
  private store: B2Store;
  private items = new Map<number, ImportItem>();
  private running = false;
  private stopRequested = false;
  private dryRun = false;
  private startedAt?: string;
  private finishedAt?: string;
  private message = "Idle";
  private timer: NodeJS.Timeout | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env, deps?: { platform?: Platform; store?: B2Store }) {
    const { config, missing } = loadImportConfig(env);
    this.cfg = config;
    this.missing = missing;
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
    return path.join(this.cfg.dataDir, "import-ledger.json");
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

  /** Ids of everything that could be a film: the home page plus a search over letters and digits. */
  private async discover(): Promise<{ ids: number[]; groupSize: Map<number, number> }> {
    const ids = new Set<number>();
    const groupSize = new Map<number, number>();
    try {
      for (const m of (await fetchDashboard()).movies) ids.add(Number(m.id));
    } catch (e) {
      this.message = `The home page could not be read (${e instanceof Error ? e.message : e}); using search only`;
    }
    const terms = [..."abcdefghijklmnopqrstuvwxyz0123456789", ...(process.env.IMPORT_SEARCH_TERMS ?? "").split(",").map((t) => t.trim()).filter(Boolean)];
    for (let i = 0; i < terms.length; i += 4) {
      const batch = terms.slice(i, i + 4);
      const results = await Promise.allSettled(batch.map((t) => searchContent(t)));
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        for (const m of r.value.movies ?? []) ids.add(Number(m.id));
        for (const s of r.value.series ?? []) {
          for (const ep of s.episodes ?? []) {
            ids.add(Number(ep.id));
            groupSize.set(Number(ep.id), Math.max(groupSize.get(Number(ep.id)) ?? 0, s.episodes.length));
          }
        }
      }
    }
    return { ids: [...ids].filter((n) => Number.isFinite(n) && n > 0), groupSize };
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
    this.message = "Looking at what the source has…";
    try {
      await this.platform.signIn(); // a wrong address or password stops the run here, before any film is touched
      const ledger = await this.readLedger();
      const found = opts.ids?.length ? { ids: opts.ids, groupSize: new Map<number, number>() } : await this.discover();
      const fresh = found.ids.filter((id) => !ledger.imported[String(id)] && (ledger.failed[String(id)]?.attempts ?? 0) < MAX_ATTEMPTS);
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

  /** category id -> genre name, from the source's own home-page sections (only the ones that are genres). */
  private async sectionGenres(): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    try {
      for (const s of (await fetchDashboard()).sections) {
        const g = GENRE_BY_SECTION[normalizeTitle(s.category)];
        if (g) map.set(s.id, g);
      }
    } catch {
      /* genres then come from the metadata match alone */
    }
    return map;
  }

  private async processOne(sourceId: number, groupSize: number, sections: Map<number, string>, ledger: Ledger): Promise<void> {
    const item: ImportItem = { sourceId, title: `#${sourceId}`, vj: "", status: "checking", bytes: 0, total: 0, updatedAt: new Date().toISOString() };
    this.items.set(sourceId, item);
    const skip = (reason: string) => this.touch(item, { status: "skipped", reason });
    let uploadedKey: string | null = null;

    try {
      const detail: FWMovieDetail = await fetchMovieDetail(sourceId);
      const { title, year } = cleanTitle(detail.title || "");
      this.touch(item, { title: title || item.title, vj: cleanVj(detail.vj) });

      // ── 1. is it a film we can copy? ────────────────────────────────────────────────────────────────────────────
      const url = detail.playingurl || "";
      if (!title) return skip("The source has no title for it");
      if (!url) return skip("The source has no video address");
      if (!looksLikeFilm(detail.title || "", groupSize)) return skip("It looks like a series episode, not a film");
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
      const hit = bestTmdbMatch(title, year, await this.platform.searchTmdb(title));
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
        const name = sections.get(Number(detail.category_id));
        if (name) genreId = (await this.platform.ensureGenre(name)).id;
      }
      if (!genreId) return this.fail(item, ledger, sourceId, "No genre could be decided (no metadata match and an unknown category)");
      let yearId = (meta?.yearId as string | null) || "";
      if (!yearId) {
        const y = year ?? (detail.timestamp ? new Date(detail.timestamp.replace(" ", "T") + "Z").getUTCFullYear() : new Date().getUTCFullYear());
        yearId = (await this.platform.ensureYear(y)).id;
      }

      // ── 5. the video goes to B2 while it downloads ─────────────────────────────────────────────────────────────
      let videoUrl = url;
      let sizeBytes = sizeToBytes(detail.size);
      if (this.cfg.mode === "copy") {
        this.touch(item, { status: "downloading", reason: undefined });
        const key = `${randomUUID()}-${safeKeyPart(officialTitle)} ${safeKeyPart(vjName)}.${ext || "mp4"}`;
        uploadedKey = key;
        const copied = await this.store.copy(url, key, (bytes, total) => this.touch(item, { bytes, total }));
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

  private async fail(item: ImportItem, ledger: Ledger, sourceId: number, reason: string): Promise<void> {
    if (this.dryRun) return void this.touch(item, { status: "failed", reason }); // a dry run leaves no trace in the ledger
    const attempts = (ledger.failed[String(sourceId)]?.attempts ?? 0) + 1;
    ledger.failed[String(sourceId)] = { attempts, reason, at: new Date().toISOString() };
    await this.writeLedger(ledger).catch(() => undefined);
    this.touch(item, { status: "failed", reason: attempts >= MAX_ATTEMPTS ? `${reason} (gave up after ${attempts} attempts)` : reason });
  }
}
