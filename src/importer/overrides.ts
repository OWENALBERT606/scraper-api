import { normalizeTitle } from "./parse";

export interface GenreOverrides {
  ids: Map<string, string>;
  titles: Map<string, string>;
}

export function emptyGenreOverrides(): GenreOverrides {
  return { ids: new Map(), titles: new Map() };
}

const ID_KEY = /^(?:freewatch:|mlegacytv:|[mes]:\d+|\d+$)/i;

function put(map: Map<string, string>, key: string, value: string, normalizeKey: boolean): void {
  const k = normalizeKey ? normalizeTitle(key) : key.trim();
  const v = value.trim();
  if (k && v) map.set(k, v);
}

function readGroup(value: unknown, map: Map<string, string>, normalizeKey: boolean): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, genre] of Object.entries(value as Record<string, unknown>)) {
    if (typeof genre === "string") put(map, key, genre, normalizeKey);
  }
}

export function parseGenreOverrides(raw: string | null | undefined, label = "Genre overrides"): GenreOverrides {
  const text = (raw ?? "").trim();
  if (!text) return emptyGenreOverrides();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  const obj = value as Record<string, unknown>;
  const result = emptyGenreOverrides();
  readGroup(obj.ids, result.ids, false);
  readGroup(obj.titles, result.titles, true);
  for (const [key, genre] of Object.entries(obj)) {
    if (key === "ids" || key === "titles" || typeof genre !== "string") continue;
    put(ID_KEY.test(key) ? result.ids : result.titles, key, genre, !ID_KEY.test(key));
  }
  return result;
}

export function mergeGenreOverrides(...maps: GenreOverrides[]): GenreOverrides {
  const merged = emptyGenreOverrides();
  for (const map of maps) {
    for (const [key, genre] of map.ids) merged.ids.set(key, genre);
    for (const [key, genre] of map.titles) merged.titles.set(key, genre);
  }
  return merged;
}

export function genreOverrideFor(overrides: GenreOverrides, sourceName: string, sourceId: string, titles: (string | null | undefined)[]): string | null {
  for (const key of [`${sourceName}:${sourceId}`, sourceId]) {
    const found = overrides.ids.get(key);
    if (found) return found;
  }
  for (const title of titles) {
    const key = normalizeTitle(title ?? "");
    if (!key) continue;
    const found = overrides.titles.get(key);
    if (found) return found;
  }
  return null;
}
