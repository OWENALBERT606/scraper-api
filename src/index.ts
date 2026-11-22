import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import routes from "./routes";
import proxyRouter from "./proxy";
import { startUploadScheduler } from "./uploader";
import { importer } from "./importer";

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
      "GET    /api/mlegacytv/dashboard",
      "GET    /api/mlegacytv/catalog?type=&limit=&offset=",
      "GET    /api/mlegacytv/movies/:id",
      "GET    /api/mlegacytv/series/:id",
      "GET    /api/mlegacytv/search?q=",
      "DELETE /api/mlegacytv/cache",
      "POST   /api/upload/queue",
      "POST   /api/upload/start",
      "GET    /api/upload/status",
      "POST   /api/upload/start-scheduler",
      "POST   /api/upload/stop-scheduler",
      "GET    /api/import/status",
      "POST   /api/import/start   { dryRun, limit, ids }",
      "POST   /api/import/stop",
    ],
  });
});

startUploadScheduler();
importer.startAutorun(); // only when IMPORT_AUTORUN_MINUTES is set and the importer is configured

app.listen(PORT, () => {
  console.log(`\nScraper API → http://localhost:${PORT}`);
  console.log(`  UI        : http://localhost:${PORT}/`);
  console.log(`  FreeWatch : /api/freewatch/dashboard | /movies/:id | /series/:id | /search?q=`);
  console.log(`  MlegacyTV : /api/mlegacytv/dashboard | /catalog | /movies/:id | /series/:id | /search?q=`);
  console.log(`  Upload    : /api/upload/queue | /start | /status | /start-scheduler | /stop-scheduler`);
});
