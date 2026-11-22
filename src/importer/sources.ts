import { fetchDashboard, fetchMovieDetail, searchContent } from "../scrapers/freewatch";
import * as mltv from "../scrapers/mlegacytv";
import { normalizeTitle } from "./parse";

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
  /** category id -> genre name for sources that give genres as categories */
  sections(): Promise<Map<number, string>>;
}

const GENRE_BY_SECTION: Record<string, string> = {
  action: "Action",
  "sci fi": "Science Fiction",
  romance: "Romance",
  horror: "Horror",
  drama: "Drama",
  comedy: "Comedy",
  thriller: "Thriller",
  animation: "Animation",
  crime: "Crime",
  adventure: "Adventure",
  fantasy: "Fantasy",
  war: "War",
  documentary: "Documentary",
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

  /** Reads one series with every season and episode into `details`. */
  const readSeries = async (seriesId: string): Promise<void> => {
    const full = await mltv.fetchSeries(seriesId).catch(() => null);
    if (!full) return;
    full.seasons.forEach((season, si) => {
      if (season.published === false) return;
      const seasonNumber = season.order ?? (Number(/\d+/.exec(season.title)?.[0]) || si + 1);
      season.episodes.forEach((ep, ei) => {
        if (!ep.playingurl || ep.published === false) return;
        const episodeNumber = ep.order ?? ei + 1;
        details.set(`e:${ep.id}`, {
          title: `${full.title} S${seasonNumber} E${episodeNumber}`,
          vj: full.vj_name,
          playingurl: ep.playingurl,
          duration: mins(ep.runtime),
          image: ep.image || full.cover || full.image,
          description: full.overview, // the series' own description (episodes carry theirs below)
          genreName: full.genre[0] || full.category || undefined,
          year: yearOf(full.release_date),
          episode: { base: full.title, season: seasonNumber, episode: episodeNumber, title: ep.title, overview: ep.overview },
          tmdbId: numericTmdb(full.tmdb_id),
        });
      });
    });
  };


  return {
    name: "mlegacytv",
    label: "MlegacyTV",
    referer: "https://mlegacytv.com/",
    missing: () => ["MLEGACYTV_SUPABASE_URL", "MLEGACYTV_SUPABASE_KEY"].filter((k) => !(env[k] ?? "").trim()),

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
      if (known) return known;
      // a single film asked for by id ("m:<uuid>") without a full discovery
      if (id.startsWith("m:")) {
        const m = await mltv.fetchMovie(id.slice(2));
        if (!m || !m.playingurl) return null;
        return { title: m.title, vj: m.vj_name, playingurl: m.playingurl, duration: mins(m.duration), image: m.cover || m.image, description: m.overview, genreName: m.genre[0] || m.category || undefined, year: m.year, tmdbId: numericTmdb(m.tmdb_id), isFilm: true };
      }
      return null;
    },

    sections: async () => new Map<number, string>(),
  };
}

export function sourceByName(name: string | undefined): Source {
  return name === "mlegacytv" ? mlegacySource() : freewatchSource();
}
