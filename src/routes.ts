import { Router, Request, Response } from "express";
import { scrape, ScrapeOptions, ScrapeResult } from "./scraper";
import {
  fetchMoviesWithDetails,
  fetchMovieDetail,
  fetchSeries,
  fetchSeriesDetail,
  fetchAllSeries,
  fetchGenres,
  type Movie,
} from "./scrapers/tulabe";
import { proxyBase, proxyUrl } from "./proxy";

// Stamp every movie with proxy-resolved URLs safe for any consuming origin
function enrichMovie(movie: Movie, base: string): Movie & {
  poster_url: string;
  stream_url: string;
  qualities: Array<Movie["qualities"][number] & { stream_url: string }>;
} {
  const best = movie.qualities?.length
    ? movie.qualities[movie.qualities.length - 1]
    : null;

  return {
    ...movie,
    poster_url: proxyUrl(base, movie.thumbnail_url),   // image through proxy
    stream_url: best ? proxyUrl(base, best.playlist_url) : "",  // best quality HLS
    qualities: (movie.qualities ?? []).map((q) => ({
      ...q,
      stream_url: proxyUrl(base, q.playlist_url),
    })),
  };
}

const router = Router();

// In-memory cache: url → result
const cache = new Map<string, ScrapeResult>();

// ── POST /scrape ──────────────────────────────────────────────────────────────
router.post("/scrape", async (req: Request, res: Response) => {
  const { url, selectors, waitFor } = req.body as ScrapeOptions;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required and must be a string" });
    return;
  }

  try { new URL(url); } catch {
    res.status(400).json({ error: "Invalid URL format" });
    return;
  }

  try {
    const result = await scrape({ url, selectors, waitFor });
    cache.set(url, result);
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scraping failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /data ─────────────────────────────────────────────────────────────────
router.get("/data", (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) { res.status(400).json({ error: "url query param is required" }); return; }
  const result = cache.get(url);
  if (!result) { res.status(404).json({ error: "No cached data for this URL. POST /scrape first." }); return; }
  res.json({ success: true, data: result });
});

// ── GET /cache ────────────────────────────────────────────────────────────────
router.get("/cache", (_req: Request, res: Response) => {
  res.json({ count: cache.size, urls: Array.from(cache.keys()) });
});

// ── DELETE /cache ─────────────────────────────────────────────────────────────
router.delete("/cache", (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (url) { cache.delete(url); res.json({ success: true, message: `Cleared cache for ${url}` }); }
  else { cache.clear(); res.json({ success: true, message: "All cache cleared" }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tulabe routes
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /tulabe/movies ────────────────────────────────────────────────────────
// Query params: page, limit, genre_id, latest
router.get("/tulabe/movies", async (req: Request, res: Response) => {
  try {
    const page     = parseInt(req.query.page    as string) || 1;
    const limit    = parseInt(req.query.limit   as string) || 20;
    const genre_id = req.query.genre_id ? parseInt(req.query.genre_id as string) : undefined;
    const latest   = req.query.latest === "true";
    const base     = proxyBase(req);

    const { movies, pagination } = await fetchMoviesWithDetails({ page, limit, genre_id, latest });
    res.json({
      success: true,
      data: {
        movies: movies.map((m) => enrichMovie(m, base)),
        pagination,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ── GET /tulabe/movies/:id ────────────────────────────────────────────────────
router.get("/tulabe/movies/:id", async (req: Request, res: Response) => {
  try {
    const movie = await fetchMovieDetail(req.params.id);
    res.json({ success: true, data: enrichMovie(movie, proxyBase(req)) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Not found" });
  }
});

// ── GET /tulabe/series ────────────────────────────────────────────────────────
router.get("/tulabe/series", async (req: Request, res: Response) => {
  try {
    const page  = parseInt(req.query.page  as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const data  = await fetchSeries({ page, limit });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ── GET /tulabe/series/all (must be before /:id) ──────────────────────────────
router.get("/tulabe/series/all", async (_req: Request, res: Response) => {
  try {
    const series = await fetchAllSeries();
    res.json({ success: true, data: { series, total: series.length } });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ── GET /tulabe/series/:id ────────────────────────────────────────────────────
router.get("/tulabe/series/:id", async (req: Request, res: Response) => {
  try {
    const base   = proxyBase(req);
    const detail = await fetchSeriesDetail(parseInt(req.params.id));
    const enriched = {
      ...detail,
      seasons: detail.seasons.map((season) => ({
        ...season,
        episodes: season.episodes.map((ep) => ({
          ...ep,
          poster_url: proxyUrl(base, ep.thumbnail_url),
          stream_url: ep.video_url ? proxyUrl(base, ep.video_url) : "",
        })),
      })),
    };
    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Not found" });
  }
});

// ── GET /tulabe/genres ────────────────────────────────────────────────────────
router.get("/tulabe/genres", async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await fetchGenres() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

export default router;
