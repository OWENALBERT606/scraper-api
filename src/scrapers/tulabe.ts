const BASE = "https://tulabe-api.lectify.education/api";

// cdn.tulabe.com DNS doesn't resolve publicly — images live on Backblaze
function fixImageUrl(url: string): string {
  return url.replace("cdn.tulabe.com", "f006.backblazeb2.com");
}

function fixMovie<T extends { thumbnail_url?: string }>(m: T): T {
  if (m.thumbnail_url) m.thumbnail_url = fixImageUrl(m.thumbnail_url);
  return m;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VideoQuality {
  id: string;
  quality: string;
  playlist_url: string;
  status: string;
}

export interface Movie {
  id: string;
  title: string;
  description: string;
  status: string;
  thumbnail_url: string;
  release_year: number;
  genre_names: string;
  vj_names: string;
  view_count: number;
  duration_seconds: number;
  allow_1080p: boolean;
  language_translated: string;
  is_latest: boolean;
  qualities: VideoQuality[];
  created_at: string;
}

export interface Series {
  id: number;
  title: string;
  description: string;
  thumbnail_url: string;
  release_year: number;
  genre_names: string;
  vj_names: string;
  view_count: number;
  status: string;
  total_seasons: number;
  created_at: string;
}

export interface Episode {
  id: number;
  episode_number: number;
  part_number: number;
  season_number: number;
  title: string;
  description: string;
  thumbnail_url: string;
  video_url: string;       // HLS .m3u8
  duration_seconds: number;
  status: string;
}

export interface Season {
  season: number;
  episodes: Episode[];
}

export interface SeriesDetail extends Series {
  seasons: Season[];
}

export interface Genre {
  id: number;
  name: string;
  slug: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Tulabe API ${path} → ${res.status}`);
  return res.json();
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function fetchMovies(opts: {
  page?: number;
  limit?: number;
  genre_id?: number;
  latest?: boolean;
} = {}): Promise<{ movies: Movie[]; pagination: Pagination }> {
  const { page = 1, limit = 20, genre_id, latest } = opts;

  let qs = `?page=${page}&limit=${limit}`;
  if (genre_id) qs += `&genre_id=${genre_id}`;
  if (latest) qs += `&latest=true`;

  const res = await get<{ data: { movies: Movie[]; pagination: Pagination } }>(`/movies${qs}`);
  res.data.movies = res.data.movies.map(fixMovie);
  return res.data;
}

export async function fetchMovieDetail(id: string): Promise<Movie> {
  const res = await get<{ data: { movie: Movie } }>(`/movies/${id}`);
  return fixMovie(res.data.movie);
}

export async function fetchSeries(opts: {
  page?: number;
  limit?: number;
} = {}): Promise<{ series: Series[]; pagination: Pagination }> {
  const { page = 1, limit = 20 } = opts;
  const res = await get<{ data: { series: Series[]; pagination: Pagination } }>(`/series?page=${page}&limit=${limit}`);
  res.data.series = res.data.series.map((s) => fixMovie(s as any) as unknown as Series);
  return res.data;
}

export async function fetchSeriesDetail(id: number): Promise<SeriesDetail> {
  // GET /series/:id returns { data: { seasons: [...] } }
  const seasons = await get<{ data: { seasons: Season[] } }>(`/series/${id}`);
  const list = await fetchSeries({ limit: 100 });
  const meta = list.series.find((s) => s.id === id);

  // Fix episode thumbnail URLs
  const fixedSeasons = seasons.data.seasons.map((season) => ({
    ...season,
    episodes: season.episodes.map((ep) => ({
      ...ep,
      thumbnail_url: fixImageUrl(ep.thumbnail_url),
    })),
  }));

  return { ...(meta ?? ({} as Series)), seasons: fixedSeasons };
}

// Fetch all series across all pages
export async function fetchAllSeries(): Promise<Series[]> {
  const first = await fetchSeries({ page: 1, limit: 20 });
  const { total_pages } = first.pagination;
  if (total_pages <= 1) return first.series;

  const rest = await Promise.all(
    Array.from({ length: total_pages - 1 }, (_, i) => fetchSeries({ page: i + 2, limit: 20 }))
  );
  return [first.series, ...rest.map((r) => r.series)].flat();
}

export async function fetchGenres(): Promise<Genre[]> {
  const res = await get<{ data: { genres: Genre[] } }>("/genres");
  return res.data.genres;
}

// Fetch movies list + full detail (with video URLs) in parallel batches
export async function fetchMoviesWithDetails(opts: {
  page?: number;
  limit?: number;
  genre_id?: number;
  latest?: boolean;
} = {}): Promise<{ movies: Movie[]; pagination: Pagination }> {
  const { movies, pagination } = await fetchMovies(opts);

  // Fetch details for each movie in parallel (gets qualities/video URLs)
  const detailed = await Promise.all(
    movies.map((m) => fetchMovieDetail(m.id).catch(() => m)) // fallback to list data on error
  );

  return { movies: detailed, pagination };
}
