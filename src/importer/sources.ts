import { baseKey, fetchDashboard, fetchMovieDetail, searchContent, seasonEpisode, seriesBase } from "../scrapers/freewatch";
import * as mltv from "../scrapers/mlegacytv";
import { cleanVj, normalizeTitle } from "./parse";

/** What the importer needs to know about one film or one series episode, whichever site it came from. */
export interface SourceDetail {
  title: string;
  vj?: string | null;
  playingurl?: string | null;
  size?: string | null;
  duration?: string | null;
  image?: string | null;
  description?: string | null;
  category_id?: number | string | null;
  timestamp?: string | null;
  /** a genre name the source gives directly (used when TMDB does not decide it) */
  genreName?: string;
  year?: number | null;
  /** TMDB id when the source already knows it */
  tmdbId?: string;
  /** the source says for certain that this is a film, not an episode */
  isFilm?: boolean;
  /** set when the source says exactly which series, season and episode this is (otherwise it is read from the title) */
  episode?: { base: string; season: number; episode: number; title?: string; overview?: string };
}

/** A series that already exists on the platform, with the episodes it has per season. */
export interface ExistingSeries {
  id: string;
  title: string;
  vjName: string;
  tree: Map<number, { id: string; episodes: Set<number> }>;
}

export interface Source {
  name: "freewatch" | "mlegacytv";
  label: string;
  /** sent to the video host only if it refuses a request without it */
  referer: string;
  /** names what is missing from the environment for this source (empty = ready) */
  missing(): string[];
  /** every id worth looking at, and how many entries share a group (FreeWatch only) */
  discover(note: (message: string) => void): Promise<{ ids: string[]; groupSize: Map<string, number> }>;
  detail(id: string): Promise<SourceDetail | null>;
  /** turns ids given by hand into the ids to process (e.g. a whole series into its episodes) */
  expand?(ids: string[]): Promise<string[]>;
  /** ids of episodes the source has that these existing platform series do not have yet */
  missingEpisodes?(series: ExistingSeries[], note: (message: string) => void): Promise<string[]>;
  /** category id -> genre name for sources that give genres as categories */
  sections(): Promise<Map<number, string>>;
}

const GENRE_BY_SECTION: Record<string, string> = {
  action: "Action",
  "action and adventure": "Action",
  "action adventure": "Action",
  "sci fi": "Science Fiction",
  scifi: "Science Fiction",
  "science fiction": "Science Fiction",
  romance: "Romance",
  romantic: "Romance",
  horror: "Horror",
  drama: "Drama",
  comedy: "Comedy",
  comedies: "Comedy",
  thriller: "Thriller",
  "thriller suspense": "Thriller",
  animation: "Animation",
  cartoon: "Animation",
  crime: "Crime",
  adventure: "Adventure",
  fantasy: "Fantasy",
  war: "War",
  documentary: "Documentary",
  mystery: "Mystery",
  history: "History",
  historical: "History",
  biography: "Biography",
  biopic: "Biography",
  musical: "Music",
  music: "Music",
  western: "Western",
  family: "Family",
  kids: "Family",
};

