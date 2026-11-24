import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { bestImdbMatch, bestTmdbMatch, bytesToSize, cleanTitle, cleanVj, durationToSeconds, extensionOf, looksLikeFilm, normalizeTitle, safeKeyPart, secondsToLength, sizeToBytes } from "./parse";
import { b2ObjectUrl, loadImportConfig } from "./config";
import { Platform } from "./platform";
import { B2Store } from "./b2";
import { Importer, mediaForId, orderMlegacyIds } from "./importer";
import { genreOverrideFor, mergeGenreOverrides, parseGenreOverrides } from "./overrides";
import type { Source } from "./sources";

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

test("metadata matches tolerate spelling variants but still refuse guesses", () => {
  const hits = [
    { tmdbId: 1, title: "Spiderman - No Way Home", year: 2021, imdbId: "tt1" },
    { tmdbId: 2, title: "Hope Springs", year: 2021, imdbId: null },
  ];
  assert.equal(bestTmdbMatch("Spider Man No Way Home", 2021, hits)?.tmdbId, 1);
  assert.equal(bestTmdbMatch("Spider Man No Way Home", 1999, hits), null);
  assert.equal(bestImdbMatch("Spider Man No Way Home", 2021, hits)?.imdbId, "tt1");
  const ambiguous = [
    { tmdbId: 1, title: "Spiderman No Way Home", year: 2021, imdbId: "tt1" },
    { tmdbId: 2, title: "Spiderman No Way Home 2", year: 2021, imdbId: "tt2" },
  ];
  assert.equal(bestTmdbMatch("Spider Man No Way Home", null, ambiguous), null);
});

