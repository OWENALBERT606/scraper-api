/**
 * Command line:  npm run import -- [--dry-run] [--limit N] [--ids 123,456] [--media all|movies|series]
 *   --dry-run        check what would be imported and what would be skipped; downloads and creates nothing
 *   --limit N        stop after N films
 *   --ids            only these source ids
 *   --source         freewatch (default) or mlegacytv
 *   --media          restrict to films or series episodes (--series-only / --movies-only are shorthand)
 */
import { importerFor } from "./index";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const ids = arg("ids")?.split(",").map((s) => s.trim()).filter(Boolean);
  const seriesOnly = process.argv.includes("--series-only");
  const moviesOnly = process.argv.includes("--movies-only");
  const requestedMedia = seriesOnly ? "series" : moviesOnly ? "movies" : arg("media")?.toLowerCase();
  if (seriesOnly && moviesOnly) {
    console.error("Use either --series-only or --movies-only, not both");
    process.exit(2);
  }
  if (requestedMedia && !["all", "movies", "series"].includes(requestedMedia)) {
    console.error("Unknown --media (use all, movies or series)");
    process.exit(2);
  }
  const media = requestedMedia === "movies" || requestedMedia === "series" ? requestedMedia : "all";
  const importer = importerFor(arg("source"));
  if (!importer) {
    console.error("Unknown --source (use freewatch or mlegacytv)");
    process.exit(2);
  }
  const first = importer.status();
  if (!first.configured) {
    console.error(`Not configured: set ${first.missing.join(", ")} (see .env.example)`);
    process.exit(2);
  }
  const timer = setInterval(() => {
    const s = importer.status();
    console.log(`[${s.message}] imported ${s.counts.imported}  ready ${s.counts.ready}  skipped ${s.counts.skipped}  failed ${s.counts.failed}`);
  }, 15_000);
  const result = await importer.run({ dryRun, limit, ids, media });
  clearInterval(timer);
  for (const i of result.items) console.log(`${i.status.padEnd(9)} ${i.sourceId} ${i.title}${i.vj ? ` (${i.vj})` : ""}${i.reason ? ` - ${i.reason}` : ""}`);
  console.log(`\n${result.message}. imported ${result.counts.imported}, would import ${result.counts.ready}, skipped ${result.counts.skipped}, failed ${result.counts.failed}`);
  process.exit(result.counts.failed > 0 ? 1 : 0);
}

void main();
