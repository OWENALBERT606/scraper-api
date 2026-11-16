import { Router, Request, Response } from "express";

const router = Router();

export function proxyBase(req: { protocol: string; headers: { host?: string } }): string {
  const host = req.headers.host ?? "localhost:3000";
  return `${req.protocol}://${host}/api/proxy`;
}

export function proxyUrl(base: string, url: string): string {
  return `${base}?url=${encodeURIComponent(url)}`;
}

function addCors(res: Response) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
}

// Rewrite a .m3u8 playlist so every segment URL goes through the proxy
function rewritePlaylist(body: string, originalUrl: string, base: string): string {
  const urlBase = originalUrl.substring(0, originalUrl.lastIndexOf("/") + 1);
  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const segUrl = trimmed.startsWith("http") ? trimmed : `${urlBase}${trimmed}`;
      return proxyUrl(base, segUrl);
    })
    .join("\n");
}

// Allowed CDN hostnames
const ALLOWED_HOSTS = [
  "b-cdn.net",          // covers all *.b-cdn.net (Bunny CDN)
  "f006.backblazeb2.com",
];

function isAllowed(hostname: string): boolean {
  return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

router.options("/", (_req, res) => { addCors(res); res.sendStatus(204); });

router.get("/", async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) { res.status(400).json({ error: "url param required" }); return; }

  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
    const parsed = new URL(decoded);
    if (!isAllowed(parsed.hostname)) {
      res.status(403).json({ error: `Host not allowed: ${parsed.hostname}` });
      return;
    }
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  try {
    // Forward Range header from browser so video seeking works
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer":    "https://www.freewatchug.online/",
    };
    const rangeHeader = req.headers["range"];
    if (rangeHeader) headers["Range"] = rangeHeader;

    const upstream = await fetch(decoded, { headers });

    addCors(res);

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const isPlaylist  = decoded.includes(".m3u8") || contentType.includes("mpegurl");

    if (isPlaylist) {
      if (!upstream.ok) { res.status(upstream.status).send(`Upstream error: ${upstream.status}`); return; }
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, decoded, proxyBase(req));
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(rewritten);
      return;
    }

    // Pass through status (200 or 206 Partial Content for range requests)
    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");

    // Forward relevant response headers
    for (const h of ["content-length", "content-range", "last-modified", "etag"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    // Stream body to client
    const reader = upstream.body?.getReader();
    if (!reader) { res.end(); return; }

    req.on("close", () => reader.cancel());

    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      const ok = res.write(Buffer.from(value));
      // back-pressure: wait for drain if buffer is full
      if (!ok) await new Promise((r) => res.once("drain", r));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Proxy error";
    if (!res.headersSent) res.status(500).json({ error: msg });
  }
});

export default router;
