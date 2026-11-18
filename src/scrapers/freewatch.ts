/**
 * FreeWatch UG  —  https://www.freewatchug.online/
 *
 * Reverse-engineered from the production JS bundle.
 * Primary API: https://mumowatch.ai.studio  (requires Referer header)
 * Fallback API: https://pearlpix-api.onrender.com
 */

const PRIMARY = "https://mumowatch.ai.studio";
const FALLBACK = "https://pearlpix-api.onrender.com";

// The API enforces a Referer check on some endpoints (e.g. search)
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
  Referer: "https://www.freewatchug.online/",
  Origin: "https://www.freewatchug.online",
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FWMovieListItem {
  id: number;
  vid: number;
  title: string;
  image: string;
  vj: string;
  paid: boolean;
  subscriber: boolean;
  category_id: number;
  ldur: string;
  state: string;
  playingurl: string;
}

export interface FWSection {
  id: number;
  category: string;
  count: number;
}

export interface FWDashboard {
  sections: FWSection[];
  unique_movies: number;
  movies: FWMovieListItem[];
  banner?: FWMovieListItem;
}

export interface FWMovieDetail {
  id: number;
  title: string;
  image: string;
  vj: string;
  paid: string;
  subscriber: string;
  size: string;
  duration: string;
  description: string;
  playingurl: string;
  series_code: string;
  category_id: string;
  type: string;
  is_series: boolean;
  timestamp: string;
  state: string;
  ldur: string;
}

export interface FWEpisode {
  id: number;
  title: string;
  series_code: string;
  type: string;
  category_id: string;
  image: string;
  size: string;
  vj: string;
  playingurl: string;
}

export interface FWSeries {
  series_code: string;
  base_name: string;
  count: number;
  episodes: FWEpisode[];
}

export interface FWSearchResult {
  query: string;
  total: number;
  movies: FWMovieDetail[];
  series: Array<{
    series_code: string;
    title: string;
    episodes: FWEpisode[];
  }>;
}

// ── HTTP helper with primary → fallback ──────────────────────────────────────

async function get<T>(path: string): Promise<T> {
  let lastError: Error | null = null;

  for (const base of [PRIMARY, FALLBACK]) {
    try {
      const res = await fetch(`${base}${path}`, { headers: HEADERS });
      if (!res.ok) throw new Error(`FreeWatch API ${path} → ${res.status} (${base})`);
      return (await res.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError!;
}

// ── Simple 1-hour in-memory cache ────────────────────────────────────────────

interface CacheEntry<T> { data: T; ts: number }
const cache = new Map<string, CacheEntry<unknown>>();
const TTL = 60 * 60 * 1000;

function fromCache<T>(key: string): T | null {
  const e = cache.get(key) as CacheEntry<T> | undefined;
  return e && Date.now() - e.ts < TTL ? e.data : null;
}
function toCache<T>(key: string, data: T): T {
  cache.set(key, { data, ts: Date.now() });
  return data;
}

export function clearFreeWatchCache() { cache.clear(); }

// ── Public API ────────────────────────────────────────────────────────────────

/** Home dashboard — list of movies grouped into sections (titles/meta empty) */
export async function fetchDashboard(): Promise<FWDashboard> {
  const cached = fromCache<FWDashboard>("dashboard");
  if (cached) return cached;
  const data = await get<FWDashboard>("/dashboard");
  return toCache("dashboard", data);
}

/**
 * Dashboard + full detail for every movie (title, vj, description, stream URL).
 * Fetches details in parallel batches of 10. Results are cached for 1 hour.
 */
export async function fetchDashboardWithDetails(
  onProgress?: (done: number, total: number) => void
): Promise<FWDashboard> {
  const cached = fromCache<FWDashboard>("dashboard_detail");
  if (cached) return cached;

  const dashboard = await fetchDashboard();
  const ids = dashboard.movies.map((m) => m.id);
  const total = ids.length;

  const BATCH = 10;
  const detailMap = new Map<number, FWMovieDetail>();

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((id) => fetchMovieDetail(id))
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        detailMap.set(Number(r.value.id), r.value);
      }
    }
    onProgress?.(detailMap.size, total);
  }

  // Retry any that failed once more (rate-limit or fluke)
  const missing = ids.filter((id) => !detailMap.has(Number(id)));
  if (missing.length > 0) {
    const retries = await Promise.allSettled(
      missing.map((id) => fetchMovieDetail(id))
    );
    for (const r of retries) {
      if (r.status === "fulfilled") {
        detailMap.set(Number(r.value.id), r.value);
      }
    }
  }

  // Merge detail onto dashboard list items — keep item even if detail missing
  const merged = dashboard.movies.map((m) => {
    const d = detailMap.get(Number(m.id));
    if (!d) return m;
    return {
      ...m,
      title:      d.title      || m.title,
      vj:         d.vj         || m.vj,
      playingurl: d.playingurl || m.playingurl,
      is_series:  d.is_series  ?? false,
    } as FWMovieListItem;
  });

  const result: FWDashboard = { ...dashboard, movies: merged };
  return toCache("dashboard_detail", result);
}

