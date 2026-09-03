import {
  getDownloadedArtistProjection,
  listDownloadedArtists,
  type DownloadedArtistProjection,
} from '@/db/repository/downloads';
import { getDb } from '@/store/persistence/db';

export async function fetchDownloadedArtist(
  artistId: string,
): Promise<DownloadedArtistProjection | null> {
  const db = getDb();
  return db ? getDownloadedArtistProjection(db, artistId) : null;
}

export async function fetchDownloadedArtists(): Promise<DownloadedArtistProjection[]> {
  const db = getDb();
  return db ? listDownloadedArtists(db) : [];
}

export async function hasDownloadedArtist(artistId: string): Promise<boolean> {
  return (await fetchDownloadedArtist(artistId)) !== null;
}
