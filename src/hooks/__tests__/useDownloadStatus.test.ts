jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

const mockGetTrackQueueStatus = jest.fn();
jest.mock('../../services/musicCacheService', () => ({
  getTrackQueueStatus: (...a: unknown[]) => (mockGetTrackQueueStatus as any)(...a),
}));

import { act, renderHook } from '@testing-library/react-native';

import { useDownloadStatus } from '../useDownloadStatus';
import { musicCacheStore } from '../../store/musicCacheStore';
import type { CachedItemMeta } from '../../store/musicCacheStore';

function makeItem(overrides: Partial<CachedItemMeta> = {}): CachedItemMeta {
  return {
    itemId: 'a1',
    type: 'album',
    name: 'A',
    expectedSongCount: 10,
    lastSyncAt: 0,
    downloadedAt: 0,
    songIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockGetTrackQueueStatus.mockReset();
  musicCacheStore.setState({ cachedItems: {}, cachedSongs: {}, downloadQueue: [] } as any);
});

describe('useDownloadStatus', () => {
  it('returns "none" when id is empty', () => {
    const { result } = renderHook(() => useDownloadStatus('album', ''));
    expect(result.current).toBe('none');
  });

  describe('song', () => {
    it('returns "complete" when the song has a cached_songs row', () => {
      musicCacheStore.setState({ cachedSongs: { s1: { id: 's1' } } } as any);
      const { result } = renderHook(() => useDownloadStatus('song', 's1'));
      expect(result.current).toBe('complete');
    });

    it('returns queue status when not cached', () => {
      mockGetTrackQueueStatus.mockReturnValue('downloading');
      const { result } = renderHook(() => useDownloadStatus('song', 's1'));
      expect(result.current).toBe('downloading');
    });

    it('returns "none" for a song not cached or queued', () => {
      mockGetTrackQueueStatus.mockReturnValue(null);
      const { result } = renderHook(() => useDownloadStatus('song', 's1'));
      expect(result.current).toBe('none');
    });
  });

  describe('album', () => {
    it('returns "complete" when album has all expected songs', () => {
      musicCacheStore.setState({
        cachedItems: {
          a1: makeItem({
            songIds: Array.from({ length: 10 }, (_, i) => `s${i}`),
            expectedSongCount: 10,
          }),
        },
      } as any);
      const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
      expect(result.current).toBe('complete');
    });

    it('returns "partial" when songs on disk < expected', () => {
      musicCacheStore.setState({
        cachedItems: {
          a1: makeItem({ songIds: ['s1', 's2'], expectedSongCount: 10 }),
        },
      } as any);
      const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
      expect(result.current).toBe('partial');
    });

    it('returns "complete" for a real single-track album (1 of 1)', () => {
      // expectedSongCount is authoritative (server-fetched at write time), so a
      // 1/1 row reflects a real single-track album — forcing it to "partial"
      // would misreport every genuine single.
      musicCacheStore.setState({
        cachedItems: {
          a1: makeItem({ songIds: ['s1'], expectedSongCount: 1 }),
        },
      } as any);
      const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
      expect(result.current).toBe('complete');
    });

    it('returns "queued" when not cached but in queue', () => {
      musicCacheStore.setState({
        cachedItems: {},
        downloadQueue: [
          { queueId: 'q', itemId: 'a1', type: 'album', status: 'queued' },
        ],
      } as any);
      const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
      expect(result.current).toBe('queued');
    });

    it('returns "downloading" when queue entry is downloading', () => {
      musicCacheStore.setState({
        cachedItems: {},
        downloadQueue: [
          { queueId: 'q', itemId: 'a1', type: 'album', status: 'downloading' },
        ],
      } as any);
      const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
      expect(result.current).toBe('downloading');
    });

    it('returns "none" when neither cached nor queued', () => {
      const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
      expect(result.current).toBe('none');
    });
  });

  describe('playlist', () => {
    it.each(['queued', 'downloading'] as const)('reports %s while a cached playlist refresh is pending', (status) => {
      musicCacheStore.setState({
        cachedItems: { p1: makeItem({ itemId: 'p1', type: 'playlist', songIds: ['s1'], expectedSongCount: 2 }) },
        downloadQueue: [{
          queueId: 'refresh', itemId: 'p1', type: 'playlist', name: 'P', status,
          totalSongs: 2, completedSongs: 1, addedAt: 0, queuePosition: 1,
        }],
      });
      const { result } = renderHook(() => useDownloadStatus('playlist', 'p1'));
      expect(result.current).toBe(status);
    });

    it('returns "complete" for a cached playlist (playlists never classify as partial)', () => {
      musicCacheStore.setState({
        cachedItems: {
          p1: makeItem({ type: 'playlist', songIds: ['s1'], expectedSongCount: 10 }),
        },
      } as any);
      const { result } = renderHook(() => useDownloadStatus('playlist', 'p1'));
      expect(result.current).toBe('complete');
    });
  });
});


describe('retained download after a refresh error', () => {
  it.each([
    ['album', ['s1', 's2'], 2, 'complete', 'complete'],
    ['album', ['s1'], 2, 'queued', 'partial'],
    ['playlist', ['s1'], 2, 'complete', 'complete'],
  ] as const)('keeps the %s button actionable after a failed refresh', (type, songIds, expectedSongCount, expected, afterCancel) => {
    musicCacheStore.setState({
      cachedItems: { retained: makeItem({ itemId: 'retained', type, songIds: [...songIds], expectedSongCount }) },
      downloadQueue: [{ queueId: 'repair', itemId: 'retained', type, name: 'Repair', status: 'downloading', totalSongs: 2, completedSongs: 1, addedAt: 0, queuePosition: 1 }],
    });
    const { result } = renderHook(() => useDownloadStatus(type, 'retained'));
    expect(result.current).toBe('downloading');
    act(() => musicCacheStore.setState((state) => ({ downloadQueue: state.downloadQueue.map((item) => ({ ...item, status: 'error' as const })) })));
    expect(result.current).toBe(expected);
    act(() => musicCacheStore.setState((state) => ({ downloadQueue: state.downloadQueue.map((item) => ({ ...item, status: 'queued' as const })) })));
    expect(result.current).toBe('queued');
    act(() => musicCacheStore.setState({ downloadQueue: [] }));
    expect(result.current).toBe(afterCancel);
  });

  it('keeps a failed first download represented as queued when there is no retained item', () => {
    musicCacheStore.setState({ downloadQueue: [{ queueId: 'first', itemId: 'a1', type: 'album', name: 'First', status: 'error', totalSongs: 2, completedSongs: 0, addedAt: 0, queuePosition: 1 }] });
    const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
    expect(result.current).toBe('queued');
  });
});
