import { Router, Request, Response } from "express";
import { scrape, ScrapeOptions, ScrapeResult } from "./scraper";
import {
  fetchDashboard,
  fetchDashboardWithDetails,
  fetchFullCatalog,
  fetchMovieDetail,
  fetchSeries,
  searchContent,
  clearFreeWatchCache,
} from "./scrapers/freewatch";
import { proxyBase, proxyUrl } from "./proxy";

const router = Router();

// In-memory cache: url → result
const cache = new Map<string, ScrapeResult>();

// Video CDN URLs must be fetched directly by the browser (geo-restricted Bunny CDN).
// We return the raw URL as stream_url and let the browser handle it with referrerpolicy.
function rawStreamUrl(playingurl: string): string {
  return playingurl || "";
}

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
// FreeWatch UG routes  (https://www.freewatchug.online)
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /freewatch/dashboard ──────────────────────────────────────────────────
// Returns homepage sections + movie list with full titles/meta.
// First call fetches all details (~134 items in batches); subsequent calls use cache.
router.get("/freewatch/dashboard", async (req: Request, res: Response) => {
  try {
    const base = proxyBase(req);
    const data = await fetchDashboardWithDetails();

    const enrichMovies = (movies: typeof data.movies) =>
      movies.map((m) => ({
        ...m,
        poster_url: proxyUrl(base, m.image),
        stream_url: rawStreamUrl(m.playingurl),
      }));

    res.json({
      success: true,
      data: {
        sections: data.sections,
        unique_movies: data.unique_movies,
        movies: enrichMovies(data.movies),
        banner: data.banner
          ? {
              ...data.banner,
              poster_url: proxyUrl(base, data.banner.image),
              stream_url: rawStreamUrl(data.banner.playingurl),
            }
          : undefined,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ── GET /freewatch/catalog ────────────────────────────────────────────────────
// Full catalog built by searching a-z. ~465 unique titles. Cached 1 hour.
router.get("/freewatch/catalog", async (req: Request, res: Response) => {
  try {
    const base = proxyBase(req);
    const items = await fetchFullCatalog();
    res.json({
      success: true,
      data: {
        total: items.length,
        movies: items.map((m) => ({
          ...m,
          poster_url: proxyUrl(base, m.image),
          stream_url: rawStreamUrl(m.playingurl),
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});


// Full movie detail including direct MP4 / HLS stream URL.
router.get("/freewatch/movies/:id", async (req: Request, res: Response) => {
  try {
    const base = proxyBase(req);
    const movie = await fetchMovieDetail(req.params.id);
    res.json({
      success: true,
      data: {
        ...movie,
        poster_url: proxyUrl(base, movie.image),
        stream_url: rawStreamUrl(movie.playingurl),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Not found" });
  }
});

// ── GET /freewatch/series/:seriesCode ─────────────────────────────────────────
// All episodes for a series (use series_code from dashboard or search).
router.get("/freewatch/series/:seriesCode", async (req: Request, res: Response) => {
  try {
    const base = proxyBase(req);
    const data = await fetchSeries(req.params.seriesCode);
    res.json({
      success: true,
      data: {
        ...data,
        episodes: data.episodes.map((ep) => ({
          ...ep,
          poster_url: proxyUrl(base, ep.image),
          stream_url: rawStreamUrl(ep.playingurl),
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Not found" });
  }
});

// ── GET /freewatch/search?q=... ───────────────────────────────────────────────
// Search movies and series by title.
router.get("/freewatch/search", async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) {
    res.status(400).json({ error: "q query param is required" });
    return;
  }
  try {
    const base = proxyBase(req);
    const data = await searchContent(q);
    res.json({
      success: true,
      data: {
        query: data.query,
        total: data.total,
        movies: data.movies.map((m) => ({
          ...m,
          poster_url: proxyUrl(base, m.image),
          stream_url: rawStreamUrl(m.playingurl),
        })),
        series: data.series.map((s) => ({
          ...s,
          episodes: s.episodes.map((ep) => ({
            ...ep,
            poster_url: proxyUrl(base, ep.image),
            stream_url: rawStreamUrl(ep.playingurl),
          })),
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Search failed" });
  }
});

// ── DELETE /freewatch/cache ───────────────────────────────────────────────────
router.delete("/freewatch/cache", (_req: Request, res: Response) => {
  clearFreeWatchCache();
  res.json({ success: true, message: "FreeWatch cache cleared" });
});

export default router;
