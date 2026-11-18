/**
 * Pure helpers for the importer: cleaning titles and VJ names, working out sizes and lengths, telling a film from a
 * series episode, and deciding whether a TMDB search result is really the same film. No network, no files, so they can
 * be tested on their own.
 */

/** Lower case, accents and punctuation removed, "the" dropped: the form two spellings of one title share. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the\s+/, "")
    .trim();
}

/** "Hope VJ Junior (2026)" -> { title: "Hope", year: 2026 }. VJ names and site tags are stripped from the title. */
export function cleanTitle(raw: string): { title: string; year: number | null } {
  let t = (raw || "").replace(/\[[^\]]*\]/g, " ").replace(/_/g, " ");
  let year: number | null = null;
  const y = /[(\[\s](19\d{2}|20\d{2})[)\]\s]*$/.exec(t.trim());
  if (y) {
    year = Number(y[1]);
    t = t.trim().slice(0, y.index);
  }
  // a trailing "VJ Name" that some uploads put in the title itself
  t = t.replace(/\b(translated\s+)?by\s+vj\s+[\w .'-]+$/i, " ").replace(/\bvj\s+[\w'-]+(\s+[\w'-]+)?\s*$/i, " ");
  t = t.replace(/\s+/g, " ").replace(/[\s:–—-]+$/, "").trim();
  return { title: t, year };
}

/** " " or "Vj Emmy" / "VJ EMMY" -> "VJ Emmy"-style display name without the prefix, or "" when there is none. */
export function cleanVj(raw: string | null | undefined): string {
  const v = (raw || "").replace(/\s+/g, " ").trim();
  if (!v) return "";
  return v.replace(/^vj\s+/i, "").trim();
}

/** "01h 21m" / "1h 32m" / "95 min" / "5700" -> seconds (0 when it cannot be read). */
export function durationToSeconds(raw: string | number | null | undefined): number {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
  const s = (raw || "").toString().toLowerCase().trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const h = /(\d+)\s*h/.exec(s);
  const m = /(\d+)\s*m/.exec(s);
  const sec = /(\d+)\s*s\b/.exec(s);
  const total = (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0) + (sec ? Number(sec[1]) : 0);
  return total;
}

/** 5700 -> "1h 35m" (the format the platform shows) */
export function secondsToLength(sec: number): string {
  if (!sec || sec <= 0) return "";
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`;
}

/** "695.07 MB" / "1.1 GB" -> bytes (0 when it cannot be read) */
export function sizeToBytes(raw: string | null | undefined): number {
  const m = /([\d.]+)\s*(b|kb|mb|gb|tb)/i.exec((raw || "").trim());
  if (!m) return 0;
  const mult: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Math.round(Number(m[1]) * mult[m[2].toLowerCase()]);
}

/** 1181116006 -> "1.1 GB" */
export function bytesToSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(2).replace(/\.?0+$/, "")} ${units[i]}`;
}

const SERIES_MARKER = /\b(season|series|episode|eps?\.?)\s*[:#]?\s*\d+|\bs\d{1,2}\s*[. _-]?\s*e\d{1,3}\b|\bepisode\b|\bseason\b|\bpart\s*\d+\s*of\b/i;

/**
 * FreeWatch files every title, film or series, under a "series code". A film is a one-episode group whose title has no
 * season or episode wording. Anything unclear is treated as NOT a film, so it is skipped rather than imported wrongly.
 */
export function looksLikeFilm(title: string, episodesInGroup: number): boolean {
  if (!title.trim()) return false;
  if (episodesInGroup > 1) return false;
  return !SERIES_MARKER.test(title);
}

/** File ending of a stream address, lower case, without the dot ("" when none). */
export function extensionOf(url: string): string {
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(decodeURIComponent(new URL(url).pathname));
    return m ? m[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

/** A name safe to use inside an object key: letters, digits and a few separators. */
export function safeKeyPart(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9._ -]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "movie"
  );
}

export interface TmdbHit {
  tmdbId: number | string | null;
  title: string;
  year: string | number | null;
}

/**
 * Picks the TMDB result that really is this film: the same normalised title, and, when we know the year, the same year
 * (one year either side is allowed). Returns null rather than guessing, so a wrong film's poster and cast never end up
 * on the wrong title.
 */
export function bestTmdbMatch(title: string, year: number | null, hits: TmdbHit[]): TmdbHit | null {
  const want = normalizeTitle(title);
  const exact = hits.filter((h) => h.tmdbId && normalizeTitle(h.title) === want);
  if (exact.length === 0) return null;
  if (year) {
    const sameYear = exact.find((h) => Math.abs(Number(h.year) - year) <= 1);
    if (sameYear) return sameYear;
    // the year we have came from a source that can be wrong: only accept an exact title when there is a single candidate
    return exact.length === 1 ? exact[0] : null;
  }
  return exact[0];
}