export function freewatchSource(): Source {
  return {
    name: "freewatch",
    label: "FreeWatch UG",
    referer: "https://www.freewatchug.online/",
    missing: () => [],

    async discover(note) {
      const ids = new Set<number>();
      const groupSize = new Map<string, number>();
      try {
        for (const m of (await fetchDashboard()).movies) ids.add(Number(m.id));
      } catch (e) {
        note(`The home page could not be read (${e instanceof Error ? e.message : e}); using search only`);
      }
      const terms = [..."abcdefghijklmnopqrstuvwxyz0123456789", ...(process.env.IMPORT_SEARCH_TERMS ?? "").split(",").map((t) => t.trim()).filter(Boolean)];
      for (let i = 0; i < terms.length; i += 4) {
        const batch = terms.slice(i, i + 4);
        const results = await Promise.allSettled(batch.map((t) => searchContent(t)));
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          for (const m of r.value.movies ?? []) ids.add(Number(m.id));
          for (const s of r.value.series ?? []) {
            for (const ep of s.episodes ?? []) {
              ids.add(Number(ep.id));
              groupSize.set(String(ep.id), Math.max(groupSize.get(String(ep.id)) ?? 0, s.episodes.length));
            }
          }
        }
      }
      return { ids: [...ids].filter((n) => Number.isFinite(n) && n > 0).map(String), groupSize };
    },

    async missingEpisodes(series, note) {
      const ids = new Set<string>();
      let checked = 0;
      let next = 0;
      const worker = async () => {
        for (;;) {
          const s = series[next++];
          if (!s) return;
          note(`Checking existing series for missing episodes (${++checked} of ${series.length})…`);
          try {
            const key = baseKey(s.title);
            const vjKey = normalizeTitle(cleanVj(s.vjName));
            const maxSeason = Math.max(1, ...s.tree.keys());
            const base = seriesBase(s.title) || s.title;
            // the source's search shows only a few results, so ask for the series and for each of its seasons
            const queries = [base, ...Array.from({ length: Math.min(8, maxSeason + 1) }, (_, i) => `${base} season ${i + 1}`)];
            const seen = new Set<number>();
            for (const q of queries) {
              const res = await searchContent(q).catch(() => null);
              for (const g of res?.series ?? []) {
                for (const ep of g.episodes ?? []) {
                  const title = ep.title || g.title || "";
                  if (baseKey(title) !== key || normalizeTitle(cleanVj(ep.vj)) !== vjKey) continue;
                  const [sn, en] = seasonEpisode(title);
                  if (!en || seen.has(Number(ep.id))) continue;
                  seen.add(Number(ep.id));
                  if (!s.tree.get(sn || 1)?.episodes.has(en)) ids.add(String(ep.id));
                }
              }
            }
          } catch {
            /* this series is checked again on the next run */
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      return [...ids];
    },

    detail: (id) => fetchMovieDetail(id),

    async sections() {
      const map = new Map<number, string>();
      try {
        for (const s of (await fetchDashboard()).sections) {
          const g = GENRE_BY_SECTION[normalizeTitle(s.category)];
          if (g) map.set(s.id, g);
        }
      } catch {
        /* genres then come from the metadata match alone */
      }
      return map;
    },
  };
}

const yearOf = (iso: string | null | undefined): number | null => {
  const y = Number((iso ?? "").slice(0, 4));
  return y >= 1900 && y <= 2100 ? y : null;
};
/** MlegacyTV gives a bare number of minutes ("106"); the importer reads a bare number as seconds */
const mins = (d: string | undefined): string => (d && /^\d{1,3}$/.test(d.trim()) ? `${d.trim()} min` : d ?? "");
const numericTmdb = (v: string | undefined): string | undefined => (v && /^\d+$/.test(v.trim()) ? v.trim() : undefined);

/** MlegacyTV: a Supabase-backed catalogue that lists every film and every series with all of its seasons and episodes. */
export function mlegacySource(env: NodeJS.ProcessEnv = process.env): Source {
  // filled while discovering, so reading a detail later needs no further request
  const details = new Map<string, SourceDetail>();

  /** Every usable episode of a series, with the numbers and detail the importer needs. */
  const seriesEpisodes = (full: mltv.MLTVSeriesDetail) => {
    const out: { id: string; season: number; episode: number; detail: SourceDetail }[] = [];
    full.seasons.forEach((season, si) => {
      if (season.published === false) return;
      const seasonNumber = season.order ?? (Number(/\d+/.exec(season.title)?.[0]) || si + 1);
      season.episodes.forEach((ep, ei) => {
        if (!ep.playingurl || ep.published === false) return;
        const episodeNumber = ep.order ?? ei + 1;
        out.push({
          id: `e:${ep.id}`,
          season: seasonNumber,
          episode: episodeNumber,
          detail: {
            title: `${full.title} S${seasonNumber} E${episodeNumber}`,
            vj: full.vj_name,
            playingurl: ep.playingurl,
            duration: mins(ep.runtime),
            image: ep.image || full.cover || full.image,
            description: full.overview,
            genreName: full.genre?.[0] || full.category || undefined,
            year: yearOf(full.release_date),
            episode: { base: full.title, season: seasonNumber, episode: episodeNumber, title: ep.title, overview: ep.overview },
            tmdbId: numericTmdb(full.tmdb_id),
          },
        });
      });
    });
    return out;
  };

  /** Reads one series with every season and episode into `details`. */
  const readSeries = async (seriesId: string): Promise<void> => {
    const full = await mltv.fetchSeries(seriesId).catch(() => null);
    if (!full) return;
    for (const ep of seriesEpisodes(full)) details.set(ep.id, ep.detail);
  };


  return {
    name: "mlegacytv",
    label: "MlegacyTV",
    referer: "https://mlegacytv.com/",
    missing: () => [
      "MLEGACYTV_SUPABASE_URL",
      "MLEGACYTV_SUPABASE_KEY",
      ...mltv.playbackCredentialsMissing(),
    ].filter((k) => !(env[k] ?? "").trim()),

    async discover(note) {
      details.clear();
      const PAGE = 1000;

      // films
      for (let offset = 0; ; offset += PAGE) {
        const page = await mltv.fetchCatalog({ type: "movies", limit: PAGE, offset });
        for (const m of page.movies) {
          if (!m.playingurl) continue;
          details.set(`m:${m.id}`, {
            title: m.title,
            vj: m.vj_name,
            playingurl: m.playingurl,
            duration: mins(m.duration),
            image: m.cover || m.image,
            description: m.overview,
            genreName: m.genre[0] || m.category || undefined,
            year: m.year,
            tmdbId: numericTmdb(m.tmdb_id),
            isFilm: true,
          });
        }
        note(`Reading MlegacyTV films… ${details.size} found`);
        if (page.movies.length < PAGE) break;
      }

      // series: every season and episode
      const seriesList: mltv.MLTVSeries[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await mltv.fetchCatalog({ type: "series", limit: PAGE, offset });
        seriesList.push(...page.series);
        if (page.series.length < PAGE) break;
      }
      let done = 0;
      let next = 0;
      const worker = async () => {
        for (;;) {
          const s = seriesList[next++];
          if (!s) return;
          note(`Reading MlegacyTV series… ${++done} of ${seriesList.length}`);
          await readSeries(s.id);
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      return { ids: [...details.keys()], groupSize: new Map() };
    },

    async missingEpisodes(series, note) {
      const keyOf = (title: string, vj: string) => `${normalizeTitle(title)}|${normalizeTitle(cleanVj(vj))}`;
      const byKey = new Map<string, mltv.MLTVSeries[]>();
      const PAGE = 1000;
      for (let offset = 0; ; offset += PAGE) {
        const page = await mltv.fetchCatalog({ type: "series", limit: PAGE, offset });
        for (const s of page.series) {
          const key = keyOf(s.title, s.vj_name);
          const list = byKey.get(key) ?? [];
          list.push(s);
          byKey.set(key, list);
        }
        if (page.series.length < PAGE) break;
      }

      const ids = new Set<string>();
      let checked = 0;
      let next = 0;
      const worker = async () => {
        for (;;) {
          const existing = series[next++];
          if (!existing) return;
          note(`Checking existing series for missing episodes (${++checked} of ${series.length})…`);
          for (const candidate of byKey.get(keyOf(existing.title, existing.vjName)) ?? []) {
            const full = await mltv.fetchSeries(candidate.id).catch(() => null);
            if (!full) continue;
            for (const ep of seriesEpisodes(full)) {
              details.set(ep.id, ep.detail);
              if (!existing.tree.get(ep.season)?.episodes.has(ep.episode)) ids.add(ep.id);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      return [...ids];
    },

    async expand(ids) {
      const out: string[] = [];
      for (const id of ids) {
        if (id.startsWith("s:")) {
          const before = new Set(details.keys());
          await readSeries(id.slice(2));
          out.push(...[...details.keys()].filter((k) => !before.has(k) && k.startsWith("e:")));
        } else out.push(id);
      }
      return out;
    },

    async detail(id) {
      const known = details.get(id);
      if (known) return { ...known, playingurl: await mltv.resolvePlaybackUrl(known.playingurl) };
      // a single film asked for by id ("m:<uuid>") without a full discovery
      if (id.startsWith("m:")) {
        const m = await mltv.fetchMovie(id.slice(2));
        if (!m || !m.playingurl) return null;
        return { title: m.title, vj: m.vj_name, playingurl: await mltv.resolvePlaybackUrl(m.playingurl), duration: mins(m.duration), image: m.cover || m.image, description: m.overview, genreName: m.genre[0] || m.category || undefined, year: m.year, tmdbId: numericTmdb(m.tmdb_id), isFilm: true };
      }
      return null;
    },

    sections: async () => new Map<number, string>(),
  };
}

export function sourceByName(name: string | undefined): Source {
  return name === "mlegacytv" ? mlegacySource() : freewatchSource();
}
