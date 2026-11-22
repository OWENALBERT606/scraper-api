import { DeleteObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable, Transform } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import type { ImportConfig } from "./config";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

/**
 * FreeWatch's video CDN (Bunny) answers 403 to a request that carries the FreeWatch Referer, yet serves the same file to one
 * without it; a few hosts want the Referer. So ask without it first and with it only if that is refused.
 */
async function openSource(url: string, signal?: AbortSignal, referer = "https://www.freewatchug.online/"): Promise<Response> {
  const plain = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal });
  if (plain.ok || (plain.status !== 403 && plain.status !== 401)) return plain;
  await plain.body?.cancel().catch(() => undefined);
  return fetch(url, { headers: { "User-Agent": USER_AGENT, Referer: referer }, signal });
}

export interface Copied {
  key: string;
  bytes: number;
}

/** Streams a video straight from its source into Backblaze B2: nothing is kept in memory or written to disk. */
export class B2Store {
  private _client: S3Client | null = null;

  constructor(private cfg: ImportConfig) {}

  /** Built on first use, so a server with no B2 settings (link mode, or still being set up) starts without it. */
  private get client(): S3Client {
    return (this._client ??= new S3Client({
      region: this.cfg.b2.region,
      endpoint: this.cfg.b2.endpoint,
      credentials: { accessKeyId: this.cfg.b2.keyId, secretAccessKey: this.cfg.b2.appKey },
      // B2's S3 API does not take the extra checksum headers newer SDK versions add by default
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }));
  }

  /**
   * Downloads `sourceUrl` and uploads it as `key` (multipart, 16 MB parts) while it arrives. The upload is checked against
   * the size announced by the source and against what B2 reports afterwards; on any failure the partial object is removed.
   */
  async copy(sourceUrl: string, key: string, onProgress: (bytes: number, total: number) => void, signal?: AbortSignal, referer?: string): Promise<Copied> {
    const res = await openSource(sourceUrl, signal, referer).catch((e: unknown) => {
      // "fetch failed" says nothing: name the video server and the reason (name not found, refused, timed out)
      const cause = (e as { cause?: { code?: string } })?.cause?.code;
      let host = "the video server";
      try {
        host = new URL(sourceUrl).host;
      } catch {
        /* keep the generic name */
      }
      if (cause === "ENOTFOUND") throw new Error(`The video server ${host} does not exist any more (its name cannot be found)`);
      if (cause) throw new Error(`The video server ${host} could not be reached (${cause})`);
      throw e;
    });
    if (!res.ok || !res.body) throw new Error(`The source answered HTTP ${res.status}`);
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (type.startsWith("text/") || type.includes("json")) throw new Error(`The source returned ${type}, not a video`);
    const total = Number(res.headers.get("content-length") || 0);
    if (total > 0 && total < this.cfg.minBytes) throw new Error(`The source file is only ${total} bytes: too small to be a film`);

    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        onProgress(bytes, total);
        cb(null, chunk);
      },
    });
    const body = Readable.fromWeb(res.body as unknown as NodeReadableStream).pipe(counter);

    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.cfg.b2.bucket, Key: key, Body: body, ContentType: "video/mp4" },
      queueSize: 3,
      partSize: 16 * 1024 * 1024,
      leavePartsOnError: false,
    });
    signal?.addEventListener("abort", () => void upload.abort());

    try {
      await upload.done();
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.b2.bucket, Key: key }));
      const stored = Number(head.ContentLength ?? 0);
      if (stored !== bytes) throw new Error(`B2 stored ${stored} bytes but ${bytes} were sent`);
      if (total > 0 && bytes !== total) throw new Error(`Only ${bytes} of ${total} bytes arrived from the source`);
      if (bytes < this.cfg.minBytes) throw new Error(`The file is only ${bytes} bytes: too small to be a film`);
      return { key, bytes };
    } catch (e) {
      await this.remove(key).catch(() => undefined);
      throw e;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.b2.bucket, Key: key }));
  }
}