test("genre overrides accept ids and titles in either shape", () => {
  const structured = parseGenreOverrides('{"ids":{"freewatch:1":"Drama"},"titles":{"The Weird Film!":"Horror"}}');
  assert.equal(genreOverrideFor(structured, "freewatch", "1", []), "Drama");
  assert.equal(genreOverrideFor(structured, "freewatch", "2", ["Weird Film"]), "Horror");
  assert.equal(genreOverrideFor(structured, "freewatch", "2", ["Something Else"]), null);
  const flat = parseGenreOverrides('{"2":"Action","film name":"Comedy"}');
  assert.equal(genreOverrideFor(flat, "mlegacytv", "2", []), "Action");
  assert.equal(genreOverrideFor(flat, "mlegacytv", "9", ["Film: Name"]), "Comedy");
  assert.equal(genreOverrideFor(mergeGenreOverrides(structured, flat), "freewatch", "2", []), "Action");
  assert.throws(() => parseGenreOverrides("{"), /valid JSON/);
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
  assert.equal(b2ObjectUrl({ ...config.b2, publicUrl: "https://cdn.example.com/" .replace(/\/$/, "") }, "movies/a.mp4"), "https://cdn.example.com/movies/a.mp4");
  // the API's own variable names work too
  const api = loadImportConfig({ IMPORT_MODE: "copy", B2_APP_KEY: "s", B2_BUCKET_NAME: "bkt2" });
  assert.equal(api.config.b2.appKey, "s");
  assert.equal(api.config.b2.bucket, "bkt2");
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

test("platform: a refused sign-in is fatal and names the likely cause on a 404", async () => {
  const { config } = loadImportConfig({ PLATFORM_API_URL: "http://x.test/api/v1", PLATFORM_EMAIL: "a@b.c", PLATFORM_PASSWORD: "pw" });
  const p = new Platform(config, (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch);
  await assert.rejects(p.signIn(), (e: Error & { fatal?: boolean }) => e.fatal === true && /PLATFORM_API_URL/.test(e.message));
});

test("platform: refreshes the token after an expired-token 403", async () => {
  const { config } = loadImportConfig({ PLATFORM_API_URL: "http://x.test/api/v1", PLATFORM_EMAIL: "a@b.c", PLATFORM_PASSWORD: "pw" });
  let logins = 0;
  let checks = 0;
  const f = (async (url: string) => {
    if (String(url).endsWith("/login")) {
      logins++;
      return new Response(JSON.stringify({ data: { accessToken: `t${logins}` } }), { status: 200 });
    }
    checks++;
    if (checks === 1) return new Response(JSON.stringify({ error: "Invalid or expired token" }), { status: 403 });
    return new Response(JSON.stringify({ data: [], duplicate: null }), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new Platform(config, f);
  assert.deepEqual(await p.checkTitle("Hope"), { duplicate: false, existsAnyVj: false });
  assert.equal(logins, 2);
  assert.equal(checks, 2);
});

test("platform: finds a series by title and VJ and reads its seasons and episodes", async () => {
  const { platform } = fakePlatform((_m, path) => {
    if (path.startsWith("/series?")) return { body: { data: [{ id: "s0", title: "Other", vj: { id: "v1" } }, { id: "s1", title: "Your Honor", vj: { id: "v1" } }, { id: "s2", title: "Your Honor", vj: { id: "v2" } }] } };
    if (path === "/series/s1/seasons") return { body: { data: [{ id: "se1", seasonNumber: 2 }] } };
    return { body: { data: [{ episodeNumber: 1 }, { episodeNumber: 3 }] } };
  });
  assert.equal((await platform.findSeries("Your Honor", "v1"))?.id, "s1");
  assert.equal(await platform.findSeries("Your Honor", "v9"), null);
  const tree = await platform.seriesTree("s1");
  assert.deepEqual([...(tree.get(2)?.episodes ?? [])], [1, 3]);
});

test("platform: importers share one sign-in", async () => {
  const { config } = loadImportConfig({ PLATFORM_API_URL: "http://x.test/api/v1", PLATFORM_EMAIL: "a@b.c", PLATFORM_PASSWORD: "pw" });
  let logins = 0;
  const f = (async (url: string) => {
    if (String(url).endsWith("/login")) logins++;
    return new Response(JSON.stringify({ data: { accessToken: "t" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const a = new Platform(config, f);
  const b = new Platform(config, f);
  await Promise.all([a.signIn(), b.signIn()]);
  await a.signIn();
  await b.signIn();
  assert.equal(logins, 1);
});

test("Mlegacy ids identify films and series episodes", () => {
  assert.equal(mediaForId("m:123", "mlegacytv"), "movies");
  assert.equal(mediaForId("e:123", "mlegacytv"), "series");
  assert.equal(mediaForId("s:123", "mlegacytv"), "series");
});

test("Mlegacy series episodes are queued before films in an all-media run", () => {
  assert.deepEqual(
    orderMlegacyIds(["e:1", "m:1", "e:2", "m:2", "m:3"]),
    ["e:1", "e:2", "m:1", "m:2", "m:3"]
  );
  assert.deepEqual(orderMlegacyIds(["e:1", "e:2"]), ["e:1", "e:2"]);
  assert.deepEqual(orderMlegacyIds([]), []);
});

function mediaImporter(id: string, detail: { title: string; playingurl: string; isFilm?: boolean; episode?: { base: string; season: number; episode: number } }): Importer {
  const source: Source = {
    name: "freewatch",
    label: "Test",
    referer: "",
    missing: () => [],
    discover: async () => ({ ids: [id], groupSize: new Map() }),
    detail: async () => detail,
    sections: async () => new Map(),
  };
  return new Importer(
    { PLATFORM_API_URL: "http://x.test/api/v1", PLATFORM_EMAIL: "a@b.c", PLATFORM_PASSWORD: "pw", IMPORT_DATA_DIR: "data-test-media" },
    { platform: { signIn: async () => undefined } as unknown as Platform, store: {} as unknown as B2Store, source }
  );
}

test("a series-only run skips films", async () => {
  const result = await mediaImporter("media-film", { title: "Hope", playingurl: "https://x.test/hope.mp4", isFilm: true }).run({ dryRun: true, media: "series" });
  assert.equal(result.counts.skipped, 1);
  assert.match(result.items[0]?.reason ?? "", /series-only/);
});

test("a movies-only run skips series episodes", async () => {
  const result = await mediaImporter("media-episode", {
    title: "Show S1 E2",
    playingurl: "https://x.test/show-s01e02.mp4",
    episode: { base: "Show", season: 1, episode: 2 },
  }).run({ dryRun: true, media: "movies" });
  assert.equal(result.counts.skipped, 1);
  assert.match(result.items[0]?.reason ?? "", /movies-only/);
});

function genreOverrideImporter(dataDir: string, inline?: string) {
  const genres: string[] = [];
  let payload: Record<string, unknown> | null = null;
  const source: Source = {
    name: "freewatch",
    label: "Test",
    referer: "",
    missing: () => [],
    discover: async () => ({ ids: ["42"], groupSize: new Map() }),
    detail: async () => ({
      title: "Strange Upload (2020)",
      playingurl: "https://x.test/strange.mp4",
      vj: "Emmy",
      isFilm: true,
      category_id: 999,
    }),
    sections: async () => new Map(),
  };
  const platform = {
    signIn: async () => undefined,
    findVj: async () => ({ id: "v1", name: "VJ Emmy" }),
    checkTitle: async () => ({ duplicate: false, existsAnyVj: false }),
    searchTmdb: async () => [],
    enrich: async () => null,
    ensureGenre: async (name: string) => {
      genres.push(name);
      return { id: `g:${name}`, name };
    },
    ensureYear: async () => ({ id: "y1", value: 2020 }),
    createMovie: async (body: Record<string, unknown>) => {
      payload = body;
      return { id: "m1", title: String(body.title) };
    },
  } as unknown as Platform;
  const env: NodeJS.ProcessEnv = {
    PLATFORM_API_URL: "http://x.test/api/v1",
    PLATFORM_EMAIL: "a@b.c",
    PLATFORM_PASSWORD: "pw",
    IMPORT_DATA_DIR: dataDir,
    ...(inline ? { IMPORT_GENRE_OVERRIDES: inline } : {}),
  };
  return { importer: new Importer(env, { platform, store: {} as B2Store, source }), genres, payload: () => payload };
}

test("an inline genre override rescues a film with no metadata genre", async () => {
  const dir = path.join(os.tmpdir(), `movie-champ-genre-${randomUUID()}`);
  const { importer, genres, payload } = genreOverrideImporter(dir, '{"42":"Drama"}');
  try {
    const result = await importer.run({ ids: ["42"] });
    assert.equal(result.counts.imported, 1);
    assert.equal(result.counts.failed, 0);
    assert.deepEqual(genres, ["Drama"]);
    assert.deepEqual(payload()?.genreIds, ["g:Drama"]);
    assert.match(result.items[0]?.reason ?? "", /manual genre override/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a film with no genre anywhere is imported as Thriller", async () => {
  const dir = path.join(os.tmpdir(), `movie-champ-genre-${randomUUID()}`);
  const { importer, genres, payload } = genreOverrideImporter(dir);
  try {
    const result = await importer.run({ ids: ["42"] });
    assert.equal(result.counts.imported, 1);
    assert.equal(result.counts.failed, 0);
    assert.deepEqual(genres, ["Thriller"]);
    assert.deepEqual(payload()?.genreIds, ["g:Thriller"]);
    assert.match(result.items[0]?.reason ?? "", /Thriller/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a genre-overrides.json file in the data directory is used", async () => {
  const dir = path.join(os.tmpdir(), `movie-champ-genre-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "genre-overrides.json"), JSON.stringify({ titles: { "Strange Upload": "Horror" } }));
  const { importer, genres } = genreOverrideImporter(dir);
  try {
    const result = await importer.run({ ids: ["42"] });
    assert.equal(result.counts.imported, 1);
    assert.deepEqual(genres, ["Horror"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
