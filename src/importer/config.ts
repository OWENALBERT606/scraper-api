import path from "path";

export interface ImportConfig {
  platformUrl: string; // e.g. http://api.moviechamp256.com/api/v1
  email: string;
  password: string;
  b2: { endpoint: string; region: string; keyId: string; appKey: string; bucket: string };
  /** how many films are copied at once (each one streams a whole file, so keep this small) */
  concurrency: number;
  /** true: skip a film when its title already exists under ANY VJ; false (default): only under the same VJ */
  skipAnyVj: boolean;
  /** create a VJ / genre / release year on the platform when it does not exist yet (needs an administrator account) */
  createMissing: boolean;
  /** files smaller than this are refused (a truncated or error response saved as a video) */
  minBytes: number;
  /** "link" (default): the movie points at the source's video address, nothing is downloaded; "copy": the video is copied into B2 */
  mode: "link" | "copy";
  dataDir: string;
  /** run the import automatically every N minutes (0 = only when asked) */
  autorunMinutes: number;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["true", "1", "yes"].includes(raw.toLowerCase());
}

/** Quotes and stray spaces pasted around a value are removed. */
function clean(v: string | undefined): string {
  return (v ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
}

/** Reads the settings. `missing` names every required one that is not set (nothing is thrown, so status can report it). */
export function loadImportConfig(env: NodeJS.ProcessEnv = process.env): { config: ImportConfig; missing: string[] } {
  const config: ImportConfig = {
    platformUrl: clean(env.PLATFORM_API_URL).replace(/\/+$/, ""),
    email: clean(env.PLATFORM_EMAIL),
    password: clean(env.PLATFORM_PASSWORD),
    b2: {
      endpoint: clean(env.B2_ENDPOINT).replace(/\/+$/, ""),
      region: clean(env.B2_REGION),
      keyId: clean(env.B2_KEY_ID),
      appKey: clean(env.B2_APPLICATION_KEY),
      bucket: clean(env.B2_BUCKET),
    },
    concurrency: Math.max(1, Math.min(4, num(env, "IMPORT_CONCURRENCY", 1))),
    skipAnyVj: flag(env, "IMPORT_SKIP_ANY_VJ", false),
    createMissing: flag(env, "IMPORT_CREATE_MISSING", true),
    minBytes: num(env, "IMPORT_MIN_BYTES", 20 * 1024 * 1024),
    mode: clean(env.IMPORT_MODE).toLowerCase() === "copy" ? "copy" : "link",
    dataDir: clean(env.IMPORT_DATA_DIR) || path.join(process.cwd(), "data"),
    autorunMinutes: num(env, "IMPORT_AUTORUN_MINUTES", 0),
  };
  const need: [string, string][] = [
    ["PLATFORM_API_URL", config.platformUrl],
    ["PLATFORM_EMAIL", config.email],
    ["PLATFORM_PASSWORD", config.password],
  ];
  if (config.mode === "copy") {
    need.push(
      ["B2_ENDPOINT", config.b2.endpoint],
      ["B2_REGION", config.b2.region],
      ["B2_KEY_ID", config.b2.keyId],
      ["B2_APPLICATION_KEY", config.b2.appKey],
      ["B2_BUCKET", config.b2.bucket]
    );
  }
  return { config, missing: need.filter(([, v]) => !v).map(([k]) => k) };
}

/** The public address of a stored object, in the same form the platform already uses: https://<bucket>.<s3 host>/<key> */
export function b2ObjectUrl(b2: ImportConfig["b2"], key: string): string {
  const host = new URL(b2.endpoint).host;
  return `https://${b2.bucket}.${host}/${key}`;
}
