import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import {
  fetchMovieDetail,
  fetchSeries,
  FWEpisode,
  FWMovieDetail,
} from "./scrapers/freewatch";

export type UploadStatus = "queued" | "downloading" | "uploading" | "done" | "failed";

export type UploadMetadata = Record<string, unknown> & {
  title: string;
  vj: string;
};

export interface UploadRequest {
  id?: number | string;
  seriesCode?: number | string;
  streamUrl?: string;
  title?: string;
  vj?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

export interface UploadJob {
  id: string;
  status: UploadStatus;
  createdAt: string;
  updatedAt: string;
  streamUrl: string;
  filename: string;
  metadata: UploadMetadata;
  bytes: number;
  total: number;
  attempts: number;
  responseStatus?: number;
  responseBody?: string;
  error?: string;
  downloadPath?: string;
}

export interface UploaderStatus {
  configured: boolean;
  schedulerRunning: boolean;
  processing: boolean;
  counts: Record<UploadStatus, number>;
  jobs: UploadJob[];
}

interface UploaderConfig {
  apiUrl: string;
  apiMethod: string;
  headers: Record<string, string>;
  videoField: string;
  metadataField: string;
  flatFields: string[];
  downloadDir: string;
  autoStart: boolean;
  intervalMs: number;
  keepFiles: boolean;
  timeoutMs: number;
  retries: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

function envHeaders(): Record<string, string> {
  const raw = process.env.UPLOAD_API_HEADERS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function buildConfig(): UploaderConfig {
  const headers = envHeaders();
  const token = process.env.UPLOAD_API_TOKEN;
  if (token && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${token}`;
  }

  return {
    apiUrl: process.env.UPLOAD_API_URL ?? "",
    apiMethod: (process.env.UPLOAD_API_METHOD ?? "POST").toUpperCase(),
    headers,
    videoField: process.env.UPLOAD_FIELD_VIDEO ?? "video",
    metadataField: process.env.UPLOAD_FIELD_METADATA ?? "metadata",
    flatFields: (process.env.UPLOAD_FLAT_FIELDS ??
      "id,title,vj,description,image,poster_url,duration,size,series_code,category_id,is_series,playingurl")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean),
    downloadDir: process.env.UPLOAD_DOWNLOAD_DIR ?? path.join(process.cwd(), "downloads"),
    autoStart: envBool("UPLOAD_AUTOSTART", true),
    intervalMs: envInt("UPLOAD_INTERVAL_MS", 60_000),
    keepFiles: envBool("UPLOAD_KEEP_FILES", false),
    timeoutMs: envInt("UPLOAD_TIMEOUT_MS", 0),
    retries: Math.max(1, envInt("UPLOAD_RETRIES", 2)),
  };
}

const config = buildConfig();
const jobs = new Map<string, UploadJob>();
let sequence = 0;
let processing = false;
let timer: ReturnType<typeof setInterval> | null = null;

function now(): string {
  return new Date().toISOString();
}

function safeName(value: string): string {
  return (
    (value || "video")
      .replace(/[^\w.\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 120) || "video"
  );
}

function extensionFromUrl(url: string): string {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m3u8"].includes(ext) ? ext : ".mp4";
  } catch {
    return ".mp4";
  }
}

function jobFilename(metadata: UploadMetadata, streamUrl: string): string {
  const title = safeName(String(metadata.title ?? "video"));
  return `${title}${extensionFromUrl(streamUrl)}`;
}

function detailMetadata(detail: FWMovieDetail, overrides: UploadRequest): UploadMetadata {
  return {
    id: detail.id,
    source_id: detail.id,
    title: detail.title || overrides.title || "",
    vj: detail.vj || overrides.vj || "",
    description: detail.description || "",
    image: detail.image || "",
    poster_url: detail.image || "",
    duration: detail.duration || "",
    size: detail.size || "",
    series_code: detail.series_code || "",
    category_id: detail.category_id || "",
    type: detail.type || "",
    is_series: detail.is_series ?? false,
    timestamp: detail.timestamp || "",
    playingurl: detail.playingurl || "",
    ...(overrides.metadata ?? {}),
  };
}

function episodeMetadata(episode: FWEpisode, seriesTitle: string): UploadMetadata {
  return {
    id: episode.id,
    source_id: episode.id,
    title: episode.title || seriesTitle || "",
    vj: episode.vj || "",
    description: "",
    image: episode.image || "",
    poster_url: episode.image || "",
    duration: "",
    size: episode.size || "",
    series_code: episode.series_code || "",
    category_id: episode.category_id || "",
    type: episode.type || "",
    is_series: true,
    playingurl: episode.playingurl || "",
  };
}

function urlBasename(streamUrl: string): string {
  try {
    return path.basename(new URL(streamUrl).pathname);
  } catch {
    return "video";
  }
}

function explicitMetadata(request: UploadRequest): UploadMetadata {
  const streamUrl = request.streamUrl ?? "";
  return {
    id: request.id ?? "",
    source_id: request.id ?? "",
    title: request.title || safeName(urlBasename(streamUrl)),
    vj: request.vj || "",
    stream_url: streamUrl,
    playingurl: streamUrl,
    ...(request.metadata ?? {}),
  };
}

function createJob(streamUrl: string, metadata: UploadMetadata, requestedFilename?: string): UploadJob {
  const id = `${Date.now()}-${++sequence}`;
  const timestamp = now();
  return {
    id,
    status: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    streamUrl,
    filename: requestedFilename ? safeName(requestedFilename) : jobFilename(metadata, streamUrl),
    metadata,
    bytes: 0,
    total: 0,
    attempts: 0,
  };
}

export function isUploadConfigured(): boolean {
  return Boolean(config.apiUrl);
}

export async function enqueueUploads(requests: UploadRequest[]): Promise<UploadJob[]> {
  const created: UploadJob[] = [];

  for (const request of requests) {
    if (request.seriesCode !== undefined && request.seriesCode !== null && request.seriesCode !== "") {
      const series = await fetchSeries(request.seriesCode);
      if (series.episodes.length === 0) {
        throw new Error(`No episodes found for series ${request.seriesCode}`);
      }
      for (const episode of series.episodes) {
        if (!episode.playingurl) continue;
        created.push(createJob(episode.playingurl, episodeMetadata(episode, series.base_name)));
      }
      continue;
    }

    if (request.id !== undefined && request.id !== null && request.id !== "") {
      const detail = await fetchMovieDetail(request.id);
      const streamUrl = detail.playingurl || request.streamUrl || "";
      if (!streamUrl) throw new Error(`No stream URL for item ${request.id}`);
      created.push(createJob(streamUrl, detailMetadata(detail, request), request.filename));
      continue;
    }

    if (!request.streamUrl || typeof request.streamUrl !== "string") {
      throw new Error("Each item needs id, seriesCode, or streamUrl");
    }
    try {
      new URL(request.streamUrl);
    } catch {
      throw new Error(`Invalid streamUrl: ${request.streamUrl}`);
    }
    created.push(createJob(request.streamUrl, explicitMetadata(request), request.filename));
  }

  for (const job of created) jobs.set(job.id, job);
  return created;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadHeaders(): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    Referer: "https://www.freewatchug.online/",
  };
}

async function downloadFile(job: UploadJob): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= config.retries; attempt++) {
    job.attempts = attempt;
    const partPath = path.join(config.downloadDir, `${job.id}.part`);
    let fileStream: fs.WriteStream | null = null;

    try {
      const response = await fetch(job.streamUrl, { headers: downloadHeaders() });
      if (!response.ok || !response.body) {
        throw new Error(`Download failed with HTTP ${response.status}`);
      }

      job.total = Number(response.headers.get("content-length") ?? 0) || 0;
      job.bytes = 0;

      fileStream = fs.createWriteStream(partPath);
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          job.bytes += chunk.length;
          callback(null, chunk);
        },
      });

      await pipeline(
        Readable.fromWeb(response.body as unknown as NodeReadableStream),
        counter,
        fileStream
      );

      const finalPath = path.join(config.downloadDir, `${job.id}-${job.filename}`);
      await fsp.rename(partPath, finalPath);
      job.downloadPath = finalPath;
      return finalPath;
    } catch (err) {
      await fsp.unlink(partPath).catch(() => undefined);
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < config.retries) await delay(1000 * attempt);
    } finally {
      fileStream?.destroy();
    }
  }

  throw lastError ?? new Error("Download failed");
}

async function uploadFile(job: UploadJob, filePath: string): Promise<{ status: number; body: string }> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= config.retries; attempt++) {
    job.attempts = attempt;
    const controller = new AbortController();
    const timeout = config.timeoutMs > 0 ? setTimeout(() => controller.abort(), config.timeoutMs) : null;

    try {
      const bytes = await fsp.readFile(filePath);
      const form = new FormData();

      form.append(
        config.videoField,
        new Blob([bytes], { type: "video/mp4" }),
        job.filename
      );

      if (config.metadataField) {
        form.append(config.metadataField, JSON.stringify(job.metadata));
      }

      for (const field of config.flatFields) {
        const value = job.metadata[field];
        if (value === undefined || value === null) continue;
        form.append(field, typeof value === "object" ? JSON.stringify(value) : String(value));
      }

      const response = await fetch(config.apiUrl, {
        method: config.apiMethod,
        headers: config.headers,
        body: form,
        signal: controller.signal,
      });

      const body = (await response.text()).slice(0, 2000);
      if (!response.ok) {
        throw new Error(`Upload failed with HTTP ${response.status}: ${body}`);
      }
      return { status: response.status, body };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < config.retries) await delay(1000 * attempt);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("Upload failed");
}

async function processJob(job: UploadJob): Promise<void> {
  try {
    job.status = "downloading";
    job.updatedAt = now();
    const filePath = await downloadFile(job);

    job.status = "uploading";
    job.updatedAt = now();
    const result = await uploadFile(job, filePath);
    job.responseStatus = result.status;
    job.responseBody = result.body;

    job.status = "done";
    if (!config.keepFiles) {
      await fsp.unlink(filePath).catch(() => undefined);
      job.downloadPath = undefined;
    }
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    job.updatedAt = now();
  }
}

export async function drainUploadQueue(): Promise<number> {
  if (processing || !isUploadConfigured()) return 0;
  processing = true;
  let handled = 0;

  try {
    await fsp.mkdir(config.downloadDir, { recursive: true });
    for (const job of jobs.values()) {
      if (job.status === "queued") {
        await processJob(job);
        handled++;
      }
    }
  } catch (err) {
    console.error("[uploader] queue drain failed:", err);
  } finally {
    processing = false;
  }

  return handled;
}

export function startUploadScheduler(): void {
  if (!isUploadConfigured()) {
    console.warn("[uploader] UPLOAD_API_URL is not set — upload endpoints will return 503");
    return;
  }
  if (timer) return;

  if (config.autoStart) void drainUploadQueue();
  if (config.intervalMs > 0) {
    timer = setInterval(() => void drainUploadQueue(), config.intervalMs);
    timer.unref?.();
  }
}

export function stopUploadScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function getUploaderStatus(): UploaderStatus {
  const counts: Record<UploadStatus, number> = {
    queued: 0,
    downloading: 0,
    uploading: 0,
    done: 0,
    failed: 0,
  };
  for (const job of jobs.values()) counts[job.status]++;

  return {
    configured: isUploadConfigured(),
    schedulerRunning: timer !== null,
    processing,
    counts,
    jobs: Array.from(jobs.values()),
  };
}
