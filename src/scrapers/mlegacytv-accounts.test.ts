import test from "node:test";
import assert from "node:assert/strict";

process.env.MLEGACYTV_SUPABASE_URL = "https://supabase.test";
process.env.MLEGACYTV_SUPABASE_KEY = "anon";
process.env.MLEGACYTV_EMAIL = "user1@example.com";
process.env.MLEGACYTV_PASSWORD = "secret1";
process.env.MLEGACYTV_EMAIL_2 = "user2@example.com";
process.env.MLEGACYTV_PASSWORD_2 = "secret2";

test("a subscription refusal falls back to the next configured MlegacyTV account", async () => {
  const { resolvePlaybackUrl } = await import("./mlegacytv");
  let signIns = 0;
  let playbackCalls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/auth/v1/token")) {
      signIns++;
      return new Response(JSON.stringify({ access_token: `token-${signIns}`, expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("/api/playback-url")) {
      playbackCalls++;
      if (playbackCalls === 1) {
        return new Response(JSON.stringify({ error: "An active subscription is required to watch or download." }), { status: 403 });
      }
      return new Response(JSON.stringify({ url: "https://playable.example/video.mp4" }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const resolved = await resolvePlaybackUrl("https://stale.example/film.mp4", fetchImpl);
  assert.equal(resolved, "https://playable.example/video.mp4");
  assert.equal(signIns, 2);
  assert.equal(playbackCalls, 2);
});

test("when every configured account lacks a subscription the error says how many were tried", async () => {
  const { resolvePlaybackUrl } = await import("./mlegacytv");
  let playbackCalls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/auth/v1/token")) {
      return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("/api/playback-url")) {
      playbackCalls++;
      return new Response(JSON.stringify({ error: "An active subscription is required to watch or download." }), { status: 403 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  await assert.rejects(
    resolvePlaybackUrl("https://stale.example/other.mp4", fetchImpl),
    /tried 2 of 2 configured accounts/,
  );
  assert.equal(playbackCalls, 2);
});
