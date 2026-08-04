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

/** Existing one-shot “Play more like this” construction. */
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
  push(await getSimilarSongs(source.id, target));
  if (output.length >= target) return output;
  if (source.artistId) push(await getSimilarSongs2(source.artistId, target));
  if (output.length >= target) return output;
  const genre = sourceGenre(source);
  if (genre) push(await getRandomSongsFiltered({ size: target * 2, genre }));
  if (output.length >= target) return output;
  if (source.artist) push(await getTopSongs(source.artist, target));
  return output;
}

export interface InfinitePlayOptions {
  currentQueue: readonly Child[];
  manualFutureTrackIds: ReadonlySet<string>;
  target?: number;
}

/** Construct one Infinite Play batch, preserving source priority. */
export async function buildInfinitePlayQueue(
  source: Child,
  options: InfinitePlayOptions,
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
    push(shuffleArray(all.filter((song) => genre && sourceGenre(song) === genre)));
    push(shuffleArray(all));
  } else {
    push(await safely(() => getSimilarSongs(source.id, target)));
    if (fresh.length >= target) return fresh.slice(0, target);
    if (source.artistId) push(await safely(() => getSimilarSongs2(source.artistId!, target)));
    if (fresh.length >= target) return fresh.slice(0, target);
    const genre = sourceGenre(source);
    if (genre) {
      push(await safely(() => getRandomSongsFiltered({ size: target * 2, genre })));
    }
    if (fresh.length >= target) return fresh.slice(0, target);
    if (source.artist) push(await safely(() => getTopSongs(source.artist!, target)));
    if (fresh.length >= target) return fresh.slice(0, target);
    push(await safely(() => getRandomSongs(target * 2)));
  }
  return [...fresh, ...recycled].slice(0, target);
}
