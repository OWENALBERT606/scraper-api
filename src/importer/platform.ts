import type { ImportConfig } from "./config";
import { cleanVj, normalizeTitle } from "./parse";

/** An answer from the MovieChamp256 API that was not a success. */
export class PlatformError extends Error {
  /** true when no film can succeed until it is fixed (for example the sign-in is refused), so the run should stop */
  fatal = false;
  constructor(public status: number, message: string) {
    super(message);
    this.name = "PlatformError";
  }
}

export interface NamedRow {
  id: string;
  name: string;
}
export interface YearRow {
  id: string;
  value: number;
}
export interface TitleCheck {
  /** the same title already exists under this VJ (or a VJ that is the same person) */
  duplicate: boolean;
  /** the same title exists under at least one VJ */
  existsAnyVj: boolean;
}

/**
 * Talks to the MovieChamp256 Go API as an administrator account: finds or creates VJs, genres and years, checks whether a
 * film already exists, asks for TMDB metadata, and creates the movie. It signs in again by itself when the token expires.
 */

/**
 * One sign-in is shared by every importer in the process (FreeWatch and MlegacyTV), and reused for a few minutes: the API
 * allows only a handful of sign-ins per 15 minutes, and each importer signing in at every run used them all up.
 */
interface Session {
  token: string;
  at: number;
  pending?: Promise<string>;
}
const SESSION_REUSE_MS = 10 * 60_000;
const sessions = new WeakMap<object, Map<string, Session>>();

export class Platform {
  private vjs: NamedRow[] | null = null;
  private genres: NamedRow[] | null = null;
  private years: YearRow[] | null = null;

  constructor(private cfg: ImportConfig, private fetchImpl: typeof fetch = fetch) {}

  private get session(): Session {
    let byKey = sessions.get(this.fetchImpl);
    if (!byKey) sessions.set(this.fetchImpl, (byKey = new Map()));
    const key = `${this.cfg.platformUrl}|${this.cfg.email}`;
    let s = byKey.get(key);
    if (!s) byKey.set(key, (s = { token: "", at: 0 }));
    return s;
  }

  private get token(): string {
    return this.session.token;
  }
  private set token(v: string) {
    this.session.token = v;
    if (!v) this.session.at = 0;
  }

  /** Signs in (or reuses a recent sign-in), so a wrong address or password is found before any film is looked at. */
  async signIn(): Promise<void> {
    const s = this.session;
    if (s.token && Date.now() - s.at < SESSION_REUSE_MS) return;
    await this.login();
  }

  /** Signs in; importers that ask at the same moment share one request. */
  private async login(): Promise<void> {
    const s = this.session;
    s.pending ??= this.loginRequest().finally(() => {
      s.pending = undefined;
    });
    await s.pending;
  }

