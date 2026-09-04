const mockFetchLyrics = jest.fn();
const mockDownload = jest.fn();
const mockPassiveStore = { subscribe: jest.fn(() => jest.fn()) };
let mockQueueSongs: any[] = [];
let mockState: any;

jest.mock('expo-file-system', () => {
  class Directory {
    uri: string;
    constructor(...args: any[]) {
      this.uri = args.map((a: any) => typeof a === 'string' ? a : a?.uri ?? '').join('/');
    }
    get exists() { return true; }
    create = jest.fn();
    delete = jest.fn();
  }
  class File extends Directory {
    get size() { return 1000; }
    move = jest.fn().mockResolvedValue(undefined);
    static downloadFileAsync = jest.fn().mockResolvedValue(undefined);
  }
  return { Directory, File, Paths: { document: { uri: 'file:///document' } } };
});

jest.mock('expo-async-fs', () => ({
  listDirectoryAsync: jest.fn().mockResolvedValue([]),
  getDirectorySizeAsync: jest.fn().mockResolvedValue(0),
  downloadFileAsyncWithProgress: (...args: unknown[]) => mockDownload(...args),
  deleteDirectoryAsync: jest.fn().mockResolvedValue(true),
  deleteFileAsync: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../utils/onAppForeground', () => ({
  onAppForeground: jest.fn(() => ({ remove: jest.fn() })),
}));
jest.mock('../../i18n/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }));
jest.mock('../storageService', () => ({ checkStorageLimit: jest.fn(() => false) }));
jest.mock('../downloadSpeedTracker', () => ({ beginDownload: jest.fn(), clearDownload: jest.fn() }));
jest.mock('../detailFetchService', () => ({ fetchAlbumDetail: jest.fn(), fetchPlaylistDetail: jest.fn() }));
jest.mock('../../store/favoritesStore', () => ({ favoritesStore: mockPassiveStore }));
jest.mock('../../store/storageLimitStore', () => ({ storageLimitStore: mockPassiveStore }));
jest.mock('../../store/lyricsStore', () => ({
  lyricsStore: { getState: () => ({ fetchLyrics: mockFetchLyrics }) },
}));
jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: { getState: () => mockState, setState: jest.fn() },
  whenQueuePayloadWritten: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: {
    getState: () => ({ offlineMode: false }),
    subscribe: jest.fn(() => jest.fn()),
  },
}));
jest.mock('../../store/persistence/musicCacheTables', () => ({
  albumMetaFromAlbumID3: jest.fn(() => ({})),
  countCachedSongs: jest.fn(() => 0),
  countRealSongRefsForSongsAsync: jest.fn(async () => new Map()),
  insertCachedItemSong: jest.fn(),
  playlistMetaFromPlaylist: jest.fn(() => ({})),
  promotedSongFieldsFromChild: jest.fn(() => ({})),
  readDownloadQueueAlbumIdsAsync: jest.fn(async () => []),
  readDownloadQueueSongRefsAsync: jest.fn(async () => []),
  readDownloadQueueSongsAsync: jest.fn(async () => mockQueueSongs),
  readQueuedSongStatus: jest.fn(() => null),
}));
jest.mock('../imageCacheLogger', () => ({ logImageCache: jest.fn() }));
jest.mock('../../store/processingOverlayStore', () => ({
  processingOverlayStore: { getState: () => ({ showError: jest.fn() }) },
}));
jest.mock('../../store/playbackSettingsStore', () => ({
  playbackSettingsStore: { getState: () => ({ downloadFormat: 'raw', downloadMaxBitRate: null }) },
}));
jest.mock('../../utils/effectiveFormat', () => ({
  resolveEffectiveFormat: jest.fn(() => ({ capturedAt: 1 })),
}));
jest.mock('../../store/persistence/db', () => ({ getDb: jest.fn(() => null) }));
jest.mock('../../db/repository/details', () => ({ getAlbumDetail: jest.fn(), getPlaylistDetail: jest.fn() }));
jest.mock('../../db/repository/songs', () => ({ albumIdsWithSongs: jest.fn() }));
jest.mock('../../db/repository/favorites', () => ({
  countStarredSongs: jest.fn(), listAllStarredSongs: jest.fn(), starredItemOf: jest.fn(),
}));
jest.mock('../subsonicService', () => ({
  ensureCoverArtAuth: jest.fn().mockResolvedValue(undefined),
  getDownloadStreamUrl: jest.fn(() => 'https://example.com/song'),
}));
jest.mock('../imageCacheService', () => ({ ensureCached: jest.fn(), prefetchCoverArt: jest.fn() }));
jest.mock('../../utils/coverArtId', () => ({ coverArtForAlbum: jest.fn(), coverArtForPlaylist: jest.fn() }));
jest.mock('../../utils/promisePool', () => ({ runPool: jest.fn() }));
jest.mock('../../hooks/useSongCoverArt', () => ({ albumCoverArtById: jest.fn(), resolveSongCoverArt: jest.fn() }));
jest.mock('../downloadedArtistMetadataService', () => ({
  ensureDownloadedArtistMetadata: jest.fn().mockResolvedValue(undefined),
}));

