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
import {
  fetchDashboard as fetchMltvDashboard,
  fetchCatalog as fetchMltvCatalog,
  fetchMovie as fetchMltvMovie,
  fetchSeries as fetchMltvSeries,
  searchContent as searchMltvContent,
  clearMlegacytvCache,
} from "./scrapers/mlegacytv";
import { proxyBase, proxyUrl } from "./proxy";
import { importerFor } from "./importer";
import {
  drainUploadQueue,
  enqueueUploads,
  getUploaderStatus,
  isUploadConfigured,
  startUploadScheduler,
  stopUploadScheduler,
  UploadRequest,
} from "./uploader";

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

// ═══════════════════════════════════════════════════════════════════════════════
// MlegacyTV routes  (https://mlegacytv.com) — Supabase-backed catalog
// ═══════════════════════════════════════════════════════════════════════════════

type MltvItem = { image: string; playingurl: string };

function enrichMltv<T extends MltvItem>(item: T): T & {
  poster_url: string;
  stream_url: string;
} {
  return {
    ...item,
    poster_url: item.image || "",
    stream_url: rawStreamUrl(item.playingurl),
  };
}

router.get("/mlegacytv/dashboard", async (_req: Request, res: Response) => {
  try {
    const data = await fetchMltvDashboard();
    res.json({
      success: true,
      data: {
        sections: data.sections.map((section) => ({
          ...section,
          items: section.items.map(enrichMltv),
        })),
        unique_movies: data.unique_movies,
        unique_series: data.unique_series,
        movies: data.movies.map(enrichMltv),
        series: data.series.map(enrichMltv),
        vjs: data.vjs,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

router.get("/mlegacytv/catalog", async (req: Request, res: Response) => {
  try {
    const type = (req.query.type as string) ?? "all";
    if (!["all", "movies", "series"].includes(type)) {
      res.status(400).json({ error: "type must be all, movies or series" });
      return;
    }
    const data = await fetchMltvCatalog({
      type: type as "all" | "movies" | "series",
      limit: req.query.limit as string,
      offset: req.query.offset as string,
    });
    res.json({
      success: true,
      data: {
        total: data.total,
        movies_total: data.movies_total,
        series_total: data.series_total,
        limit: Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000),
        offset: Math.max(Number(req.query.offset) || 0, 0),
        movies: data.movies.map(enrichMltv),
        series: data.series.map(enrichMltv),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

router.get("/mlegacytv/movies/:id", async (req: Request, res: Response) => {
  try {
    const movie = await fetchMltvMovie(req.params.id);
    if (!movie) { res.status(404).json({ error: "Movie not found" }); return; }
    res.json({ success: true, data: enrichMltv(movie) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Not found" });
  }
});

router.get("/mlegacytv/series/:id", async (req: Request, res: Response) => {
  try {
    const series = await fetchMltvSeries(req.params.id);
    if (!series) { res.status(404).json({ error: "Series not found" }); return; }
    res.json({
      success: true,
      data: {
        ...enrichMltv(series),
        seasons: series.seasons.map((season) => ({
          ...season,
          episodes: season.episodes.map(enrichMltv),
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Not found" });
  }
});

router.get("/mlegacytv/search", async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) {
    res.status(400).json({ error: "q query param is required" });
    return;
  }
  try {
    const data = await searchMltvContent(q);
    res.json({
      success: true,
      data: {
        query: data.query,
        total: data.total,
        movies: data.movies.map(enrichMltv),
        series: data.series.map(enrichMltv),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Search failed" });
  }
});

router.delete("/mlegacytv/cache", (_req: Request, res: Response) => {
  clearMlegacytvCache();
  res.json({ success: true, message: "MlegacyTV cache cleared" });
});

router.post("/upload/queue", async (req: Request, res: Response) => {
  if (!isUploadConfigured()) {
    res.status(503).json({ error: "UPLOAD_API_URL is not configured on the server" });
    return;
  }

  const body = req.body as { items?: UploadRequest[] } & UploadRequest;
  const requests: UploadRequest[] = Array.isArray(body?.items) ? body.items : [body];

  if (requests.length === 0) {
    res.status(400).json({ error: "No items provided" });
    return;
  }

  try {
    const jobs = await enqueueUploads(requests);
    res.json({
      success: true,
      queued: jobs.length,
      jobs: jobs.map((job) => ({ id: job.id, filename: job.filename, title: job.metadata.title })),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Queue failed" });
  }
});

router.post("/upload/start", async (_req: Request, res: Response) => {
  if (!isUploadConfigured()) {
    res.status(503).json({ error: "UPLOAD_API_URL is not configured on the server" });
    return;
  }
  const handled = await drainUploadQueue();
  res.json({ success: true, handled, status: getUploaderStatus() });
});

router.get("/upload/status", (_req: Request, res: Response) => {
  res.json({ success: true, data: getUploaderStatus() });
});

router.post("/upload/start-scheduler", (_req: Request, res: Response) => {
  startUploadScheduler();
  res.json({ success: true, data: getUploaderStatus() });
});

router.post("/upload/stop-scheduler", (_req: Request, res: Response) => {
  stopUploadScheduler();
  res.json({ success: true, data: getUploaderStatus() });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Importer: copies films from FreeWatch UG to MovieChamp256 (video to Backblaze B2, full metadata, existing films skipped)
// ═══════════════════════════════════════════════════════════════════════════════

// Anyone who can reach this server could otherwise start imports: require IMPORT_API_KEY (header x-api-key) when it is set.
// With no key set, the import routes are refused unless the request comes from the machine itself.
router.use("/import", (req: Request, res: Response, next) => {
  const key = (process.env.IMPORT_API_KEY ?? "").trim();
  if (key) {
    if (req.header("x-api-key") === key) return next();
    res.status(401).json({ error: "Missing or wrong x-api-key" });
    return;
  }
  const ip = req.socket.remoteAddress ?? "";
  if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) return next();
  res.status(403).json({ error: "Set IMPORT_API_KEY on the server to use the import routes remotely" });
});

// Every import route takes ?source=freewatch (default) or ?source=mlegacytv
function pickImporter(req: Request, res: Response) {
  const imp = importerFor(req.query.source);
  if (!imp) res.status(400).json({ error: "Unknown source (use freewatch or mlegacytv)" });
  return imp;
}

// ── GET /import/status ────────────────────────────────────────────────────────
router.get("/import/status", (req: Request, res: Response) => {
  const imp = pickImporter(req, res);
  if (imp) res.json({ success: true, data: imp.status() });
});

// ── POST /import/start  { dryRun?: boolean, limit?: number, ids?: (number|string)[] } ──
// Starts in the background and answers at once. Use dryRun first: it only reports what would be imported or skipped.
router.post("/import/start", (req: Request, res: Response) => {
  const imp = pickImporter(req, res);
  if (!imp) return;
  const body = (req.body ?? {}) as { dryRun?: boolean; limit?: number; ids?: (number | string)[]; retryFailed?: boolean };
  const r = imp.start({
    dryRun: body.dryRun === true,
    retryFailed: body.retryFailed === true,
    limit: typeof body.limit === "number" ? body.limit : undefined,
    ids: Array.isArray(body.ids) ? body.ids.filter((x) => (typeof x === "number" && Number.isFinite(x)) || (typeof x === "string" && x.trim())) : undefined,
  });
  if (!r.started) { res.status(409).json({ error: r.reason }); return; }
  res.json({ success: true, data: imp.status() });
});

// ── POST /import/stop ─────────────────────────────────────────────────────────
router.post("/import/stop", (req: Request, res: Response) => {
  const imp = pickImporter(req, res);
  if (!imp) return;
  imp.stop();
  res.json({ success: true, data: imp.status() });
});

export default router;
