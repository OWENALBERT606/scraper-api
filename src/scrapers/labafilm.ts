const BASE    = "https://www.labafilm.com/api";
const API_KEY = "3c694c4b1337b149acb22bf4398705a70f5c92ec606da6ba744064123afbc04a";
const HEADERS = { "x-api-key": API_KEY, "Referer": "https://www.labafilm.com/", "Content-Type": "application/json" };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LabaMovie {
  _id: string; title: string; overview: string; poster: string;
  video: string; vj: string; release_date: string; genres: string[];
  director: string; country: string; company: string; rating: number;
}
export interface LabaMovieListItem {
  _id: string; title: string; vj: string; poster: string;
  release_date: string; rating?: number; year?: number;
}
export interface LabaSeries {
  _id: string; title: string; vj: string; poster: string;
  first_air_date: string; latestSeason: number; latestEpisode: number; year?: number;
}

// ── Simple in-memory cache (1-hour TTL) ───────────────────────────────────────
interface CacheEntry<T> { data: T; ts: number; }
const cache = new Map<string, CacheEntry<unknown>>();
const TTL = 60 * 60 * 1000; // 1 hour

function fromCache<T>(key: string): T | null {
  const e = cache.get(key) as CacheEntry<T> | undefined;
  if (e && Date.now() - e.ts < TTL) return e.data;
  return null;
}
function toCache<T>(key: string, data: T): T {
  cache.set(key, { data, ts: Date.now() });
  return data;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Labafilm API ${path} → ${res.status}`);
  const json = await res.json() as { success?: boolean; data?: T; error?: string };
  if ((json as any).error) throw new Error((json as any).error);
  return (json as any).data ?? json as T;
}

// ── Paginate all pages until hasMore = false ──────────────────────────────────
async function paginateAll<T>(
  pathFn: (page: number) => string,
  extract: (data: any) => { items: T[]; hasMore: boolean }
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  while (true) {
    const raw = await get<any>(pathFn(page));
    const { items, hasMore } = extract(raw);
    all.push(...items);
    if (!hasMore) break;
    page++;
  }
  return all;
}

// ── Public: single-page endpoints ────────────────────────────────────────────
export async function fetchLabaMovieDetail(id: string): Promise<LabaMovie> {
  return get<LabaMovie>(`/movies/${id}`);
}
export async function fetchLabaFeatured(): Promise<LabaMovieListItem[]> {
  return get<LabaMovieListItem[]>("/movies/featured");
}
export async function fetchLabaLatestMovies(): Promise<LabaMovieListItem[]> {
  return get<LabaMovieListItem[]>("/movies/latest");
}
export async function fetchLabaPopularMovies(): Promise<LabaMovieListItem[]> {
  return get<LabaMovieListItem[]>("/movies/popular");
}
export async function fetchLabaLatestSeries(): Promise<LabaSeries[]> {
  return get<LabaSeries[]>("/series/latest");
}
export async function fetchLabaPopularSeries(): Promise<LabaSeries[]> {
  return get<LabaSeries[]>("/series/popular");
}
export async function fetchLabaSimilar(id: string): Promise<LabaMovieListItem[]> {
  return get<LabaMovieListItem[]>(`/movies/${id}/similar`);
}

// ── Public: ALL movies (paginated, cached) ────────────────────────────────────
export async function fetchAllLabaMovies(): Promise<LabaMovieListItem[]> {
  const cached = fromCache<LabaMovieListItem[]>("all_movies");
  if (cached) return cached;

  const movies = await paginateAll<LabaMovieListItem>(
    (p) => `/movies/all?page=${p}`,
    (data) => ({ items: data.movies ?? [], hasMore: data.hasMore ?? false })
  );
  return toCache("all_movies", movies);
}

// ALL movies with full detail (video URL) — fetches details in parallel batches
export async function fetchAllLabaMoviesWithDetail(onProgress?: (done: number, total: number) => void): Promise<LabaMovie[]> {
  const cached = fromCache<LabaMovie[]>("all_movies_detail");
  if (cached) return cached;

  const list = await fetchAllLabaMovies();

  // Fetch details in batches of 10 to avoid flooding
  const BATCH = 10;
  const results: LabaMovie[] = [];
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const details = await Promise.all(
      batch.map((m) => fetchLabaMovieDetail(m._id).catch(() => ({
        ...m, video: "", overview: "", genres: [], director: "", country: "", company: "", rating: m.rating ?? 0,
      } as LabaMovie)))
    );
    results.push(...details);
    onProgress?.(results.length, list.length);
  }
  return toCache("all_movies_detail", results);
}

// ── Public: ALL series (paginated, cached) ────────────────────────────────────
export async function fetchAllLabaSeries(): Promise<LabaSeries[]> {
  const cached = fromCache<LabaSeries[]>("all_series");
  if (cached) return cached;

  const series = await paginateAll<LabaSeries>(
    (p) => `/series/all?page=${p}`,
    (data) => ({ items: data.series ?? [], hasMore: data.hasMore ?? false })
  );
  return toCache("all_series", series);
}

// Clear cache (useful for forced refresh)
export function clearLabaCache() { cache.clear(); }