import { resumeIfSpaceAvailable } from '../musicCacheService';

const makeSong = (id: string) => ({
  id,
  title: `Song ${id}`,
  artist: 'Test Artist',
  album: 'Test Album',
  albumId: 'album-lyrics',
  duration: 180,
  suffix: 'mp3',
});

const waitForQueueIdle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    if (mockState.downloadQueue.length === 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('download queue did not finish');
};

beforeEach(() => {
  mockFetchLyrics.mockReset().mockResolvedValue(null);
  mockDownload.mockReset().mockResolvedValue(undefined);
  mockQueueSongs = [makeSong('one'), makeSong('two')];
  mockState = {
    maxConcurrentDownloads: 2,
    downloadQueue: [{
      queueId: 'queue-lyrics', itemId: 'album-lyrics', type: 'album', name: 'Lyrics Album',
      totalSongs: 2, completedSongs: 0, status: 'queued', addedAt: 1, queuePosition: 1,
    }],
    cachedItems: {},
    cachedSongs: {},
    updateQueueItem: (queueId: string, patch: Record<string, unknown>) => {
      mockState.downloadQueue = mockState.downloadQueue.map((item: any) =>
        item.queueId === queueId ? { ...item, ...patch } : item,
      );
    },
    addBytes: jest.fn(),
    addFiles: jest.fn(),
    upsertCachedSong: (song: any) => { mockState.cachedSongs[song.id] = song; },
    markItemComplete: (queueId: string, item: any, songs: any[], edges: any[]) => {
      for (const song of songs) mockState.cachedSongs[song.id] = song;
      mockState.cachedItems[item.itemId] = {
        ...item,
        songIds: [...edges].sort((a, b) => a.position - b.position).map((edge) => edge.songId),
      };
      mockState.downloadQueue = mockState.downloadQueue.filter((q: any) => q.queueId !== queueId);
    },
  };
});

describe('offline lyrics download', () => {
  it('prefetches lyrics after a successful bulk audio download', async () => {
    resumeIfSpaceAvailable();
    await waitForQueueIdle();

    expect(mockState.cachedItems['album-lyrics'].songIds).toEqual(['one', 'two']);
    expect(mockFetchLyrics).toHaveBeenCalledTimes(2);
    expect(mockFetchLyrics).toHaveBeenCalledWith('one', 'Test Artist', 'Song one');
    expect(mockFetchLyrics).toHaveBeenCalledWith('two', 'Test Artist', 'Song two');
  });

  it('keeps the audio download complete when lyric prefetch fails', async () => {
    mockFetchLyrics.mockRejectedValue(new Error('lyrics unavailable'));

    resumeIfSpaceAvailable();
    await waitForQueueIdle();
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockState.cachedItems['album-lyrics'].songIds).toEqual(['one', 'two']);
    expect(mockState.cachedSongs.one).toBeDefined();
    expect(mockState.cachedSongs.two).toBeDefined();
    expect(mockState.downloadQueue).toEqual([]);
    expect(mockFetchLyrics).toHaveBeenCalledTimes(2);
  });
});
