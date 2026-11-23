function env(name: string): string {
  return (process.env[name] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
}

const SUPABASE_URL = env("MLEGACYTV_SUPABASE_URL");
const SUPABASE_KEY = env("MLEGACYTV_SUPABASE_KEY");
const REST_URL = `${SUPABASE_URL}/rest/v1`;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn(
    "[mlegacytv] MLEGACYTV_SUPABASE_URL / MLEGACYTV_SUPABASE_KEY are not set — MlegacyTV endpoints will fail"
  );
}

const HEADERS: Record<string, string> = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  Accept: "application/json",
  Prefer: "count=exact",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
};

const ACCOUNT_EMAIL = env("MLEGACYTV_EMAIL");
const ACCOUNT_PASSWORD = env("MLEGACYTV_PASSWORD");
const PLAYBACK_API = "https://mlegacytv.com/api/playback-url";

interface Session {
  token: string;
  expiresAt: number;
  pending?: Promise<string>;
}
const session: Session = { token: "", expiresAt: 0 };
const playbackCache = new Map<string, string>();
const playbackPending = new Map<string, Promise<string>>();

/** The catalogue's video_link values are stale; the site resolves them with a signed-in call to its playback API. */
export function playbackCredentialsMissing(): string[] {
  return [
    ["MLEGACYTV_EMAIL", ACCOUNT_EMAIL],
    ["MLEGACYTV_PASSWORD", ACCOUNT_PASSWORD],
  ]
    .filter(([, value]) => !value.trim())
    .map(([name]) => name);
}

async function accessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (session.token && Date.now() < session.expiresAt) return session.token;
  if (session.pending) return session.pending;
  const missing = playbackCredentialsMissing();
  if (missing.length) throw new Error(`MLEGACYTV_EMAIL / MLEGACYTV_PASSWORD are not set — cannot resolve MlegacyTV video links`);

  session.pending = (async () => {
    const res = await fetchImpl(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
      body: JSON.stringify({ email: ACCOUNT_EMAIL, password: ACCOUNT_PASSWORD }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; msg?: string };
    if (!res.ok || !json.access_token) {
      const email = ACCOUNT_EMAIL || "(not set)";
      throw new Error(`MlegacyTV sign-in failed (${res.status}): ${json.msg ?? "invalid credentials"} — check MLEGACYTV_EMAIL (${email}) / MLEGACYTV_PASSWORD`);
    }
    session.token = json.access_token;
    session.expiresAt = Date.now() + Math.max(60, (Number(json.expires_in) || 3600) - 60) * 1000;
    return session.token;
  })().finally(() => {
    session.pending = undefined;
  });
  return session.pending;
}

/** Turns a stale catalogue video_link into the current playable address from mlegacytv.com. */
export async function resolvePlaybackUrl(url: string | null | undefined, fetchImpl: typeof fetch = fetch): Promise<string> {
  const original = String(url ?? "").trim();
  if (!original) return "";
  const cached = playbackCache.get(original);
  if (cached) return cached;
  const pending = playbackPending.get(original);
  if (pending) return pending;

  const task = (async () => {
    const token = await accessToken(fetchImpl);
    const res = await fetchImpl(PLAYBACK_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: original }),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !json.url) throw new Error(`MlegacyTV playback resolver failed (${res.status}): ${json.error ?? "no playable URL returned"}`);
    playbackCache.set(original, json.url);
    return json.url;
  })().finally(() => {
    playbackPending.delete(original);
  });
  playbackPending.set(original, task);
  return task;
}

export interface MLTVVj {
  id: string;
  name: string;
}

export interface MLTVGenre {
  id: number;
  name: string;
}

export interface MLTVMovie {
  id: string;
  title: string;
  image: string;
  cover: string;
  playingurl: string;
  vj: string;
  vj_name: string;
  category: string;
  category_id: string;
  duration: string;
  year: number | null;
  rating: number | null;
  overview: string;
  genre: string[];
  genres: MLTVGenre[];
  premium: boolean;
  published: boolean;
  type: string;
  trailer: string;
  views: number;
  tmdb_id: string;
  created_at: string;
  is_series: false;
}

export interface MLTVSeries {
  id: string;
  title: string;
  image: string;
  cover: string;
  playingurl: string;
  vj: string;
  vj_name: string;
  category: string;
  category_id: string;
  overview: string;
  genre: string[];
  genres: MLTVGenre[];
  rating: number | null;
  release_date: string | null;
  premium: boolean;
  published: boolean;
  type: string;
  trailer: string;
  views: number;
  tmdb_id: string;
  created_at: string;
  is_series: true;
}

