import test from "node:test";
import assert from "node:assert/strict";
import { bestTmdbMatch, bytesToSize, cleanTitle, cleanVj, durationToSeconds, extensionOf, looksLikeFilm, normalizeTitle, safeKeyPart, secondsToLength, sizeToBytes } from "./parse";
import { b2ObjectUrl, loadImportConfig } from "./config";
import { Platform } from "./platform";

test("titles normalise to one form", () => {
  assert.equal(normalizeTitle("The Matrix: Reloaded!"), "matrix reloaded");
  assert.equal(normalizeTitle("Fast & Furious"), "fast and furious");
  assert.equal(normalizeTitle("Amélie"), "amelie");
});

test("cleanTitle strips year, tags and VJ names", () => {
  assert.deepEqual(cleanTitle("Hope (2026)"), { title: "Hope", year: 2026 });
  assert.equal(cleanTitle("Some Film [HD]").title, "Some Film");
  assert.equal(cleanTitle("Some Film Vj Junior").title, "Some Film");
});

test("VJ names lose the prefix", () => {
  assert.equal(cleanVj("Vj Emmy"), "Emmy");
  assert.equal(cleanVj("  "), "");
  assert.equal(cleanVj(null), "");
});

test("durations and sizes", () => {
  assert.equal(durationToSeconds("01h 21m"), 4860);
  assert.equal(durationToSeconds("95 min"), 5700);
  assert.equal(durationToSeconds("5700"), 5700);
  assert.equal(durationToSeconds("n/a"), 0);
  assert.equal(secondsToLength(4860), "1h 21m");
  assert.equal(secondsToLength(3600), "1h");
  assert.equal(sizeToBytes("1.1 GB"), Math.round(1.1 * 1024 ** 3));
  assert.equal(sizeToBytes("junk"), 0);
  assert.equal(bytesToSize(1181116006), "1.1 GB");
});

test("only single, non-episode titles are films", () => {
  assert.equal(looksLikeFilm("Hope", 1), true);
  assert.equal(looksLikeFilm("Hope", 8), false);
  assert.equal(looksLikeFilm("Show S01E02", 1), false);
  assert.equal(looksLikeFilm("Show Season 2", 1), false);
  assert.equal(looksLikeFilm("", 1), false);
});

test("keys and extensions", () => {
  assert.equal(extensionOf("https://cdn.example.com/a/b/film.MP4"), "mp4");
  assert.equal(extensionOf("https://cdn.example.com/a/list.m3u8"), "m3u8");
  assert.equal(extensionOf("not a url"), "");
  assert.equal(safeKeyPart("Wé/ird: name?"), "Weird name");
  assert.equal(safeKeyPart("???"), "movie");
});

test("TMDB match needs the same title and a close year", () => {
  const hits = [
    { tmdbId: 1, title: "Hope", year: 2010 },
    { tmdbId: 2, title: "Hope", year: 2026 },
    { tmdbId: 3, title: "Hope Springs", year: 2026 },
  ];
  assert.equal(bestTmdbMatch("Hope", 2026, hits)?.tmdbId, 2);
  assert.equal(bestTmdbMatch("Hope", 2000, hits), null); // two candidates, none near the year
  assert.equal(bestTmdbMatch("Nothing", null, hits), null);
  assert.equal(bestTmdbMatch("Hope Springs", null, hits)?.tmdbId, 3);
});

test("config reports what is missing and never throws", () => {
  assert.ok(!loadImportConfig({}).missing.includes("B2_BUCKET")); // link mode needs no B2
  const { missing } = loadImportConfig({ IMPORT_MODE: "copy" });
  assert.ok(missing.includes("B2_BUCKET") && missing.includes("PLATFORM_EMAIL"));
  const { config, missing: none } = loadImportConfig({
    PLATFORM_API_URL: '"http://x.test/api/v1/"', PLATFORM_EMAIL: "a@b.c", PLATFORM_PASSWORD: "pw",
    B2_ENDPOINT: "https://s3.example.com", B2_REGION: "r", B2_KEY_ID: "k", B2_APPLICATION_KEY: "s", B2_BUCKET: "bkt",
    IMPORT_CONCURRENCY: "99",
  });
  assert.deepEqual(none, []);
  assert.equal(config.platformUrl, "http://x.test/api/v1");
  assert.equal(config.concurrency, 4);
  assert.equal(b2ObjectUrl(config.b2, "movies/a.mp4"), "https://bkt.s3.example.com/movies/a.mp4");
});

function fakePlatform(routes: (method: string, path: string) => { status?: number; body: unknown }) {
  const { config } = loadImportConfig({
    PLATFORM_API_URL: "http://x.test/api/v1", PLATFORM_EMAIL: "a@b.c", PLATFORM_PASSWORD: "pw",
    B2_ENDPOINT: "https://s3.example.com", B2_REGION: "r", B2_KEY_ID: "k", B2_APPLICATION_KEY: "s", B2_BUCKET: "bkt",
  });
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const path = url.replace("http://x.test/api/v1", "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const r = path === "/login" ? { body: { data: { accessToken: "t" } } } : routes(method, path);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { platform: new Platform(config, f), calls };
}

test("platform: existing title under the same VJ is a duplicate", async () => {
  const { platform } = fakePlatform(() => ({ body: { data: [{ id: "1" }], duplicate: { id: "1" } } }));
  assert.deepEqual(await platform.checkTitle("Hope", "v1"), { duplicate: true, existsAnyVj: true });
});

test("platform: unknown title is not a duplicate", async () => {
  const { platform } = fakePlatform(() => ({ body: { data: [], duplicate: null } }));
  assert.deepEqual(await platform.checkTitle("Nope"), { duplicate: false, existsAnyVj: false });
});

test("platform: finds an existing VJ by loose name and creates a missing one", async () => {
  const { platform, calls } = fakePlatform((m) =>
    m === "POST" ? { body: { data: { id: "9", name: "VJ NEW" } } } : { body: { data: [{ id: "1", name: "VJ EMMY" }] } }
  );
  assert.equal((await platform.ensureVj("Vj Emmy")).id, "1");
  assert.equal((await platform.ensureVj("Vj New")).id, "9");
  assert.equal(calls.filter((c) => c === "POST /vjs").length, 1);
});
