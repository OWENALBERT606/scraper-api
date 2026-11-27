import test from "node:test";
import assert from "node:assert/strict";

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
