const mockCreateDownloadTask = jest.fn();
const mockGetExistingDownloadTasks = jest.fn();
const mockCompleteHandler = jest.fn();
const mockFiles = new Map<string, number>();

jest.mock('@kesha-antonov/react-native-background-downloader', () => ({
  completeHandler: (...args: unknown[]) => mockCompleteHandler(...args),
  createDownloadTask: (...args: unknown[]) => mockCreateDownloadTask(...args),
  getExistingDownloadTasks: (...args: unknown[]) => mockGetExistingDownloadTasks(...args),
}));

jest.mock('expo-file-system', () => {
  class MockDirectory {
    uri: string;
    exists = true;

    constructor(base: string | { uri: string }, name: string) {
      this.uri = `${typeof base === 'string' ? base : base.uri}/${name}`;
    }

    create(): void {}
  }

  class MockFile {
    uri: string;

    constructor(base: string | { uri: string }, name?: string) {
      this.uri = name
        ? `${typeof base === 'string' ? base : base.uri}/${name}`
        : typeof base === 'string'
          ? base
          : base.uri;
    }

    get exists(): boolean {
      return mockFiles.has(this.uri);
    }

    get size(): number {
      return mockFiles.get(this.uri) ?? 0;
    }

    delete(): void {
      mockFiles.delete(this.uri);
    }

    async move(destination: MockFile): Promise<void> {
      mockFiles.set(destination.uri, this.size);
      mockFiles.delete(this.uri);
    }
  }

  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { cache: 'file:///cache' },
  };
});

import {
  consumeBackgroundDownload,
  primeBackgroundDownloads,
  stopBackgroundDownloadsForQueue,
} from '../backgroundDownloader';

type ErrorHandler = (event: { error: string; errorCode: number }) => void;

function createFakeTask(id: string) {
  let errorHandler: ErrorHandler | null = null;
  const task = {
    id,
    metadata: {} as Record<string, string>,
    state: 'PENDING',
    bytesDownloaded: 0,
    bytesTotal: 0,
    progress: jest.fn(),
    done: jest.fn(),
    error: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(async () => undefined),
    fail(error = 'network failed', errorCode = -1009): void {
      errorHandler?.({ error, errorCode });
    },
  };
  task.progress.mockImplementation(() => task);
  task.done.mockImplementation(() => task);
  task.error.mockImplementation((handler: ErrorHandler) => {
    errorHandler = handler;
    return task;
  });
  return task;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFiles.clear();
  mockGetExistingDownloadTasks.mockResolvedValue([]);
  mockCompleteHandler.mockResolvedValue(undefined);
});

describe('backgroundDownloader', () => {
  it('consumes a completed task restored after process restart', async () => {
    const task = createFakeTask('substreamer-queue-4-1');
    task.state = 'DONE';
    task.bytesDownloaded = 456;
    task.bytesTotal = 456;
    task.metadata = {
      owner: 'substreamer',
      queueId: 'queue-4',
      downloadId: 'song-4',
      stagingUri: 'file:///cache/restored.download',
    };
    mockFiles.set(task.metadata.stagingUri, 456);
    mockGetExistingDownloadTasks.mockResolvedValue([task]);

    await expect(consumeBackgroundDownload(
      'https://server/song-4',
      'file:///cache/song-4.tmp',
      'song-4',
    )).resolves.toEqual({ uri: 'file:///cache/song-4.tmp', bytes: 456 });
    expect(mockCreateDownloadTask).not.toHaveBeenCalled();
    expect(mockCompleteHandler).toHaveBeenCalledWith(task.id);
  });

  it('creates a fresh task after a primed task fails before consumption', async () => {
    const firstTask = createFakeTask('substreamer-queue-1-1');
    const retryTask = createFakeTask('substreamer-direct-1-0');
    mockCreateDownloadTask
      .mockReturnValueOnce(firstTask)
      .mockReturnValueOnce(retryTask);

    await primeBackgroundDownloads(
      'queue-1',
      [{ downloadId: 'song-1', url: 'https://server/song-1', position: 1 }],
    );

    firstTask.fail();

    const retry = consumeBackgroundDownload(
      'https://server/song-1',
      'file:///cache/song-1.tmp',
      'song-1',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockCreateDownloadTask).toHaveBeenCalledTimes(2);
    expect(mockCompleteHandler).toHaveBeenCalledWith(firstTask.id);

    retryTask.fail('retry failed', -1001);
    await expect(retry).rejects.toThrow('retry failed (-1001)');
  });

  it('allows a later transfer after a queue stop', async () => {
    const firstTask = createFakeTask('substreamer-queue-2-1');
    const laterTask = createFakeTask('substreamer-direct-2-0');
    mockCreateDownloadTask
      .mockReturnValueOnce(firstTask)
      .mockReturnValueOnce(laterTask);

    await primeBackgroundDownloads(
      'queue-2',
      [{ downloadId: 'song-2', url: 'https://server/song-2', position: 1 }],
    );
    await stopBackgroundDownloadsForQueue('queue-2');

    const later = consumeBackgroundDownload(
      'https://server/song-2',
      'file:///cache/song-2.tmp',
      'song-2',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(firstTask.stop).toHaveBeenCalledTimes(1);
    expect(mockCreateDownloadTask).toHaveBeenCalledTimes(2);
    expect(laterTask.start).toHaveBeenCalledTimes(1);

    laterTask.fail('later failed', -1001);
    await expect(later).rejects.toThrow('later failed (-1001)');
  });

  it('rejects a waiting consumer when stop emits no native error', async () => {
    const task = createFakeTask('substreamer-queue-3-1');
    mockCreateDownloadTask.mockReturnValue(task);
    await primeBackgroundDownloads(
      'queue-3',
      [{ downloadId: 'song-3', url: 'https://server/song-3', position: 1 }],
    );
    const pending = consumeBackgroundDownload(
      'https://server/song-3',
      'file:///cache/song-3.tmp',
      'song-3',
    );
    const assertion = expect(pending).rejects.toThrow('Background download stopped');
    await stopBackgroundDownloadsForQueue('queue-3');
    await assertion;
  });
});
