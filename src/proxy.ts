import { Router, Request, Response } from "express";

const router = Router();

// Resolved at request-time from the incoming host header
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
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
}

// Rewrite a .m3u8 playlist so every segment URL goes through our proxy
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

router.options("/", (_req, res) => { addCors(res); res.sendStatus(204); });

router.get("/", async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) { res.status(400).json({ error: "url param required" }); return; }

  // Only allow backblaze / tulabe CDN origins
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
    const parsed = new URL(decoded);
    const allowed = ["f006.backblazeb2.com", "cdn.tulabe.com"];
    if (!allowed.some((h) => parsed.hostname.endsWith(h))) {
      res.status(403).json({ error: "Host not allowed" });
      return;
    }
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  try {
    const upstream = await fetch(decoded);
    if (!upstream.ok) {
      res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
      return;
    }

    addCors(res);

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const isPlaylist  = decoded.includes(".m3u8") || contentType.includes("mpegurl");

    if (isPlaylist) {
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, decoded, proxyBase(req));
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(rewritten);
    } else {
      // Stream binary (image, .ts segment, etc.)
      res.setHeader("Content-Type", contentType);
      const cl = upstream.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);

      const reader = upstream.body?.getReader();
      if (!reader) { res.end(); return; }

      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          res.write(Buffer.from(value));
        }
      };
      await pump();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Proxy error";
    if (!res.headersSent) res.status(500).json({ error: msg });
  }
});

export default router;
