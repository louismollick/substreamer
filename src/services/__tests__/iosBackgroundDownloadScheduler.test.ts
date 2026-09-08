const mockSubscribe = jest.fn();
const mockGetState = jest.fn();
const mockWhenQueuePayloadWritten = jest.fn();
const mockReadDownloadQueueSongsAsync = jest.fn();
const mockEnsureCoverArtAuth = jest.fn();
const mockGetDownloadStreamUrl = jest.fn();
const mockCanUseBackgroundDownloadUrl = jest.fn();
const mockPrimeBackgroundDownloads = jest.fn();
const mockStopBackgroundDownloadsForQueue = jest.fn();

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

jest.mock('expo-async-fs', () => ({
  canUseBackgroundDownloadUrl: (...args: unknown[]) => mockCanUseBackgroundDownloadUrl(...args),
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

type QueueState = {
  downloadQueue: Array<{ queueId: string; status: string }>;
  cachedSongs: Record<string, unknown>;
  maxConcurrentDownloads: number;
};

type QueueListener = (state: QueueState, previous: QueueState) => void;

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
    mockCanUseBackgroundDownloadUrl.mockReturnValue(true);
    mockPrimeBackgroundDownloads.mockResolvedValue(undefined);

    const listener = mockSubscribe.mock.calls[0]?.[0] as QueueListener;
    expect(listener).toBeDefined();

    const queued = state('queued');
    const downloading = state('downloading');
    currentState = downloading;
    listener(downloading, queued);
    await flushPromises();

    expect(mockPrimeBackgroundDownloads).toHaveBeenCalledTimes(1);

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