/** Full movie detail including playingurl (direct MP4 / HLS) */
export async function fetchMovieDetail(id: number | string): Promise<FWMovieDetail> {
  return get<FWMovieDetail>(`/movie/${id}`);
}

/** Series episodes by series_code — searches by title to find all related episodes */
export async function fetchSeries(seriesCode: number | string): Promise<FWSeries> {
  // First get the base movie to know the title
  const base = await fetchMovieDetail(seriesCode);
  if (!base.title) return { series_code: String(seriesCode), base_name: "", count: 0, episodes: [] };

  // Extract clean title (strip episode/season suffixes)
  const cleanTitle = base.title
    .replace(/\s*(Season|Episode|Eps?|S\d+E\d+)[^]*/i, "")
    .replace(/:\s*$/, "")
    .trim();

  // Search for all episodes with this title
  const result = await get<FWSearchResult>(`/search?q=${encodeURIComponent(cleanTitle)}`);

  // Collect all episodes across matching series entries
  const seen = new Map<number, FWEpisode>();
  for (const s of result.series ?? []) {
    for (const ep of s.episodes ?? []) {
      if (!seen.has(ep.id)) seen.set(ep.id, ep);
    }
  }

  const episodes = Array.from(seen.values()).sort((a, b) => a.id - b.id);
  return { series_code: String(seriesCode), base_name: cleanTitle, count: episodes.length, episodes };
}

/**
 * Build a full catalog by searching every letter a-z.
 * Returns all unique movies + series episodes found (deduplicated by id).
 * Cached for 1 hour.
 */
export async function fetchFullCatalog(
  onProgress?: (done: number, total: number) => void
): Promise<FWMovieListItem[]> {
  const cached = fromCache<FWMovieListItem[]>("full_catalog");
  if (cached) return cached;

  const terms = "abcdefghijklmnopqrstuvwxyz".split("");
  const seen = new Map<number, FWMovieListItem>();
  let done = 0;

  for (const q of terms) {
    try {
      const result = await get<FWSearchResult>(`/search?q=${encodeURIComponent(q)}`);

      // Flatten series episodes into list items
      for (const s of result.series ?? []) {
        for (const ep of s.episodes ?? []) {
          if (!seen.has(ep.id)) {
            seen.set(ep.id, {
              id: ep.id,
              vid: ep.id,
              title: s.title || ep.title,
              image: ep.image,
              vj: ep.vj,
              paid: false,
              subscriber: false,
              category_id: Number(ep.category_id),
              ldur: "",
              state: "",
              playingurl: ep.playingurl,
              is_series: true,
            } as FWMovieListItem);
          }
        }
      }

      // Direct movies
      for (const m of result.movies ?? []) {
        if (!seen.has(m.id)) {
          seen.set(m.id, {
            id: m.id,
            vid: m.id,
            title: m.title,
            image: m.image,
            vj: m.vj,
            paid: m.paid === "yes",
            subscriber: m.subscriber === "yes",
            category_id: Number(m.category_id),
            ldur: m.ldur,
            state: m.state,
            playingurl: m.playingurl,
            is_series: m.is_series ?? false,
          } as FWMovieListItem);
        }
      }
    } catch { /* skip failed letter */ }

    done++;
    onProgress?.(done, terms.length);
  }

  const catalog = Array.from(seen.values());
  return toCache("full_catalog", catalog);
}

/** Full-text search across movies and series */
export async function searchContent(query: string): Promise<FWSearchResult> {
  return get<FWSearchResult>(`/search?q=${encodeURIComponent(query)}`);
}
