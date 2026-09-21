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
function mockSubscribe(listener: QueueListener): () => undefined {
  subscribedListener = listener;
  return () => undefined;
}

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
    subscribe: jest.fn(mockSubscribe),
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

function state(status: string): QueueState {
  return {
    downloadQueue: [{ queueId: 'queue-1', status }],
    cachedSongs: {},
    maxConcurrentDownloads: 2,
  };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    // Drain both promise chains and their setImmediate continuations.
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetState.mockReset();
  mockWhenQueuePayloadWritten.mockReset().mockResolvedValue(undefined);
  mockReadDownloadQueueSongsAsync.mockReset().mockResolvedValue([]);
  mockEnsureCoverArtAuth.mockReset().mockResolvedValue(undefined);
  mockGetDownloadStreamUrl.mockReset();
  mockPrimeBackgroundDownloads.mockReset().mockResolvedValue(undefined);
  mockStopBackgroundDownloadsForQueue.mockReset().mockResolvedValue(undefined);
  subscribedListener = undefined;

  // The scheduler intentionally owns module-scope queues. Reload it for each
  // case so pending work and the parked flag cannot leak across tests.
  jest.resetModules();
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../iosBackgroundDownloadScheduler');
  });
});

afterEach(async () => {
  await flushPromises();
});

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

  it('primes newly queued items before the current item finishes', async () => {
    mockWhenQueuePayloadWritten.mockResolvedValue(undefined);
    mockReadDownloadQueueSongsAsync.mockImplementation(async (queueId: string) => [
      { id: `song-${queueId}` },
    ]);
    mockEnsureCoverArtAuth.mockResolvedValue(undefined);
    mockGetDownloadStreamUrl.mockImplementation(
      (songId: string) => `https://server.example/rest/stream.view?id=${songId}`,
    );
    mockPrimeBackgroundDownloads.mockResolvedValue(undefined);

    const before: QueueState = {
      downloadQueue: [{ queueId: 'queue-1', status: 'downloading' }],
      cachedSongs: {},
      maxConcurrentDownloads: 2,
    };
    const after: QueueState = {
      downloadQueue: [
        { queueId: 'queue-1', status: 'downloading' },
        { queueId: 'queue-2', status: 'queued' },
        { queueId: 'queue-3', status: 'queued' },
      ],
      cachedSongs: {},
      maxConcurrentDownloads: 2,
    };
    mockGetState.mockReturnValue(after);

    subscribedListener!(after, before);
    await flushPromises();

    expect(mockPrimeBackgroundDownloads).toHaveBeenCalledWith(
      'queue-2',
      [{
        downloadId: 'song-queue-2',
        url: 'https://server.example/rest/stream.view?id=song-queue-2',
        position: 1,
      }],
    );
    expect(mockPrimeBackgroundDownloads).toHaveBeenCalledWith(
      'queue-3',
      [{
        downloadId: 'song-queue-3',
        url: 'https://server.example/rest/stream.view?id=song-queue-3',
        position: 1,
      }],
    );
  });

  it('primes queued items without waiting for an earlier native batch', async () => {
    mockWhenQueuePayloadWritten.mockResolvedValue(undefined);
    mockReadDownloadQueueSongsAsync.mockImplementation(async (queueId: string) => [
      { id: `song-${queueId}` },
    ]);
    mockEnsureCoverArtAuth.mockResolvedValue(undefined);
    mockGetDownloadStreamUrl.mockImplementation(
      (songId: string) => `https://server.example/rest/stream.view?id=${songId}`,
    );

    let resolveFirst!: () => void;
    mockPrimeBackgroundDownloads
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue(undefined);

    const before: QueueState = {
      downloadQueue: [{ queueId: 'queue-1', status: 'downloading' }],
      cachedSongs: {},
      maxConcurrentDownloads: 2,
    };
    const after: QueueState = {
      downloadQueue: [
        { queueId: 'queue-1', status: 'downloading' },
        { queueId: 'queue-2', status: 'queued' },
        { queueId: 'queue-3', status: 'queued' },
      ],
      cachedSongs: {},
      maxConcurrentDownloads: 2,
    };
    mockGetState.mockReturnValue(after);

    subscribedListener!(after, before);
    await flushPromises();

    expect(mockPrimeBackgroundDownloads).toHaveBeenCalledTimes(2);
    expect(mockPrimeBackgroundDownloads).toHaveBeenCalledWith(
      'queue-2',
      expect.any(Array),
    );
    expect(mockPrimeBackgroundDownloads).toHaveBeenCalledWith(
      'queue-3',
      expect.any(Array),
    );

    resolveFirst();
    await flushPromises();
  });

  it('stops primed queued siblings when the active item is parked', async () => {
    mockStopBackgroundDownloadsForQueue.mockResolvedValue(undefined);
    const downloading: QueueState = {
      downloadQueue: [
        { queueId: 'queue-1', status: 'downloading' },
        { queueId: 'queue-2', status: 'queued' },
        { queueId: 'queue-3', status: 'queued' },
      ],
      cachedSongs: {},
      maxConcurrentDownloads: 2,
    };
    const parked: QueueState = {
      ...downloading,
      downloadQueue: downloading.downloadQueue.map((item) => ({
        ...item,
        status: 'queued',
      })),
    };
    mockGetState.mockReturnValue(parked);

    subscribedListener!(parked, downloading);
    await flushPromises();

    expect(mockStopBackgroundDownloadsForQueue).toHaveBeenCalledWith('queue-1', true);
    expect(mockStopBackgroundDownloadsForQueue).toHaveBeenCalledWith('queue-2', true);
    expect(mockStopBackgroundDownloadsForQueue).toHaveBeenCalledWith('queue-3', true);
  });

  it('re-primes the whole queue when processing resumes', async () => {
    mockWhenQueuePayloadWritten.mockResolvedValue(undefined);
    mockReadDownloadQueueSongsAsync.mockImplementation(async (queueId: string) => [
      { id: `song-${queueId}` },
    ]);
    mockEnsureCoverArtAuth.mockResolvedValue(undefined);
    mockGetDownloadStreamUrl.mockImplementation(
      (songId: string) => `https://server.example/rest/stream.view?id=${songId}`,
    );
    mockPrimeBackgroundDownloads.mockResolvedValue(undefined);

    const parked: QueueState = {
      downloadQueue: [
        { queueId: 'queue-1', status: 'queued' },
        { queueId: 'queue-2', status: 'queued' },
        { queueId: 'queue-3', status: 'queued' },
      ],
      cachedSongs: {},
      maxConcurrentDownloads: 2,
    };
    const resumed: QueueState = {
      ...parked,
      downloadQueue: parked.downloadQueue.map((item, index) => ({
        ...item,
        status: index === 0 ? 'downloading' : 'queued',
      })),
    };
    mockGetState.mockReturnValue(resumed);

    subscribedListener!(resumed, parked);
    await flushPromises();

    expect(mockPrimeBackgroundDownloads).toHaveBeenCalledWith(
      'queue-1',
      expect.any(Array),
    );
    expect(mockPrimeBackgroundDownloads).toHaveBeenCalledWith(
      'queue-2',
      expect.any(Array),
    );
    expect(mockPrimeBackgroundDownloads).toHaveBeenCalledWith(
      'queue-3',
      expect.any(Array),
    );
  });

  it('preserves completed staging when an item is parked', async () => {
    mockStopBackgroundDownloadsForQueue.mockResolvedValue(undefined);
    const downloading = state('downloading');
    const parked = state('queued');
    mockGetState.mockReturnValue(parked);
    subscribedListener!(parked, downloading);
    await flushPromises();
    expect(mockStopBackgroundDownloadsForQueue).toHaveBeenLastCalledWith('queue-1', true);
  });
});
