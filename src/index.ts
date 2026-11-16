import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import routes from "./routes";
import proxyRouter from "./proxy";

const app  = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());

// ── Static UI ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));

// ── API ───────────────────────────────────────────────────────────────────────
app.use("/api/proxy", proxyRouter);
app.use("/api", routes);

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    endpoints: [
      "GET  /api/freewatch/dashboard",
      "GET  /api/freewatch/movies/:id",
      "GET  /api/freewatch/series/:seriesCode",
      "GET  /api/freewatch/search?q=",
      "DELETE /api/freewatch/cache",
    ],
  });
});

app.listen(PORT, () => {
  console.log(`\nScraper API → http://localhost:${PORT}`);
  console.log(`  UI        : http://localhost:${PORT}/`);
  console.log(`  FreeWatch : /api/freewatch/dashboard | /movies/:id | /series/:id | /search?q=`);
});
