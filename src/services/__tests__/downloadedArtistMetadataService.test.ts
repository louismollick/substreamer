const mockRows = new Map<string, Record<string, unknown>>();
const mockGetServerArtist = jest.fn();
const mockEnsureCached = jest.fn().mockResolvedValue(undefined);
const mockHasCachedCoverArt = jest.fn().mockResolvedValue(true);
const mockUpsertArtists = jest.fn(async (_db, artists) => {
  for (const artist of artists) {
    mockRows.set(artist.id, { id: artist.id, cover_art: artist.coverArt ?? null });
  }
});

jest.mock('@/store/persistence/db', () => ({ getDb: () => ({}) }));
jest.mock('@/db/sortArticles', () => ({ getSortArticles: () => undefined }));
jest.mock('@/db/repository/artists', () => ({
  artistIdsPresent: async (_db: unknown, ids: string[]) =>
    new Set(ids.filter((id) => mockRows.has(id))),
  getArtist: async (_db: unknown, id: string) => mockRows.get(id) ?? null,
  upsertArtists: (db: unknown, artists: unknown[]) => mockUpsertArtists(db, artists),
}));
jest.mock('../subsonicService', () => ({
  getArtist: (...args: unknown[]) => mockGetServerArtist(...args),
}));
jest.mock('../imageCacheService', () => ({
  ensureCached: (...args: unknown[]) => mockEnsureCached(...args),
  hasCachedCoverArt: (...args: unknown[]) => mockHasCachedCoverArt(...args),
}));

import {
  DownloadedArtistMetadataError,
  ensureDownloadedArtistMetadata,
  hasDownloadedArtistMetadata,
} from '../downloadedArtistMetadataService';

beforeEach(() => {
  mockRows.clear();
  jest.clearAllMocks();
  mockEnsureCached.mockResolvedValue(undefined);
  mockHasCachedCoverArt.mockResolvedValue(true);
});

it('deduplicates primary artists, writes only the artist row, and awaits its image', async () => {
  mockGetServerArtist.mockResolvedValue({
    id: 'ar1',
    name: 'Artist',
    albumCount: 1,
    coverArt: 'cover-ar1',
    album: [{ id: 'undownloaded' }],
  });

  await ensureDownloadedArtistMetadata([
    { id: 's1', title: 'One', artistId: 'ar1', artist: 'Artist', isDir: false },
    { id: 's2', title: 'Two', artistId: 'ar1', artist: 'Artist', isDir: false },
  ]);

  expect(mockGetServerArtist).toHaveBeenCalledTimes(1);
  expect(mockUpsertArtists).toHaveBeenCalledTimes(1);
  expect(mockEnsureCached).toHaveBeenCalledWith('cover-ar1');
  expect(mockHasCachedCoverArt).toHaveBeenCalledWith('cover-ar1');
});

it('treats a valid artist without cover art as complete', async () => {
  mockGetServerArtist.mockResolvedValue({ id: 'ar1', name: 'Artist', albumCount: 0 });
  await expect(ensureDownloadedArtistMetadata([
    { id: 's1', title: 'One', artistId: 'ar1', artist: 'Artist', isDir: false },
  ])).resolves.toBeUndefined();
  expect(mockEnsureCached).not.toHaveBeenCalled();
  await expect(hasDownloadedArtistMetadata('ar1')).resolves.toBe(true);
});

it('identifies the artist when row or image persistence fails', async () => {
  mockGetServerArtist.mockResolvedValue(null);
  await expect(ensureDownloadedArtistMetadata([
    { id: 's1', title: 'One', artistId: 'ar1', artist: 'Artist', isDir: false },
  ])).rejects.toEqual(new DownloadedArtistMetadataError('ar1', 'Artist'));

  mockRows.set('ar1', { id: 'ar1', cover_art: 'cover-ar1' });
  mockHasCachedCoverArt.mockResolvedValue(false);
  await expect(ensureDownloadedArtistMetadata([
    { id: 's1', title: 'One', artistId: 'ar1', artist: 'Artist', isDir: false },
  ])).rejects.toMatchObject({ artistId: 'ar1' });
});
