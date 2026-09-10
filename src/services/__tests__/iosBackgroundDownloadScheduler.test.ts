const mockGetState = jest.fn();
const mockWhenQueuePayloadWritten = jest.fn();
const mockReadDownloadQueueSongsAsync = jest.fn();
const mockEnsureCoverArtAuth = jest.fn();
const mockGetDownloadStreamUrl = jest.fn();
const mockPrimeBackgroundDownloads = jest.fn();
const mockStopBackgroundDownloadsForQueue = jest.fn();

type QueueState = {
  downloadQueue: Array<{ queueId: string; status: string }>;
  cachedSongs: Record<string, unknown>;
  maxConcurrentDownloads: number;
};

type QueueListener = (state: QueueState, previous: QueueState) => void;

let subscribedListener: QueueListener | undefined;
const mockSubscribe = jest.fn((listener: QueueListener) => {
  subscribedListener = listener;
  return () => undefined;
});

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

jest.mock('expo-async-fs', () => ({
  primeBackgroundDownloads: (...args: unknown[]) => mockPrimeBackgroundDownloads(...args),
  stopBackgroundDownloadsForQueue: (...args: unknown[]) =>
    mockStopBackgroundDownloadsForQueue(...args),
}));

jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: {
    getState: (...args: unknown[]) => mockGetState(...args),
    subscribe: (...args: unknown[]) => mockSubscribe(...args),
  },
  whenQueuePayloadWritten: (...args: unknown[]) => mockWhenQueuePayloadWritten(...args),
}));

jest.mock('../../store/persistence/musicCacheTables', () => ({
  readDownloadQueueSongsAsync: (...args: unknown[]) => mockReadDownloadQueueSongsAsync(...args),
}));

jest.mock('../subsonicService', () => ({
  ensureCoverArtAuth: (...args: unknown[]) => mockEnsureCoverArtAuth(...args),
  getDownloadStreamUrl: (...args: unknown[]) => mockGetDownloadStreamUrl(...args),
}));

import '../iosBackgroundDownloadScheduler';

function state(status: string): QueueState {
  return {
    downloadQueue: [{ queueId: 'queue-1', status }],
    cachedSongs: {},
    maxConcurrentDownloads: 2,
  };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('iosBackgroundDownloadScheduler', () => {
  it('finishes a queued stop before re-priming the same queue item', async () => {
    let currentState = state('queued');
    mockGetState.mockImplementation(() => currentState);
    mockWhenQueuePayloadWritten.mockResolvedValue(undefined);
    mockReadDownloadQueueSongsAsync.mockResolvedValue([{ id: 'song-1' }]);
    mockEnsureCoverArtAuth.mockResolvedValue(undefined);
    mockGetDownloadStreamUrl.mockReturnValue('https://server.example/rest/stream.view?id=song-1');
    mockPrimeBackgroundDownloads.mockResolvedValue(undefined);

    const listener = subscribedListener;
    expect(listener).toBeDefined();
    if (!listener) throw new Error('scheduler did not subscribe');

    const queued = state('queued');
    const downloading = state('downloading');
    currentState = downloading;
    listener(downloading, queued);
    await flushPromises();

    expect(mockPrimeBackgroundDownloads).toHaveBeenCalledTimes(1);
    expect(mockPrimeBackgroundDownloads).toHaveBeenLastCalledWith(
      'queue-1',
      [{
        downloadId: 'song-1',
        url: 'https://server.example/rest/stream.view?id=song-1',
        position: 1,
      }],
    );

    let resolveStop!: () => void;
    mockStopBackgroundDownloadsForQueue.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveStop = resolve;
      }),
    );

    const parked = state('queued');
    currentState = parked;
    listener(parked, downloading);
    await flushPromises();
    expect(mockStopBackgroundDownloadsForQueue).toHaveBeenCalledTimes(1);

    const resumed = state('downloading');
    currentState = resumed;
    listener(resumed, parked);
    await flushPromises();

    expect(mockPrimeBackgroundDownloads).toHaveBeenCalledTimes(1);

    resolveStop();
    await flushPromises();

    expect(mockPrimeBackgroundDownloads).toHaveBeenCalledTimes(2);
  });
});
