import { Platform } from 'react-native';

import ExpoAsyncFsModule from '../ExpoAsyncFsModule';
import {
  consumeBackgroundDownload,
  addBackgroundDownloadProgressListener,
} from '../backgroundDownloader';
import {
  listDirectoryAsync,
  getDirectorySizeAsync,
  statAsync,
  existsAsync,
  downloadFileAsyncWithProgress,
  addDownloadProgressListener,
} from '../index';

jest.mock('../ExpoAsyncFsModule');
jest.mock('../backgroundDownloader', () => ({
  consumeBackgroundDownload: jest.fn(),
  addBackgroundDownloadProgressListener: jest.fn(),
  primeBackgroundDownloads: jest.fn(),
  stopBackgroundDownloadsForQueue: jest.fn(),
}));

const mockModule = jest.mocked(ExpoAsyncFsModule);
const mockConsumeBackgroundDownload = jest.mocked(consumeBackgroundDownload);
const mockAddBackgroundDownloadProgressListener = jest.mocked(
  addBackgroundDownloadProgressListener,
);

function setPlatform(os: 'ios' | 'android'): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  setPlatform('android');
});

describe('listDirectoryAsync', () => {
  it('delegates to native with the given URI', async () => {
    mockModule.listDirectoryAsync.mockResolvedValue(['a.txt', 'b.mp3']);
    const result = await listDirectoryAsync('file:///data/music');

    expect(mockModule.listDirectoryAsync).toHaveBeenCalledWith('file:///data/music');
    expect(result).toEqual(['a.txt', 'b.mp3']);
  });

  it('returns empty array by default', async () => {
    mockModule.listDirectoryAsync.mockResolvedValue([]);
    const result = await listDirectoryAsync('file:///empty');

    expect(result).toEqual([]);
  });

  it('propagates native errors', async () => {
    mockModule.listDirectoryAsync.mockRejectedValue(new Error('Permission denied'));

    await expect(listDirectoryAsync('file:///protected')).rejects.toThrow('Permission denied');
  });
});

describe('getDirectorySizeAsync', () => {
  it('delegates to native with the given URI', async () => {
    mockModule.getDirectorySizeAsync.mockResolvedValue(1024);
    const result = await getDirectorySizeAsync('file:///data/music');

    expect(mockModule.getDirectorySizeAsync).toHaveBeenCalledWith('file:///data/music');
    expect(result).toBe(1024);
  });

  it('returns 0 for empty directory', async () => {
    mockModule.getDirectorySizeAsync.mockResolvedValue(0);
    const result = await getDirectorySizeAsync('file:///empty');

    expect(result).toEqual(0);
  });

  it('propagates native errors', async () => {
    mockModule.getDirectorySizeAsync.mockRejectedValue(new Error('Not found'));

    await expect(getDirectorySizeAsync('file:///nonexistent')).rejects.toThrow('Not found');
  });
});

describe('statAsync', () => {
  it('delegates to native and returns the stat result', async () => {
    const expected = { exists: true, size: 2048, isDirectory: false };
    mockModule.statAsync.mockResolvedValue(expected);

    const result = await statAsync('file:///data/cover/600.jpg');

    expect(mockModule.statAsync).toHaveBeenCalledWith('file:///data/cover/600.jpg');
    expect(result).toEqual(expected);
  });

  it('propagates native errors', async () => {
    mockModule.statAsync.mockRejectedValue(new Error('stat failed'));
    await expect(statAsync('file:///x')).rejects.toThrow('stat failed');
  });
});

describe('existsAsync', () => {
  it('resolves true when the path exists', async () => {
    mockModule.statAsync.mockResolvedValue({ exists: true, size: 10, isDirectory: false });
    await expect(existsAsync('file:///present')).resolves.toBe(true);
  });

  it('resolves false when the path is missing', async () => {
    mockModule.statAsync.mockResolvedValue({ exists: false, size: 0, isDirectory: false });
    await expect(existsAsync('file:///gone')).resolves.toBe(false);
  });
});

describe('downloadFileAsyncWithProgress', () => {
  it('uses the existing native module on Android', async () => {
    const expected = { uri: 'file:///dest/song.mp3', bytes: 5000 };
    mockModule.downloadFileAsyncWithProgress.mockResolvedValue(expected);

    const result = await downloadFileAsyncWithProgress(
      'https://server.com/song.mp3',
      'file:///dest/song.mp3',
      'dl-001',
    );

    expect(mockModule.downloadFileAsyncWithProgress).toHaveBeenCalledWith(
      'https://server.com/song.mp3',
      'file:///dest/song.mp3',
      'dl-001',
    );
    expect(mockConsumeBackgroundDownload).not.toHaveBeenCalled();
    expect(result).toEqual(expected);
  });

  it('uses the persistent background downloader on iOS', async () => {
    setPlatform('ios');
    const expected = { uri: 'file:///dest/song.mp3', bytes: 5000 };
    mockConsumeBackgroundDownload.mockResolvedValue(expected);

    const result = await downloadFileAsyncWithProgress(
      'https://server.com/song.mp3',
      'file:///dest/song.mp3',
      'dl-ios',
    );

    expect(mockConsumeBackgroundDownload).toHaveBeenCalledWith(
      'https://server.com/song.mp3',
      'file:///dest/song.mp3',
      'dl-ios',
    );
    expect(mockModule.downloadFileAsyncWithProgress).not.toHaveBeenCalled();
    expect(result).toEqual(expected);
  });

  it('propagates native errors on Android', async () => {
    mockModule.downloadFileAsyncWithProgress.mockRejectedValue(new Error('Network error'));

    await expect(
      downloadFileAsyncWithProgress('https://fail.com/x', 'file:///dest', 'dl-002'),
    ).rejects.toThrow('Network error');
  });
});

describe('addDownloadProgressListener', () => {
  it('subscribes to native onDownloadProgress events on Android', () => {
    const listener = jest.fn();
    const mockSubscription = { remove: jest.fn() };
    mockModule.addListener.mockReturnValue(mockSubscription);

    const subscription = addDownloadProgressListener(listener);

    expect(mockModule.addListener).toHaveBeenCalledWith('onDownloadProgress', listener);
    expect(mockAddBackgroundDownloadProgressListener).not.toHaveBeenCalled();
    expect(subscription).toBe(mockSubscription);
  });

  it('subscribes only to the background source on iOS', () => {
    setPlatform('ios');
    const listener = jest.fn();
    const backgroundSubscription = { remove: jest.fn() };
    mockAddBackgroundDownloadProgressListener.mockReturnValue(backgroundSubscription as never);

    const subscription = addDownloadProgressListener(listener);

    expect(mockAddBackgroundDownloadProgressListener).toHaveBeenCalledWith(listener);
    expect(mockModule.addListener).not.toHaveBeenCalled();
    expect(subscription).toBe(backgroundSubscription);
  });
});
