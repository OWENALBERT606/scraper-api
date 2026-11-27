import test from "node:test";
import assert from "node:assert/strict";
import type * as MLTV from "./mlegacytv";
import type { ExistingSeries } from "../importer/sources";

process.env.MLEGACYTV_SUPABASE_URL = "https://supabase.test";
process.env.MLEGACYTV_SUPABASE_KEY = "anon";
process.env.MLEGACYTV_EMAIL = "user@example.com";
process.env.MLEGACYTV_PASSWORD = "secret";

test("only real authentication failures make a playback account rotate", async () => {
  const { isPlaybackAuthFailure } = await import("./mlegacytv");
  assert.equal(isPlaybackAuthFailure(401, "invalid JWT"), true);
  assert.equal(isPlaybackAuthFailure(403, "session expired"), true);
  assert.equal(isPlaybackAuthFailure(403, "An active subscription is required to watch or download."), false);
  assert.equal(isPlaybackAuthFailure(500, "token"), false);
});

test("a subscription refusal is reported without draining the account pool", async () => {
  const { resolvePlaybackUrl } = await import("./mlegacytv");
  let signIns = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/auth/v1/token")) {
      signIns++;
      return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "An active subscription is required to watch or download." }), { status: 403 });
  }) as unknown as typeof fetch;

  await assert.rejects(resolvePlaybackUrl("https://stale.example/film.mp4", fetchImpl), /active subscription/);
  await assert.rejects(resolvePlaybackUrl("https://stale.example/other.mp4", fetchImpl), /active subscription/);
  assert.equal(signIns, 1);
});

test("MlegacyTV fill-existing only queues episodes absent from the platform", async (t) => {
  const mltv = await import("./mlegacytv");
  const { mlegacySource } = await import("../importer/sources");
  const series = { id: "s1", title: "Queen of the South", vj_name: "Junior" } as MLTV.MLTVSeries;
  t.mock.method(mltv, "fetchCatalog", async () => ({ total: 1, movies_total: 0, series_total: 1, movies: [], series: [series] }));
  t.mock.method(mltv, "fetchSeries", async () => ({
    ...series,
    genre: [],
    seasons: [{
      id: 1,
      title: "Season 1",
      order: 1,
      episode_count: 2,
      published: true,
      episodes: [
        { id: 42550, title: "Piloto", playingurl: "https://x.test/1.mp4", season_id: 1, order: 1, published: true },
        { id: 42551, title: "Cuarenta Minutos", playingurl: "https://x.test/2.mp4", season_id: 1, order: 2, published: true },
      ],
    }],
    total_episodes: 2,
  } as unknown as MLTV.MLTVSeriesDetail));

  const existing: ExistingSeries[] = [
    { id: "p1", title: "Queen of the South", vjName: "JUNIOR", tree: new Map([[1, { id: "se1", episodes: new Set([1]) }]]) },
  ];
  assert.deepEqual(await mlegacySource().missingEpisodes!(existing, () => {}), ["e:42551"]);
});
