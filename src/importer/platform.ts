import type { ImportConfig } from "./config";
import { cleanVj, normalizeTitle } from "./parse";

/** An answer from the MovieChamp256 API that was not a success. */
export class PlatformError extends Error {
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
export class Platform {
  private token = "";
  private vjs: NamedRow[] | null = null;
  private genres: NamedRow[] | null = null;
  private years: YearRow[] | null = null;

  constructor(private cfg: ImportConfig, private fetchImpl: typeof fetch = fetch) {}

  private async login(): Promise<void> {
    const res = await this.fetchImpl(`${this.cfg.platformUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ identifier: this.cfg.email, password: this.cfg.password }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { accessToken?: string }; error?: string };
    if (!res.ok || !json.data?.accessToken) {
      throw new PlatformError(res.status, json.error || "Could not sign in to the platform with PLATFORM_EMAIL / PLATFORM_PASSWORD");
    }
    this.token = json.data.accessToken;
  }

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    if (!this.token) await this.login();
    const res = await this.fetchImpl(`${this.cfg.platformUrl}${path}`, {
      method,
      headers: { Accept: "application/json", Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401 && !retried) {
      this.token = "";
      return this.request<T>(method, path, body, true);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new PlatformError(res.status, String(json.error ?? json.message ?? `HTTP ${res.status}`));
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
    const aliases: Record<string, string> = { "sci fi": "science fiction", scifi: "science fiction", "action and adventure": "action" };
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

  async searchTmdb(title: string): Promise<{ tmdbId: number | string | null; title: string; year: string | number | null }[]> {
    try {
      const r = await this.request<{ data?: { tmdbId: number | string | null; title: string; year: string | number | null }[] }>(
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

  async createMovie(payload: Record<string, unknown>): Promise<{ id: string; slug?: string; title: string }> {
    return (await this.request<{ data: { id: string; slug?: string; title: string } }>("POST", "/movies", payload)).data;
  }
}
