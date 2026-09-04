const mockFetchArtistBase = jest.fn();
const mockFetchDownloadedArtist = jest.fn();
const mockGetAlbumDetail = jest.fn();
const mockGetAlbum = jest.fn();
const mockAddToQueue = jest.fn().mockResolvedValue(undefined);
const mockPlayTrack = jest.fn().mockResolvedValue(undefined);
let mockOfflineMode = false;

jest.mock('../../i18n/i18n', () => ({
  __esModule: true,
  default: {
    t: jest.fn((key: string) => key),
  },
}));

jest.mock('../detailFetchService', () => ({
  fetchArtistBase: (...args: unknown[]) => mockFetchArtistBase(...args),
  fetchArtistTopSongs: jest.fn(),
}));

jest.mock('../downloadedArtistService', () => ({
  fetchDownloadedArtist: (...args: unknown[]) => mockFetchDownloadedArtist(...args),
}));

jest.mock('../../store/favoritesStore', () => ({
  favoritesStore: { getState: jest.fn() },
}));

jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: { getState: jest.fn(() => ({ cachedItems: {} })) },
}));

jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: {
    getState: () => ({ offlineMode: mockOfflineMode }),
  },
}));

jest.mock('../../store/layoutPreferencesStore', () => ({
  layoutPreferencesStore: { getState: jest.fn(() => ({ listLength: 20 })) },
}));

jest.mock('../normalizedLibrarySync', () => ({
  refreshPlaylistLibrary: jest.fn(),
}));

jest.mock('../relatedTracksService', () => ({
  buildMoreLikeThisQueue: jest.fn(),
}));

jest.mock('../../store/persistence/db', () => ({
  getDb: jest.fn(() => ({})),
}));

jest.mock('../../db/repository/details', () => ({
  getAlbumDetail: (...args: unknown[]) => mockGetAlbumDetail(...args),
  getPlaylistDetail: jest.fn(),
}));

jest.mock('../../store/processingOverlayStore', () => ({
  processingOverlayStore: {
    getState: jest.fn(() => ({
      show: jest.fn(),
      showSuccess: jest.fn(),
      showError: jest.fn(),
    })),
  },
}));

jest.mock('../../utils/arrayHelpers', () => ({
  shuffleArray: jest.fn((songs: unknown[]) => songs),
}));

jest.mock('../musicCacheService', () => ({
  deleteCachedItem: jest.fn(),
  enqueueAlbumDownload: jest.fn(),
  enqueuePlaylistDownload: jest.fn(),
  enqueueSongDownload: jest.fn(),
  removeCachedAlbumSong: jest.fn(),
  cancelDownload: jest.fn(),
}));

jest.mock('../playerService', () => ({
  addToQueue: (...args: unknown[]) => mockAddToQueue(...args),
  playSongNext: jest.fn(),
  playTrack: (...args: unknown[]) => mockPlayTrack(...args),
  removeFromQueue: jest.fn(),
}));

jest.mock('../subsonicService', () => ({
  createNewPlaylist: jest.fn(),
  getAlbum: (...args: unknown[]) => mockGetAlbum(...args),
  getPlaylist: jest.fn(),
  getSimilarSongs2: jest.fn(),
  starAlbum: jest.fn(),
  starArtist: jest.fn(),
  starSong: jest.fn(),
  unstarAlbum: jest.fn(),
  unstarArtist: jest.fn(),
  unstarSong: jest.fn(),
}));

import { addArtistToQueue } from '../moreOptionsService';

beforeEach(() => {
  jest.clearAllMocks();
  mockOfflineMode = false;
});

describe('addArtistToQueue', () => {
  it('queues the full online discography in chronological order', async () => {
    mockFetchArtistBase.mockResolvedValue({
      albums: [{ id: 'album-new' }, { id: 'album-old' }],
    });
    mockGetAlbumDetail.mockImplementation(async (_db: unknown, albumId: string) => {
      if (albumId === 'album-new') {
        return {
          songs: [
            { id: 'new-2', artistId: 'ar1', year: 2022, discNumber: 1, track: 2 },
            { id: 'other', artistId: 'ar2', year: 2022, discNumber: 1, track: 1 },
            { id: 'new-1', artistId: 'ar1', year: 2022, discNumber: 1, track: 1 },
          ],
        };
      }
      return {
        songs: [
          { id: 'old-1', artist: 'Artist A', year: 2018, discNumber: 1, track: 1 },
        ],
      };
    });

    await addArtistToQueue('ar1', 'Artist A');

    expect(mockFetchArtistBase).toHaveBeenCalledWith('ar1');
    expect(mockGetAlbum).not.toHaveBeenCalled();
    expect(mockAddToQueue).toHaveBeenCalledTimes(1);
    expect(mockAddToQueue.mock.calls[0][0].map((song: { id: string }) => song.id)).toEqual([
      'old-1',
      'new-1',
      'new-2',
    ]);
    expect(mockPlayTrack).not.toHaveBeenCalled();
  });

  it('queues only downloaded artist songs while offline without server reads', async () => {
    mockOfflineMode = true;
    mockFetchDownloadedArtist.mockResolvedValue({
      songs: [
        { id: 'downloaded-new', artistId: 'ar1', year: 2021, discNumber: 1, track: 1 },
        { id: 'downloaded-old', artistId: 'ar1', year: 2017, discNumber: 1, track: 1 },
      ],
    });

    await addArtistToQueue('ar1', 'Artist A');

    expect(mockFetchDownloadedArtist).toHaveBeenCalledWith('ar1');
    expect(mockFetchArtistBase).not.toHaveBeenCalled();
    expect(mockGetAlbumDetail).not.toHaveBeenCalled();
    expect(mockGetAlbum).not.toHaveBeenCalled();
    expect(mockAddToQueue.mock.calls[0][0].map((song: { id: string }) => song.id)).toEqual([
      'downloaded-old',
      'downloaded-new',
    ]);
    expect(mockPlayTrack).not.toHaveBeenCalled();
  });

  it('does not change the queue when the artist has no downloaded songs offline', async () => {
    mockOfflineMode = true;
    mockFetchDownloadedArtist.mockResolvedValue(null);

    await addArtistToQueue('ar1', 'Artist A');

    expect(mockAddToQueue).not.toHaveBeenCalled();
    expect(mockFetchArtistBase).not.toHaveBeenCalled();
  });
});
