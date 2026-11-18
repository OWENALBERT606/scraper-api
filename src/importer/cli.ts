/**
 * Command line:  npm run import -- [--dry-run] [--limit N] [--ids 123,456]
 *   --dry-run   check what would be imported and what would be skipped; downloads and creates nothing
 *   --limit N   stop after N films
 *   --ids       only these FreeWatch ids
 */
import { importer } from "./index";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const ids = arg("ids")?.split(",").map((s) => Number(s.trim())).filter(Boolean);
  const first = importer.status();
  if (!first.configured) {
    console.error(`Not configured: set ${first.missing.join(", ")} (see .env.example)`);
    process.exit(2);
  }
  const timer = setInterval(() => {
    const s = importer.status();
    console.log(`[${s.message}] imported ${s.counts.imported}  ready ${s.counts.ready}  skipped ${s.counts.skipped}  failed ${s.counts.failed}`);
  }, 15_000);
  const result = await importer.run({ dryRun, limit, ids });
  clearInterval(timer);
  for (const i of result.items) console.log(`${i.status.padEnd(9)} #${i.sourceId} ${i.title}${i.vj ? ` (${i.vj})` : ""}${i.reason ? ` - ${i.reason}` : ""}`);
  console.log(`\n${result.message}. imported ${result.counts.imported}, would import ${result.counts.ready}, skipped ${result.counts.skipped}, failed ${result.counts.failed}`);
  process.exit(result.counts.failed > 0 ? 1 : 0);
}

void main();
