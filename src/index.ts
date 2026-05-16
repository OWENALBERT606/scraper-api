import express, { Request, Response } from "express";
import cors from "cors";
import routes from "./routes";
import proxyRouter, { proxyBase, proxyUrl } from "./proxy";
import {
  fetchMoviesWithDetails,
  fetchMovieDetail,
  fetchSeries,
  fetchAllSeries,
  fetchSeriesDetail,
  fetchGenres,
  type Movie,
} from "./scrapers/tulabe";
import {
  fetchLabaMovieDetail,
  fetchLabaFeatured,
  fetchLabaLatestMovies,
  fetchLabaPopularMovies,
  fetchLabaLatestSeries,
  fetchLabaPopularSeries,
  fetchLabaSimilar,
  fetchAllLabaMovies,
  fetchAllLabaMoviesWithDetail,
  fetchAllLabaSeries,
} from "./scrapers/labafilm";

const app  = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());

// ── Tulabe enrichment ─────────────────────────────────────────────────────────
function enrichTulabe(movie: Movie, base: string) {
  const best = movie.qualities?.length ? movie.qualities[movie.qualities.length - 1] : null;
  return {
    ...movie,
    source:      "tulabe",
    poster_url:  proxyUrl(base, movie.thumbnail_url),
    stream_url:  best ? proxyUrl(base, best.playlist_url) : "",
    qualities:   (movie.qualities ?? []).map((q) => ({ ...q, stream_url: proxyUrl(base, q.playlist_url) })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tulabe endpoints  →  /movies  /movies/:id  /series  /genres
// ═══════════════════════════════════════════════════════════════════════════════

app.get("/movies", async (req: Request, res: Response) => {
  try {
    const page     = parseInt(req.query.page    as string) || 1;
    const limit    = parseInt(req.query.limit   as string) || 20;
    const genre_id = req.query.genre_id ? parseInt(req.query.genre_id as string) : undefined;
    const latest   = req.query.latest === "true";
    const base     = proxyBase(req);
    const { movies, pagination } = await fetchMoviesWithDetails({ page, limit, genre_id, latest });
    res.json({ success: true, source: "tulabe", pagination, movies: movies.map((m) => enrichTulabe(m, base)) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

app.get("/movies/:id", async (req: Request, res: Response) => {
  try {
    const movie = await fetchMovieDetail(req.params.id);
    res.json({ success: true, source: "tulabe", movie: enrichTulabe(movie, proxyBase(req)) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Not found" });
  }
});

app.get("/series", async (req: Request, res: Response) => {
  try {
    const page  = parseInt(req.query.page  as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { series, pagination } = await fetchSeries({ page, limit });
    res.json({ success: true, source: "tulabe", pagination, series });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

app.get("/genres", async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, source: "tulabe", genres: await fetchGenres() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Labafilm endpoints  →  /labafilm/*
// ═══════════════════════════════════════════════════════════════════════════════

// GET /labafilm/movies?page=1&limit=20
app.get("/labafilm/movies", async (req: Request, res: Response) => {
  try {
    const movies = await fetchLabaLatestMovies();
    res.json({ success: true, source: "labafilm", total: movies.length, movies });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /labafilm/movies/all — full catalogue (cached, paginated)
app.get("/labafilm/movies/all", async (_req: Request, res: Response) => {
  try {
    const movies = await fetchAllLabaMovies();
    res.json({ success: true, source: "labafilm", total: movies.length, movies });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /labafilm/movies/featured
app.get("/labafilm/movies/featured", async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, source: "labafilm", movies: await fetchLabaFeatured() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /labafilm/movies/latest
app.get("/labafilm/movies/latest", async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, source: "labafilm", movies: await fetchLabaLatestMovies() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /labafilm/movies/popular
app.get("/labafilm/movies/popular", async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, source: "labafilm", movies: await fetchLabaPopularMovies() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /labafilm/movies/:id
app.get("/labafilm/movies/:id", async (req: Request, res: Response) => {
  try {
    const movie = await fetchLabaMovieDetail(req.params.id);
    res.json({ success: true, source: "labafilm", movie });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Not found" });
  }
});

// GET /labafilm/movies/:id/similar
app.get("/labafilm/movies/:id/similar", async (req: Request, res: Response) => {
  try {
    res.json({ success: true, source: "labafilm", movies: await fetchLabaSimilar(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /labafilm/series/latest
app.get("/labafilm/series/latest", async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, source: "labafilm", series: await fetchLabaLatestSeries() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /labafilm/series/popular
app.get("/labafilm/series/popular", async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, source: "labafilm", series: await fetchLabaPopularSeries() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /labafilm/series/all — full series catalogue (cached, paginated)
app.get("/labafilm/series/all", async (_req: Request, res: Response) => {
  try {
    const series = await fetchAllLabaSeries();
    res.json({ success: true, source: "labafilm", total: series.length, series });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// ── Tulabe series detail ───────────────────────────────────────────────────────

app.get("/series/:id", async (req: Request, res: Response) => {
  try {
    const base   = proxyBase(req);
    const detail = await fetchSeriesDetail(parseInt(req.params.id));
    // Proxy HLS video URLs for each episode
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
    res.json({ success: true, source: "tulabe", series: enriched });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Not found" });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    endpoints: {
      tulabe:   ["/movies", "/movies/:id", "/series", "/series/:id", "/genres"],
      labafilm: ["/labafilm/movies", "/labafilm/movies/all", "/labafilm/movies/featured", "/labafilm/movies/latest", "/labafilm/movies/popular", "/labafilm/movies/:id", "/labafilm/movies/:id/similar", "/labafilm/series/latest", "/labafilm/series/popular", "/labafilm/series/all"],
    },
  });
});

app.use("/api/proxy", proxyRouter);
app.use("/api", routes);

app.listen(PORT, () => {
  console.log(`\nScraper API → http://localhost:${PORT}`);
  console.log(`  Tulabe   : /movies  /movies/:id  /series  /genres`);
  console.log(`  Labafilm : /labafilm/movies  /labafilm/movies/featured|latest|popular`);
  console.log(`             /labafilm/movies/:id  /labafilm/series/latest|popular`);
});
