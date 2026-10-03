import { create } from 'zustand';

import { clearAllLyrics, deleteLyrics, loadLyrics, saveLyrics } from './persistence/lyricsTable';

import { getLyricsForTrack, type LyricsData } from '../services/subsonicService';
import { withTimeout } from '../utils/withTimeout';

/** Hard budget for a single lyrics fetch (OpenSubsonic + classic fallback). */
const FETCH_TIMEOUT_MS = 15_000;

export type LyricsErrorKind = 'timeout' | 'error';

interface LyricsState {
  /** Session cache indexed by track ID. NOT persisted — the `lyrics` table is. */
  entries: Record<string, LyricsData>;
  /** Per-track loading flags. */
  loading: Record<string, boolean>;
  /** Per-track error flags. Set when the last fetch failed. */
  errors: Record<string, LyricsErrorKind>;
  /** Bumped on every table mutation so SQL-derived views (the counts card) re-read. */
  revision: number;
  /** Resolve lyrics for a track: memory, then the table, then the network. */
  fetchLyrics: (
    trackId: string,
    artist?: string,
    title?: string,
    signal?: AbortSignal,
    background?: boolean,
  ) => Promise<LyricsData | null>;
  /**
   * Refetch from the server, consulting neither cache, and overwrite the stored row.
   * A server that now returns nothing leaves the existing row alone.
   */
  refreshLyrics: (
    trackId: string,
    artist?: string,
    title?: string,
    signal?: AbortSignal,
  ) => Promise<LyricsData | null>;
  /** Register queued work so lyric deletion can cancel it before it starts. */
  prepareFetch: (trackId: string, signal: AbortSignal) => { signal: AbortSignal; dispose: () => void };
  /** Cancel one track's pending fetches, or all fetches before account teardown. */
  invalidatePendingFetches: (trackId?: string) => void;
  /** Drop one song's cached lyrics, in memory and on disk. */
  removeLyrics: (trackId: string) => Promise<void>;
  /** Clear all cached lyrics, in memory and on disk. */
  clearLyrics: () => Promise<void>;
}

export const lyricsStore = create<LyricsState>()((set, get) => {
  const pendingFetches = new Map<AbortController, string>();
  const beginFetch = (trackId: string, signal?: AbortSignal) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    pendingFetches.set(controller, trackId);
    return {
      controller,
      finish: () => {
        signal?.removeEventListener('abort', cancel);
        pendingFetches.delete(controller);
      },
    };
  };
  const loadingFetches = new Map<string, AbortController>();
  const beginLoad = (trackId: string, controller: AbortController) => {
    loadingFetches.set(trackId, controller);
    set({
      loading: { ...get().loading, [trackId]: true },
      errors: (() => {
        const { [trackId]: _, ...rest } = get().errors;
        return rest;
      })(),
    });
  };
  const clearLoading = (trackId: string) => {
    const { [trackId]: _, ...rest } = get().loading;
    set({ loading: rest });
  };
  const setError = (trackId: string, kind: LyricsErrorKind) => {
    set({ errors: { ...get().errors, [trackId]: kind } });
  };
  const remember = (trackId: string, data: LyricsData) => {
    set({ entries: { ...get().entries, [trackId]: data }, revision: get().revision + 1 });
  };

  /**
   * Save network results to SQL. Foreground callers also warm the player cache;
   * background downloads leave lyrics on disk until the player requests them.
   */
  const fetchFromServer = async (
    controller: AbortController,
    trackId: string,
    artist?: string,
    title?: string,
    foreground = true,
  ): Promise<LyricsData | null> => {
    const network = new AbortController();
    const cancel = () => network.abort();
    controller.signal.addEventListener('abort', cancel, { once: true });
    if (controller.signal.aborted) cancel();
    let result: LyricsData | null | 'timeout';
    try {
      result = await withTimeout(async (signal) => {
        signal.addEventListener('abort', cancel, { once: true });
        try {
          return await getLyricsForTrack(trackId, artist, title, network.signal);
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      }, FETCH_TIMEOUT_MS);
    } finally {
      controller.signal.removeEventListener('abort', cancel);
    }

    if (controller.signal.aborted) return null;
    if (result === 'timeout') {
      if (foreground) setError(trackId, 'timeout');
      return null;
    }

    // Well-defined "no lyrics for this track" case. No entry, no error, no row.
    if (result === null) return null;

    await saveLyrics(trackId, result, title, artist);
    if (controller.signal.aborted) return null;
    if (foreground) remember(trackId, result);
    else set({ revision: get().revision + 1 });
    return result;
  };

  return {
    entries: {},
    loading: {},
    errors: {},
    revision: 0,

    fetchLyrics: async (trackId, artist, title, signal, background = false) => {
      const cached = get().entries[trackId];
      if (cached) return cached;

      const { controller, finish } = beginFetch(trackId, signal);
      if (!background) beginLoad(trackId, controller);
      try {
        const stored = await loadLyrics(trackId);
        if (controller.signal.aborted) return null;
        if (stored !== null) {
          if (!background) remember(trackId, stored);
          return stored;
        }
        return await fetchFromServer(controller, trackId, artist, title, !background);
      } catch {
        if (!background && !controller.signal.aborted) setError(trackId, 'error');
        return null;
      } finally {
        if (loadingFetches.get(trackId) === controller) {
          loadingFetches.delete(trackId);
          clearLoading(trackId);
        }
        finish();
      }
    },

    refreshLyrics: async (trackId, artist, title, signal) => {
      const { controller, finish } = beginFetch(trackId, signal);
      beginLoad(trackId, controller);
      try {
        return await fetchFromServer(controller, trackId, artist, title);
      } catch {
        if (!controller.signal.aborted) setError(trackId, 'error');
        return null;
      } finally {
        if (loadingFetches.get(trackId) === controller) {
          loadingFetches.delete(trackId);
          clearLoading(trackId);
        }
        finish();
      }
    },

    prepareFetch: (trackId, signal) => {
      const { controller, finish } = beginFetch(trackId, signal);
      return { signal: controller.signal, dispose: finish };
    },

    invalidatePendingFetches: (trackId) => {
      for (const [controller, id] of pendingFetches) {
        if (trackId === undefined || trackId === id) controller.abort();
      }
      const loading = { ...get().loading };
      if (trackId === undefined) set({ loading: {} });
      else {
        delete loading[trackId];
        set({ loading });
      }
    },

    removeLyrics: async (trackId) => {
      get().invalidatePendingFetches(trackId);
      const { [trackId]: _, ...entries } = get().entries;
      set({ entries, revision: get().revision + 1 });
      await deleteLyrics(trackId);
    },

    clearLyrics: async () => {
      get().invalidatePendingFetches();
      set({ entries: {}, loading: {}, errors: {}, revision: get().revision + 1 });
      await clearAllLyrics();
    },
  };
});
