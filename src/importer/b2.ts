import { DeleteObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable, Transform } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import type { ImportConfig } from "./config";

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
  Referer: "https://www.freewatchug.online/",
};

export interface Copied {
  key: string;
  bytes: number;
}

/** Streams a video straight from its source into Backblaze B2: nothing is kept in memory or written to disk. */
export class B2Store {
  private client: S3Client;

  constructor(private cfg: ImportConfig) {
    this.client = new S3Client({
      region: cfg.b2.region,
      endpoint: cfg.b2.endpoint,
      credentials: { accessKeyId: cfg.b2.keyId, secretAccessKey: cfg.b2.appKey },
      // B2's S3 API does not take the extra checksum headers newer SDK versions add by default
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  /**
   * Downloads `sourceUrl` and uploads it as `key` (multipart, 16 MB parts) while it arrives. The upload is checked against
   * the size announced by the source and against what B2 reports afterwards; on any failure the partial object is removed.
   */
  async copy(sourceUrl: string, key: string, onProgress: (bytes: number, total: number) => void, signal?: AbortSignal): Promise<Copied> {
    const res = await fetch(sourceUrl, { headers: BROWSER_HEADERS, signal });
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
