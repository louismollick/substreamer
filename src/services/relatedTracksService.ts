import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { getSongEnvelope, musicCacheStore } from '../store/musicCacheStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { shuffleArray } from '../utils/arrayHelpers';
import {
  getRandomSongs,
  getRandomSongsFiltered,
  getSimilarSongs,
  getSimilarSongs2,
  getTopSongs,
} from './subsonicService';

import type { Child } from './subsonicService';

async function safely(load: () => Promise<Child[] | null>): Promise<Child[]> {
  try {
    return (await load()) ?? [];
  } catch {
    // Recommendations are best-effort; the next fallback source may still fill the batch.
    return [];
  }
}

function sourceGenre(source: Child): string | undefined {
  return source.genre ?? source.genres?.[0];
}

function downloadedSongs(): Child[] {
  return Object.keys(musicCacheStore.getState().cachedSongs)
    .map((id) => getSongEnvelope(id))
    .filter((song): song is Child => song !== null);
}

function onlineRecommendationSources(
  source: Child,
  target: number,
): Array<() => Promise<Child[] | null>> {
  const sources: Array<() => Promise<Child[] | null>> = [
    () => getSimilarSongs(source.id, target),
  ];
  if (source.artistId) {
    const artistId = source.artistId;
    sources.push(() => getSimilarSongs2(artistId, target));
  }
  const genre = sourceGenre(source);
  if (genre) {
    sources.push(() => getRandomSongsFiltered({ size: target * 2, genre }));
  }
  if (source.artist) {
    const artist = source.artist;
    sources.push(() => getTopSongs(artist, target));
  }
  return sources;
}

/**
 * Build a "more like this" play queue for a given source song.
 *
 * Many Subsonic servers (Navidrome in particular) lean on last.fm
 * metadata for `getSimilarSongs`, so the result is often just 2-3 tracks
 * for less-popular artists — way short of the user's list-length setting.
 * To keep the queue useful we top up via a layered fallback chain,
 * stopping as soon as we reach the target:
 *
 *   1. `getSimilarSongs(id)`          — per-song similarity (highest signal)
 *   2. `getSimilarSongs2(artistId)`   — artist-level similarity
 *   3. `getRandomSongsFiltered(genre)`— same-genre random
 *   4. `getTopSongs(artist)`          — same artist's top tracks
 *
 * Each layer is deduped against the running set (and the source song),
 * preserving layer order so the highest-signal tracks play first.
 *
 * Exported for unit tests. Used by `playMoreLikeThis`.
 */
export async function buildMoreLikeThisQueue(
  source: Child,
  target = layoutPreferencesStore.getState().listLength,
): Promise<Child[]> {
  const seen = new Set<string>([source.id]);
  const output: Child[] = [];
  const push = (tracks: readonly Child[] | null | undefined): void => {
    for (const track of tracks ?? []) {
      if (output.length >= target) return;
      if (!track?.id || seen.has(track.id)) continue;
      seen.add(track.id);
      output.push(track);
    }
  };
  for (const load of onlineRecommendationSources(source, target)) {
    push(await load());
    if (output.length >= target) return output;
  }
  return output;
}

export interface AutoplayOptions {
  currentQueue: readonly Child[];
  manualFutureTrackIds: ReadonlySet<string>;
  target?: number;
}

/** Construct one Autoplay batch, preserving source priority. */
export async function buildAutoplayQueue(
  source: Child,
  options: AutoplayOptions,
): Promise<Child[]> {
  const target = options.target ?? layoutPreferencesStore.getState().listLength;
  const queuedIds = new Set(options.currentQueue.map((track) => track.id));
  return buildFromSources(
    source,
    target,
    options.manualFutureTrackIds,
    queuedIds,
  );
}

async function buildFromSources(
  source: Child,
  target: number,
  excludedIds: ReadonlySet<string>,
  queuedIds: ReadonlySet<string>,
): Promise<Child[]> {
  const seen = new Set<string>([source.id, ...excludedIds]);
  const fresh: Child[] = [];
  const recycled: Child[] = [];
  const push = (pool: readonly Child[]): void => {
    for (const track of pool) {
      if (!track?.id || seen.has(track.id)) continue;
      seen.add(track.id);
      (queuedIds.has(track.id) ? recycled : fresh).push(track);
    }
  };

  if (offlineModeStore.getState().offlineMode) {
    const all = downloadedSongs();
    const genre = sourceGenre(source);
    if (genre) push(shuffleArray(all.filter((song) => sourceGenre(song) === genre)));
    push(shuffleArray(all));
  } else {
    for (const load of onlineRecommendationSources(source, target)) {
      push(await safely(load));
      if (fresh.length >= target) return fresh.slice(0, target);
    }
    push(await safely(() => getRandomSongs(target * 2)));
  }
  return [...fresh, ...recycled].slice(0, target);
}
