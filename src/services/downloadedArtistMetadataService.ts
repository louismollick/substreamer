import type { ArtistID3, Child } from 'subsonic-api';

import { artistIdsPresent, getArtist as getStoredArtist, upsertArtists } from '@/db/repository/artists';
import { getSortArticles } from '@/db/sortArticles';
import { getDb } from '@/store/persistence/db';
import { runPool } from '@/utils/promisePool';

import { ensureCached, hasCachedCoverArt } from './imageCacheService';
import { getArtist as getServerArtist } from './subsonicService';

const CONCURRENCY = 3;
const COVER_RETRY_DELAYS_MS = [2_000, 5_000] as const;

export class DownloadedArtistMetadataError extends Error {
  constructor(readonly artistId: string, readonly artistName?: string) {
    super(`Failed artist metadata: ${artistName || artistId}`);
  }
}

const primaryArtists = (songs: Child[]): Map<string, string | undefined> => {
  const artists = new Map<string, string | undefined>();
  for (const song of songs) {
    if (song.artistId && !artists.has(song.artistId)) artists.set(song.artistId, song.artist);
  }
  return artists;
};

/** Stop awaiting remote metadata when the download's cache session ends. */
async function whileActive<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return work;
  let cancel: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    cancel = () => resolve(undefined);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel);
  }
}

/** Persist the primary artist row and durable image required by a completed download. */
export async function ensureDownloadedArtistMetadata(songs: Child[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const artists = primaryArtists(songs);
  if (artists.size === 0) return;
  const db = getDb();
  if (!db) throw new DownloadedArtistMetadataError(artists.keys().next().value ?? 'unknown');

  const present = await artistIdsPresent(db, [...artists.keys()]);
  if (signal?.aborted) return;
  const result = await runPool(
    [...artists.entries()],
    async ([artistId, artistName]) => {
      let row: Record<string, unknown> | null = present.has(artistId)
        ? await getStoredArtist(db, artistId)
        : null;
      if (signal?.aborted) return;
      if (!row) {
        const fetched = await whileActive(getServerArtist(artistId, signal), signal);
        if (signal?.aborted) return;
        if (!fetched) throw new DownloadedArtistMetadataError(artistId, artistName);
        const artist: ArtistID3 = fetched;
        await upsertArtists(db, [artist], undefined, getSortArticles());
        if (signal?.aborted) return;
        row = await getStoredArtist(db, artistId);
      }
      if (signal?.aborted) return;
      if (!row) throw new DownloadedArtistMetadataError(artistId, artistName);
      const coverArt = typeof row.cover_art === 'string' ? row.cover_art : undefined;
      if (!coverArt) return;
      // Song transfers wait on this; don't queue it behind prefetched covers.
      // ensureCached also resolves when a download fails, so check and retry
      // a couple of times before failing the whole item over one image.
      for (let attempt = 0; ; attempt++) {
        // eslint-disable-next-line no-await-in-loop
        await whileActive(ensureCached(coverArt, { priority: true }), signal);
        if (signal?.aborted) return;
        // eslint-disable-next-line no-await-in-loop
        const hasCover = await hasCachedCoverArt(coverArt);
        if (signal?.aborted || hasCover) return;
        if (attempt >= COVER_RETRY_DELAYS_MS.length) {
          throw new DownloadedArtistMetadataError(artistId, artistName);
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // eslint-disable-next-line no-await-in-loop
          await whileActive(new Promise<void>((resolve) => {
            timer = setTimeout(resolve, COVER_RETRY_DELAYS_MS[attempt]);
          }), signal);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        if (signal?.aborted) return;
      }
    },
    { concurrency: CONCURRENCY, signal },
  );
  if (signal?.aborted) return;
  if (result.rejected.length > 0) throw result.rejected[0].error;
}

export async function hasDownloadedArtistMetadata(artistId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const row = await getStoredArtist(db, artistId);
  if (!row) return false;
  const coverArt = typeof row.cover_art === 'string' ? row.cover_art : undefined;
  return coverArt ? hasCachedCoverArt(coverArt) : true;
}
