const mockCreateDownloadTask = jest.fn();
const mockGetExistingDownloadTasks = jest.fn();
const mockCompleteHandler = jest.fn();
const mockSetConfig = jest.fn();
const mockResolveServerBase = jest.fn((url: string) => url);

jest.mock('@kesha-antonov/react-native-background-downloader', () => ({
  completeHandler: (...args: unknown[]) => mockCompleteHandler(...args),
  createDownloadTask: (...args: unknown[]) => mockCreateDownloadTask(...args),
  getExistingDownloadTasks: (...args: unknown[]) => mockGetExistingDownloadTasks(...args),
  setConfig: (...args: unknown[]) => mockSetConfig(...args),
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
    exists = false;
    size = 0;

    constructor(base: string | { uri: string }, name?: string) {
      this.uri = name
        ? `${typeof base === 'string' ? base : base.uri}/${name}`
        : typeof base === 'string'
          ? base
          : base.uri;
    }

    delete(): void {
      this.exists = false;
    }

    async move(destination: MockFile): Promise<void> {
      destination.exists = true;
      destination.size = this.size;
      this.exists = false;
    }
  }

  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { cache: 'file:///cache' },
  };
});

jest.mock('../../../expo-ssl-trust/src', () => ({
  resolveServerBase: (url: string) => mockResolveServerBase(url),
}));

import {
  canUseBackgroundDownloadUrl,
  consumeBackgroundDownload,
  primeBackgroundDownloads,
} from '../backgroundDownloader';

type ErrorHandler = (event: { error: string; errorCode: number }) => void;

function createFakeTask(id: string) {
  let errorHandler: ErrorHandler | null = null;
  const task = {
    id,
    metadata: {},
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
  mockGetExistingDownloadTasks.mockResolvedValue([]);
  mockCompleteHandler.mockResolvedValue(undefined);
  mockResolveServerBase.mockImplementation((url: string) => url);
});

describe('backgroundDownloader', () => {
  it('creates a fresh task after a primed task fails before consumption', async () => {
    const firstTask = createFakeTask('substreamer-queue-1-1');
    const retryTask = createFakeTask('substreamer-direct-1-0');
    mockCreateDownloadTask
      .mockReturnValueOnce(firstTask)
      .mockReturnValueOnce(retryTask);

    await primeBackgroundDownloads(
      'queue-1',
      [{ downloadId: 'song-1', url: 'https://server/song-1', position: 1 }],
      2,
    );

    firstTask.fail();

    const retry = consumeBackgroundDownload(
      'https://server/song-1',
      'file:///cache/song-1.tmp',
      'song-1',
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCreateDownloadTask).toHaveBeenCalledTimes(2);
    expect(mockCompleteHandler).toHaveBeenCalledWith(firstTask.id);

    retryTask.fail('retry failed', -1001);
    await expect(retry).rejects.toThrow('retry failed (-1001)');
  });

  it('rejects URLs that need the in-process trust proxy', () => {
    mockResolveServerBase.mockReturnValue('http://127.0.0.1:1234/token');

    expect(canUseBackgroundDownloadUrl('https://self-signed.example/rest/stream.view')).toBe(false);
  });
});
