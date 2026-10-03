const mockRows = new Map<string, Record<string, unknown>>();
const mockGetDb = jest.fn<unknown, []>(() => ({}));
const mockGetServerArtist = jest.fn();
const mockEnsureCached = jest.fn().mockResolvedValue(undefined);
const mockHasCachedCoverArt = jest.fn().mockResolvedValue(true);
const mockUpsertArtists = jest.fn(async (_db, artists) => {
  for (const artist of artists) {
    mockRows.set(artist.id, { id: artist.id, cover_art: artist.coverArt ?? null });
  }
});

jest.mock('@/store/persistence/db', () => ({ getDb: () => mockGetDb() }));
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
  mockGetDb.mockReturnValue({});
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
  expect(mockEnsureCached).toHaveBeenCalledWith('cover-ar1', { priority: true });
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
  jest.useFakeTimers();
  try {
    const result = ensureDownloadedArtistMetadata([
      { id: 's1', title: 'One', artistId: 'ar1', artist: 'Artist', isDir: false },
    ]);
    const assertion = expect(result).rejects.toMatchObject({ artistId: 'ar1' });
    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(mockEnsureCached).toHaveBeenCalledTimes(3);
  } finally {
    jest.useRealTimers();
  }
});

it('retries a cover that failed to save before failing the item', async () => {
  mockRows.set('ar1', { id: 'ar1', cover_art: 'cover-ar1' });
  mockHasCachedCoverArt.mockResolvedValueOnce(false).mockResolvedValue(true);
  jest.useFakeTimers();
  try {
    const result = ensureDownloadedArtistMetadata([
      { id: 's1', title: 'One', artistId: 'ar1', artist: 'Artist', isDir: false },
    ]);
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toBeUndefined();
    expect(mockEnsureCached).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});


it('cancels stalled artist metadata without writing a late account response', async () => {
  const controller = new AbortController();
  let finish: ((value: { id: string; name: string; albumCount: number }) => void) | undefined;
  mockGetServerArtist.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = ensureDownloadedArtistMetadata([
    { id: 's1', title: 'One', artistId: 'old-artist', isDir: false },
  ], controller.signal);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(mockGetServerArtist).toHaveBeenCalledWith('old-artist', controller.signal);
  controller.abort();
  await pending;
  finish?.({ id: 'old-artist', name: 'Old', albumCount: 0 });
  await Promise.resolve();
  expect(mockUpsertArtists).not.toHaveBeenCalled();
});

it('does not wait on a stalled cover or retry it after cancellation', async () => {
  mockRows.set('ar1', { id: 'ar1', cover_art: 'cover-ar1' });
  const controller = new AbortController();
  let finish: (() => void) | undefined;
  mockEnsureCached.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const pending = ensureDownloadedArtistMetadata([
    { id: 's1', title: 'One', artistId: 'ar1', isDir: false },
  ], controller.signal);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(mockEnsureCached).toHaveBeenCalledTimes(1);
  controller.abort();
  await pending;
  finish?.();
  expect(mockHasCachedCoverArt).not.toHaveBeenCalled();
});

it('skips songs without artists and requests already cancelled at entry', async () => {
  await ensureDownloadedArtistMetadata([{ id: 's1', title: 'One', isDir: false }]);
  const controller = new AbortController();
  controller.abort();
  await ensureDownloadedArtistMetadata([{ id: 's1', title: 'One', artistId: 'ar1', isDir: false }], controller.signal);
  expect(mockGetServerArtist).not.toHaveBeenCalled();
  expect(mockUpsertArtists).not.toHaveBeenCalled();
});

it('reports an unavailable database and incomplete stored metadata', async () => {
  mockGetDb.mockReturnValue(null);
  await expect(ensureDownloadedArtistMetadata([{ id: 's1', title: 'One', artistId: 'ar1', isDir: false }]))
    .rejects.toMatchObject({ artistId: 'ar1' });
  await expect(hasDownloadedArtistMetadata('ar1')).resolves.toBe(false);
  mockGetDb.mockReturnValue({});
  await expect(hasDownloadedArtistMetadata('ar1')).resolves.toBe(false);
  mockRows.set('ar1', { id: 'ar1', cover_art: 42 });
  await expect(hasDownloadedArtistMetadata('ar1')).resolves.toBe(true);
  mockRows.set('ar1', { id: 'ar1', cover_art: 'cover-ar1' });
  mockHasCachedCoverArt.mockResolvedValue(false);
  await expect(hasDownloadedArtistMetadata('ar1')).resolves.toBe(false);
});

it('does not request images after cancellation during the artist write', async () => {
  const controller = new AbortController();
  mockGetServerArtist.mockResolvedValue({ id: 'ar1', coverArt: 'cover-ar1' });
  mockUpsertArtists.mockImplementationOnce(async () => { controller.abort(); });
  await ensureDownloadedArtistMetadata([{ id: 's1', title: 'One', artistId: 'ar1', isDir: false }], controller.signal);
  expect(mockEnsureCached).not.toHaveBeenCalled();
});

it('completes cancellable image retries and releases the abort listener', async () => {
  const controller = new AbortController();
  mockRows.set('ar1', { id: 'ar1', cover_art: 'cover-ar1' });
  mockHasCachedCoverArt.mockResolvedValueOnce(false).mockResolvedValue(true);
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  jest.useFakeTimers();
  try {
    const pending = ensureDownloadedArtistMetadata([{ id: 's1', title: 'One', artistId: 'ar1', isDir: false }], controller.signal);
    await jest.advanceTimersByTimeAsync(3_000);
    await pending;
    expect(mockEnsureCached).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  } finally {
    jest.useRealTimers();
    remove.mockRestore();
  }
});

it('clears the cover retry timer when the account logs out', async () => {
  const controller = new AbortController();
  mockRows.set('ar1', { id: 'ar1', cover_art: 'cover-ar1' });
  mockHasCachedCoverArt.mockResolvedValue(false);
  jest.useFakeTimers();
  try {
    const pending = ensureDownloadedArtistMetadata([{ id: 's1', title: 'One', artistId: 'ar1', isDir: false }], controller.signal);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockHasCachedCoverArt).toHaveBeenCalledTimes(1);
    controller.abort();
    await pending;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockEnsureCached).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});