export interface MLTVEpisode {
  id: number;
  title: string;
  image: string;
  playingurl: string;
  season_id: number;
  season_number: number | null;
  order: number | null;
  runtime: string;
  air_date: string | null;
  overview: string;
  premium: boolean;
  published: boolean;
}

export interface MLTVSeason {
  id: number;
  title: string;
  order: number | null;
  episode_count: number;
  published: boolean;
  episodes: MLTVEpisode[];
}

export interface MLTVSeriesDetail extends MLTVSeries {
  seasons: MLTVSeason[];
  total_episodes: number;
}

export interface MLTVSection {
  id: string;
  category: string;
  count: number;
  items: Array<MLTVMovie | MLTVSeries>;
}

export interface MLTVDashboard {
  sections: MLTVSection[];
  unique_movies: number;
  unique_series: number;
  movies: MLTVMovie[];
  series: MLTVSeries[];
  vjs: MLTVVj[];
}

export interface MLTVCatalog {
  total: number;
  movies_total: number;
  series_total: number;
  movies: MLTVMovie[];
  series: MLTVSeries[];
}

export interface MLTVSearchResult {
  query: string;
  total: number;
  movies: MLTVMovie[];
  series: MLTVSeries[];
}

type Row = Record<string, unknown>;

const str = (v: unknown): string =>
  typeof v === "string" ? v : v == null ? "" : String(v);

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const nullableNum = (v: unknown): number | null => {
  if (v == null || v === "" || v === "NULL") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function parseGenres(raw: unknown): MLTVGenre[] {
  const list = Array.isArray(raw) ? raw : [];
  const genres: MLTVGenre[] = [];
  for (const item of list) {
    if (typeof item === "object" && item !== null) {
      const g = item as Record<string, unknown>;
      genres.push({ id: num(g.id), name: str(g.name) });
      continue;
    }
    try {
      const g = JSON.parse(String(item)) as Record<string, unknown>;
      genres.push({ id: num(g.id), name: str(g.name) });
    } catch {
      if (str(item)) genres.push({ id: 0, name: str(item) });
    }
  }
  return genres;
}

function vjName(raw: unknown): string {
  if (Array.isArray(raw)) {
    const first = raw[0] as Record<string, unknown> | undefined;
    return str(first?.name);
  }
  if (raw && typeof raw === "object") {
    return str((raw as Record<string, unknown>).name);
  }
  return "";
}

function normalizeMovie(row: Row): MLTVMovie {
  const genres = parseGenres(row.genre);
  return {
    id: str(row.id),
    title: str(row.title),
    image: str(row.thumbnail_medium) || str(row.cover),
    cover: str(row.cover) || str(row.thumbnail_medium),
    playingurl: str(row.video_link),
    vj: str(row.vj),
    vj_name: vjName(row.vjs),
    category: str(row.category),
    category_id: str(row.category),
    duration: str(row.duration),
    year: nullableNum(row.year),
    rating: nullableNum(row.rating),
    overview: str(row.overview),
    genre: genres.map((g) => g.name),
    genres,
    premium: row.premium === true,
    published: row.published === true,
    type: str(row.type) || "Movie",
    trailer: str(row.trailer),
    views: num(row.views),
    tmdb_id: str(row.tmdb_id),
    created_at: str(row.created_at),
    is_series: false,
  };
}

function normalizeSeries(row: Row): MLTVSeries {
  const genres = parseGenres(row.genre);
  return {
    id: str(row.id),
    title: str(row.title),
    image: str(row.thumbnail_medium) || str(row.cover),
    cover: str(row.cover) || str(row.thumbnail_medium),
    playingurl: str(row.video_link),
    vj: str(row.vj),
    vj_name: vjName(row.vjs),
    category: str(row.category),
    category_id: str(row.category),
    overview: str(row.overview),
    genre: genres.map((g) => g.name),
    genres,
    rating: nullableNum(row.rating),
    release_date: row.release_date ? str(row.release_date) : null,
    premium: row.premium === true,
    published: row.published === true,
    type: str(row.type) || "Serie",
    trailer: str(row.trailer),
    views: num(row.views),
    tmdb_id: str(row.tmdb_id),
    created_at: str(row.created_at),
    is_series: true,
  };
}

function normalizeEpisode(row: Row): MLTVEpisode {
  return {
    id: num(row.id),
    title: str(row.title) || str(row.name),
    image: str(row.thumbnail_medium),
    playingurl: str(row.video_link),
    season_id: num(row.season_id),
    season_number: nullableNum(row.season_number),
    order: nullableNum(row.order),
    runtime: str(row.runtime),
    air_date: row.air_date ? str(row.air_date) : null,
    overview: str(row.overview),
    premium: row.premium === true,
    published: row.published === true,
  };
}

interface RestResponse<T> {
  data: T;
  total: number;
}

async function rest<T>(
  table: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<RestResponse<T>> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("MLEGACYTV_SUPABASE_URL and MLEGACYTV_SUPABASE_KEY must be configured");
  }
  const url = new URL(`${REST_URL}/${table}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: HEADERS,
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        throw new Error(`MlegacyTV API ${table} → ${res.status}: ${await res.text()}`);
      }
      const range = res.headers.get("content-range") ?? "";
      const total = Number(range.split("/")[1] ?? 0) || 0;
      return { data: (await res.json()) as T, total };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError!;
}

async function restAll(
  table: string,
  params: Record<string, string | number | boolean | undefined> = {},
  max = 5000
): Promise<Row[]> {
  const rows: Row[] = [];
  const limit = 1000;
  while (rows.length < max) {
    const { data } = await rest<Row[]>(table, {
      ...params,
      limit: Math.min(limit, max - rows.length),
      offset: rows.length,
    });
    rows.push(...data);
    if (data.length < limit) break;
  }
  return rows;
}

const DETAILS_SELECT =
  "*,vjs ( id, name )";

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const TTL = 60 * 60 * 1000;

function fromCache<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  return entry && Date.now() - entry.ts < TTL ? entry.data : null;
}

function toCache<T>(key: string, data: T): T {
  cache.set(key, { data, ts: Date.now() });
  return data;
}

export function clearMlegacytvCache(): void {
  cache.clear();
}

export async function fetchDashboard(): Promise<MLTVDashboard> {
  const cached = fromCache<MLTVDashboard>("dashboard");
  if (cached) return cached;

  const [recent, trending, popular, recommended, series, vjs, count] = await Promise.all([
    rest<Row[]>("movies", {
      select: DETAILS_SELECT,
      published: "eq.true",
      order: "created_at.desc",
      limit: 30,
    }),
    rest<Row[]>("movies", {
      select: DETAILS_SELECT,
      published: "eq.true",
      trending: "eq.true",
      order: "views.desc",
      limit: 15,
    }),
    rest<Row[]>("movies", {
      select: DETAILS_SELECT,
      published: "eq.true",
      popular: "eq.true",
      order: "views.desc",
      limit: 15,
    }),
    rest<Row[]>("movies", {
      select: DETAILS_SELECT,
      published: "eq.true",
      recommend: "eq.true",
      order: "views.desc",
      limit: 15,
    }),
    rest<Row[]>("series", {
      select: DETAILS_SELECT,
      published: "eq.true",
      order: "created_at.desc",
      limit: 20,
    }),
    rest<Row[]>("vjs", { select: "id,name", order: "name.asc", limit: 100 }),
    rest<Row[]>("movies", { select: "id", published: "eq.true", limit: 1 }),
  ]);

  const movies = recent.data.map(normalizeMovie);
  const seriesItems = series.data.map(normalizeSeries);
  const byId = new Map<string, MLTVMovie>(movies.map((m) => [m.id, m]));
  for (const list of [trending.data, popular.data, recommended.data]) {
    for (const row of list) {
      const movie = normalizeMovie(row);
      if (!byId.has(movie.id)) {
        byId.set(movie.id, movie);
        movies.push(movie);
      }
    }
  }

  const makeSection = (
    id: string,
    category: string,
    rows: Row[],
    map: (row: Row) => MLTVMovie | MLTVSeries
  ): MLTVSection => ({
    id,
    category,
    count: rows.length,
    items: rows.map(map),
  });

  const sections: MLTVSection[] = [
    makeSection("latest", "Latest on MlegacyTV", recent.data, normalizeMovie),
    makeSection("trending", "Trending", trending.data, normalizeMovie),
    makeSection("popular", "Popular", popular.data, normalizeMovie),
    makeSection("recommended", "Recommended", recommended.data, normalizeMovie),
    makeSection("series", "Latest Series", series.data, normalizeSeries),
  ].filter((section) => section.count > 0);

  return toCache("dashboard", {
    sections,
    unique_movies: count.total || movies.length,
    unique_series: series.total,
    movies,
    series: seriesItems,
    vjs: vjs.data.map((v) => ({ id: str(v.id), name: str(v.name) })),
  });
}

export interface CatalogOptions {
  type?: "all" | "movies" | "series";
  limit?: number | string;
  offset?: number | string;
}

export async function fetchCatalog(options: CatalogOptions = {}): Promise<MLTVCatalog> {
  const type = options.type ?? "all";
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 1000);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const key = `catalog:${type}:${limit}:${offset}`;
  const cached = fromCache<MLTVCatalog>(key);
  if (cached) return cached;

  const common = {
    select: DETAILS_SELECT,
    published: "eq.true" as const,
    order: "created_at.desc,id.desc",
    limit,
    offset,
  };

  const [movieRes, seriesRes] = await Promise.all([
    type === "series"
      ? Promise.resolve({ data: [] as Row[], total: 0 })
      : rest<Row[]>("movies", common),
    type === "movies"
      ? Promise.resolve({ data: [] as Row[], total: 0 })
      : rest<Row[]>("series", common),
  ]);

  return toCache(key, {
    total: movieRes.total + seriesRes.total,
    movies_total: movieRes.total,
    series_total: seriesRes.total,
    movies: movieRes.data.map(normalizeMovie),
    series: seriesRes.data.map(normalizeSeries),
  });
}

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function fetchMovie(id: string | number): Promise<MLTVMovie | null> {
  if (!isUuid(String(id))) return null;
  const { data } = await rest<Row[]>("movies", {
    select: DETAILS_SELECT,
    id: `eq.${id}`,
    limit: 1,
  });
  return data[0] ? normalizeMovie(data[0]) : null;
}

export async function fetchEpisode(id: number | string): Promise<MLTVEpisode | null> {
  if (!/^\d+$/.test(String(id))) return null;
  const { data } = await rest<Row[]>("episodes", {
    select: "*",
    id: `eq.${id}`,
    limit: 1,
  });
  return data[0] ? normalizeEpisode(data[0]) : null;
}

export async function fetchSeries(id: string | number): Promise<MLTVSeriesDetail | null> {
  if (!isUuid(String(id))) return null;
  const key = `series:${id}`;
  const cached = fromCache<MLTVSeriesDetail>(key);
  if (cached) return cached;

  const { data } = await rest<Row[]>("series", {
    select: DETAILS_SELECT,
    id: `eq.${id}`,
    limit: 1,
  });
  const row = data[0];
  if (!row) return null;

  const seasonRows = await restAll("seasons", {
    select: "*",
    serie_id: `eq.${id}`,
    order: "order.asc",
  });

  const seasonIds = seasonRows.map((s) => num(s.id));
  let episodeRows: Row[] = [];
  if (seasonIds.length > 0) {
    episodeRows = await restAll("episodes", {
      select: "*",
      season_id: `in.(${seasonIds.join(",")})`,
      order: "season_id.asc,order.asc",
    });
  }

  const grouped = new Map<number, MLTVEpisode[]>();
  for (const row of episodeRows) {
    const ep = normalizeEpisode(row);
    const list = grouped.get(ep.season_id) ?? [];
    list.push(ep);
    grouped.set(ep.season_id, list);
  }

  const seasons: MLTVSeason[] = seasonRows.map((s) => {
    const seasonId = num(s.id);
    const episodes = grouped.get(seasonId) ?? [];
    return {
      id: seasonId,
      title: str(s.title) || str(s.name),
      order: nullableNum(s.order),
      episode_count: episodes.length || num(s.episode_count),
      published: s.published === true,
      episodes,
    };
  });

  return toCache(key, {
    ...normalizeSeries(row),
    seasons,
    total_episodes: seasons.reduce((sum, s) => sum + s.episodes.length, 0),
  });
}

function sanitizeQuery(query: string): string {
  return query.replace(/[,()%\\]/g, " ").trim();
}

export async function searchContent(query: string): Promise<MLTVSearchResult> {
  const q = sanitizeQuery(query);
  if (!q) return { query, total: 0, movies: [], series: [] };

  const key = `search:${q.toLowerCase()}`;
  const cached = fromCache<MLTVSearchResult>(key);
  if (cached) return cached;

  const filter = `(title.ilike.%${q}%,overview.ilike.%${q}%)`;
  const params = {
    select: DETAILS_SELECT,
    published: "eq.true",
    or: filter,
    order: "created_at.desc",
    limit: 50,
  };

  const [movieRes, seriesRes] = await Promise.all([
    rest<Row[]>("movies", params).catch(() => ({ data: [] as Row[], total: 0 })),
    rest<Row[]>("series", params).catch(() => ({ data: [] as Row[], total: 0 })),
  ]);

  return toCache(key, {
    query,
    total: movieRes.total + seriesRes.total,
    movies: movieRes.data.map(normalizeMovie),
    series: seriesRes.data.map(normalizeSeries),
  });
}
