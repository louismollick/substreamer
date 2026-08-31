import type { ArtistID3, Child } from 'subsonic-api';

import { artistIdsPresent, getArtist as getStoredArtist, upsertArtists } from '@/db/repository/artists';
import { getSortArticles } from '@/db/sortArticles';
import { getDb } from '@/store/persistence/db';
import { runPool } from '@/utils/promisePool';

import { ensureCached, hasCachedCoverArt } from './imageCacheService';
import { getArtist as getServerArtist } from './subsonicService';

const CONCURRENCY = 3;

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

/** Persist the primary artist row and durable image required by a completed download. */
export async function ensureDownloadedArtistMetadata(songs: Child[]): Promise<void> {
  const artists = primaryArtists(songs);
  if (artists.size === 0) return;
  const db = getDb();
  if (!db) throw new DownloadedArtistMetadataError(artists.keys().next().value ?? 'unknown');

  const present = await artistIdsPresent(db, [...artists.keys()]);
  const result = await runPool(
    [...artists.entries()],
    async ([artistId, artistName]) => {
      let row: Record<string, unknown> | null = present.has(artistId)
        ? await getStoredArtist(db, artistId)
        : null;
      if (!row) {
        const fetched = await getServerArtist(artistId);
        if (!fetched) throw new DownloadedArtistMetadataError(artistId, artistName);
        const artist: ArtistID3 = fetched;
        await upsertArtists(db, [artist], undefined, getSortArticles());
        row = await getStoredArtist(db, artistId);
      }
      if (!row) throw new DownloadedArtistMetadataError(artistId, artistName);
      const coverArt = typeof row.cover_art === 'string' ? row.cover_art : undefined;
      if (!coverArt) return;
      await ensureCached(coverArt);
      if (!(await hasCachedCoverArt(coverArt))) {
        throw new DownloadedArtistMetadataError(artistId, artistName);
      }
    },
    { concurrency: CONCURRENCY },
  );
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
