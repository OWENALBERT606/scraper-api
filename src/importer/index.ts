import { Importer } from "./importer";
import { freewatchSource, mlegacySource } from "./sources";

/** The importers the server runs, one per source site (settings come from the environment). Each has its own ledger and status. */
export const importers: Record<string, Importer> = {
  freewatch: new Importer(process.env, { source: freewatchSource() }),
  mlegacytv: new Importer(process.env, { source: mlegacySource() }),
};

/** The FreeWatch importer, kept for existing callers. */
export const importer = importers.freewatch;

/** The importer for ?source= (FreeWatch when none is given), or null for an unknown name. */
export function importerFor(name: unknown): Importer | null {
  const key = typeof name === "string" && name ? name : "freewatch";
  return importers[key] ?? null;
}

export function startAllAutoruns(): void {
  for (const i of Object.values(importers)) i.startAutorun();
}

export { Importer } from "./importer";
export type { ImportMedia, ImportStatus, RunOptions } from "./importer";