  private async loginRequest(): Promise<string> {
    const res = await this.fetchImpl(`${this.cfg.platformUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ identifier: this.cfg.email, password: this.cfg.password }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { accessToken?: string }; error?: string };
    if (!res.ok || !json.data?.accessToken) {
      const hint = res.status === 404 ? " (HTTP 404: check PLATFORM_API_URL, the API only answers on http:// and the address must end in /api/v1)" : "";
      const err = new PlatformError(res.status, `${json.error || "Could not sign in to the platform with PLATFORM_EMAIL / PLATFORM_PASSWORD"}${hint}`);
      err.fatal = true;
      throw err;
    }
    this.session.token = json.data.accessToken;
    this.session.at = Date.now();
    return json.data.accessToken;
  }

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    if (!this.token) await this.login();
    const res = await this.fetchImpl(`${this.cfg.platformUrl}${path}`, {
      method,
      headers: { Accept: "application/json", Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message = String(json.error ?? json.message ?? `HTTP ${res.status}`);
    if (!res.ok && !retried && (res.status === 401 || (res.status === 403 && /token|session|unauthor|expired/i.test(message)))) {
      this.token = "";
      await this.login();
      return this.request<T>(method, path, body, true);
    }
    if (!res.ok) throw new PlatformError(res.status, message);
    return json as T;
  }

  // ── VJs, genres, years ────────────────────────────────────────────────────────────────────────────────────────

  private async loadVjs(): Promise<NamedRow[]> {
    this.vjs ??= (await this.request<{ data: NamedRow[] }>("GET", "/vjs")).data ?? [];
    return this.vjs;
  }

  /** The platform's VJ for a name from the source ("Vj Emmy" matches "VJ EMMY" and "EMMY"), or null. */
  async findVj(rawName: string): Promise<NamedRow | null> {
    const want = normalizeTitle(cleanVj(rawName));
    if (!want) return null;
    return (await this.loadVjs()).find((v) => normalizeTitle(cleanVj(v.name)) === want) ?? null;
  }

  async ensureVj(rawName: string): Promise<NamedRow> {
    const found = await this.findVj(rawName);
    if (found) return found;
    if (!this.cfg.createMissing) throw new Error(`VJ "${rawName}" does not exist on the platform (IMPORT_CREATE_MISSING is off)`);
    const name = `VJ ${cleanVj(rawName).toUpperCase()}`;
    try {
      const made = (await this.request<{ data: NamedRow }>("POST", "/vjs", { name })).data;
      (await this.loadVjs()).push(made);
      return made;
    } catch (e) {
      if (e instanceof PlatformError && e.status === 409) {
        this.vjs = null; // created a moment ago by someone else: read the list again
        const again = await this.findVj(rawName);
        if (again) return again;
      }
      throw e;
    }
  }

  private async loadGenres(): Promise<NamedRow[]> {
    this.genres ??= (await this.request<{ data: NamedRow[] }>("GET", "/genres")).data ?? [];
    return this.genres;
  }

  async findGenre(name: string): Promise<NamedRow | null> {
    const want = normalizeTitle(name);
    const aliases: Record<string, string> = {
      "sci fi": "science fiction",
      scifi: "science fiction",
      "action and adventure": "action",
      "action adventure": "action",
      kids: "family",
      biopic: "biography",
    };
    const target = aliases[want] ?? want;
    return (await this.loadGenres()).find((g) => normalizeTitle(g.name) === target) ?? null;
  }

  async ensureGenre(name: string): Promise<NamedRow> {
    const found = await this.findGenre(name);
    if (found) return found;
    if (!this.cfg.createMissing) throw new Error(`Genre "${name}" does not exist on the platform`);
    const made = (await this.request<{ data: NamedRow }>("POST", "/genres", { name })).data;
    (await this.loadGenres()).push(made);
    return made;
  }

  private async loadYears(): Promise<YearRow[]> {
    this.years ??= (await this.request<{ data: YearRow[] }>("GET", "/release-years")).data ?? [];
    return this.years;
  }

  async ensureYear(value: number): Promise<YearRow> {
    const found = (await this.loadYears()).find((y) => y.value === value);
    if (found) return found;
    if (!this.cfg.createMissing) throw new Error(`Release year ${value} does not exist on the platform`);
    const made = (await this.request<{ data: YearRow }>("POST", "/release-years", { value })).data;
    (await this.loadYears()).push(made);
    return made;
  }

  async yearById(id: string): Promise<number | null> {
    return (await this.loadYears()).find((y) => y.id === id)?.value ?? null;
  }

  // ── movies ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Does a film with this title already exist (under this VJ, or under any)? */
  async checkTitle(title: string, vjId?: string): Promise<TitleCheck> {
    const q = new URLSearchParams({ title });
    if (vjId) q.set("vjId", vjId);
    const r = await this.request<{ data?: unknown[]; duplicate?: unknown }>("GET", `/movies/check-title?${q}`);
    return { duplicate: !!r.duplicate, existsAnyVj: (r.data ?? []).length > 0 };
  }

  async searchTmdb(title: string): Promise<{ tmdbId: number | string | null; title: string; year: string | number | null; imdbId?: string | null }[]> {
    try {
      const r = await this.request<{ data?: { tmdbId: number | string | null; title: string; year: string | number | null; imdbId?: string | null }[] }>(
        "GET",
        `/metadata/search/movie?title=${encodeURIComponent(title)}`
      );
      return r.data ?? [];
    } catch {
      return []; // metadata is a bonus: the import goes on with what the source has
    }
  }

  async enrich(tmdbId: number | string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.request<{ data: Record<string, unknown> }>("GET", `/metadata/enrich/movie/${tmdbId}`)).data ?? null;
    } catch {
      return null;
    }
  }

  /** Metadata from OMDb (IMDb) by IMDb id, the route the single-movie upload uses. */
  async enrichImdb(imdbId: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.request<{ data: Record<string, unknown> }>("GET", `/metadata/enrich/movie/imdb/${imdbId}`)).data ?? null;
    } catch {
      return null;
    }
  }

  async createMovie(payload: Record<string, unknown>): Promise<{ id: string; slug?: string; title: string }> {
    return (await this.request<{ data: { id: string; slug?: string; title: string } }>("POST", "/movies", payload)).data;
  }

  // ── series, seasons, episodes ───────────────────────────────────────────────────────────────────────────────────

  /** The platform's series with this title (and VJ), or null. Compared by normalised title. */
  async findSeries(title: string, vjId?: string): Promise<{ id: string } | null> {
    const r = await this.request<{ data?: { id: string; title: string; vj?: { id?: string } | null }[] }>("GET", `/series?${new URLSearchParams({ search: title, limit: "100" })}`);
    const want = normalizeTitle(title);
    const hit = (r.data ?? []).find((s) => normalizeTitle(s.title) === want && (!vjId || s.vj?.id === vjId));
    return hit ? { id: hit.id } : null;
  }

  /** Every series on the platform (with its VJ), page by page. */
  async listSeries(): Promise<{ id: string; title: string; vjId: string; vjName: string }[]> {
    const out: { id: string; title: string; vjId: string; vjName: string }[] = [];
    for (let page = 1; page <= 100; page++) {
      const r = await this.request<{ data?: { id: string; title: string; vj?: { id?: string; name?: string } | null }[] }>("GET", `/series?${new URLSearchParams({ limit: "100", page: String(page) })}`);
      const rows = r.data ?? [];
      for (const s of rows) if (s.vj?.id) out.push({ id: s.id, title: s.title, vjId: s.vj.id, vjName: s.vj.name ?? "" });
      if (rows.length < 100) break;
    }
    return out;
  }

  /** season number -> { id, episode numbers already there } */
  async seriesTree(seriesId: string): Promise<Map<number, { id: string; episodes: Set<number> }>> {
    const out = new Map<number, { id: string; episodes: Set<number> }>();
    const seasons = (await this.request<{ data?: { id: string; seasonNumber: number }[] }>("GET", `/series/${seriesId}/seasons`)).data ?? [];
    for (const se of seasons) {
      const eps = (await this.request<{ data?: { episodeNumber: number }[] }>("GET", `/seasons/${se.id}/episodes`)).data ?? [];
      out.set(se.seasonNumber, { id: se.id, episodes: new Set(eps.map((e) => e.episodeNumber)) });
    }
    return out;
  }

  async searchTmdbSeries(title: string): Promise<{ tmdbId: number | string | null; title: string; year: string | number | null }[]> {
    try {
      return (await this.request<{ data?: { tmdbId: number | string | null; title: string; year: string | number | null }[] }>("GET", `/metadata/search/series?title=${encodeURIComponent(title)}`)).data ?? [];
    } catch {
      return [];
    }
  }

  async enrichSeries(tmdbId: number | string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.request<{ data: Record<string, unknown> }>("GET", `/metadata/enrich/series/${tmdbId}`)).data ?? null;
    } catch {
      return null;
    }
  }

  async enrichEpisode(tmdbSeriesId: number | string, season: number, episode: number): Promise<Record<string, unknown> | null> {
    try {
      return (await this.request<{ data: Record<string, unknown> }>("GET", `/metadata/episode/${tmdbSeriesId}/${season}/${episode}`)).data ?? null;
    } catch {
      return null;
    }
  }

  async createSeries(payload: Record<string, unknown>): Promise<{ id: string; title: string }> {
    return (await this.request<{ data: { id: string; title: string } }>("POST", "/series", payload)).data;
  }

  /** Adds an empty season and returns its id. */
  async createSeason(seriesId: string, seasonNumber: number, extra: Record<string, unknown> = {}): Promise<string> {
    await this.request("POST", `/series/${seriesId}/seasons`, { seasons: [{ seasonNumber, title: `Season ${seasonNumber}`, ...extra, episodes: [] }] });
    const tree = await this.seriesTree(seriesId);
    const id = tree.get(seasonNumber)?.id;
    if (!id) throw new Error(`Season ${seasonNumber} could not be created`);
    return id;
  }

  async createEpisode(seasonId: string, payload: Record<string, unknown>): Promise<{ id: string }> {
    return (await this.request<{ data: { id: string } }>("POST", `/seasons/${seasonId}/episodes`, payload)).data;
  }
}
