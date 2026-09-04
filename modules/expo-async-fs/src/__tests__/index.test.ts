import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import ExpoAsyncFsModule from '../ExpoAsyncFsModule';
import {
  listDirectoryAsync,
  getDirectorySizeAsync,
  statAsync,
  existsAsync,
  downloadFileAsyncWithProgress,
  addDownloadProgressListener,
} from '../index';

jest.mock('../ExpoAsyncFsModule');
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-file-system/legacy', () => ({
  FileSystemSessionType: { BACKGROUND: 'background', FOREGROUND: 'foreground' },
  createDownloadResumable: jest.fn(),
  getInfoAsync: jest.fn(),
}));

const mockModule = jest.mocked(ExpoAsyncFsModule);
const mockFileSystem = jest.mocked(FileSystem);

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

    expect(result).toBe(0);
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
  it('passes url, destinationUri, and downloadId to native on Android', async () => {
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
    expect(result).toEqual(expected);
  });

  it('propagates native errors on Android', async () => {
    mockModule.downloadFileAsyncWithProgress.mockRejectedValue(new Error('Network error'));

    await expect(
      downloadFileAsyncWithProgress('https://fail.com/x', 'file:///dest', 'dl-002'),
    ).rejects.toThrow('Network error');
  });

  it('uses an Expo FileSystem background session on iOS', async () => {
    setPlatform('ios');
    const downloadAsync = jest.fn().mockResolvedValue({
      uri: 'file:///dest/song.mp3',
      status: 200,
      headers: {},
    });
    mockFileSystem.createDownloadResumable.mockReturnValue({ downloadAsync } as any);
    mockFileSystem.getInfoAsync.mockResolvedValue({
      exists: true,
      uri: 'file:///dest/song.mp3',
      size: 5000,
      isDirectory: false,
      modificationTime: 1,
    } as any);

    const result = await downloadFileAsyncWithProgress(
      'https://server.com/song.mp3',
      'file:///dest/song.mp3',
      'dl-ios',
    );

    expect(mockFileSystem.createDownloadResumable).toHaveBeenCalledWith(
      'https://server.com/song.mp3',
      'file:///dest/song.mp3',
      { sessionType: FileSystem.FileSystemSessionType.BACKGROUND },
      expect.any(Function),
    );
    expect(downloadAsync).toHaveBeenCalledTimes(1);
    expect(mockModule.downloadFileAsyncWithProgress).not.toHaveBeenCalled();
    expect(result).toEqual({ uri: 'file:///dest/song.mp3', bytes: 5000 });
  });

  it('forwards Expo FileSystem progress events through the existing listener API on iOS', async () => {
    setPlatform('ios');
    const downloadAsync = jest.fn().mockResolvedValue({
      uri: 'file:///dest/song.mp3',
      status: 200,
      headers: {},
    });
    mockFileSystem.createDownloadResumable.mockReturnValue({ downloadAsync } as any);
    mockFileSystem.getInfoAsync.mockResolvedValue({
      exists: true,
      uri: 'file:///dest/song.mp3',
      size: 5000,
      isDirectory: false,
      modificationTime: 1,
    } as any);
    const listener = jest.fn();
    const subscription = addDownloadProgressListener(listener);

    const promise = downloadFileAsyncWithProgress(
      'https://server.com/song.mp3',
      'file:///dest/song.mp3',
      'dl-progress',
    );
    const progressCallback = mockFileSystem.createDownloadResumable.mock.calls[0][3];
    progressCallback?.({
      totalBytesWritten: 2000,
      totalBytesExpectedToWrite: 5000,
    });
    await promise;

    expect(listener).toHaveBeenCalledWith({
      downloadId: 'dl-progress',
      bytesWritten: 2000,
      totalBytes: 5000,
    });
    subscription.remove();
  });

  it('rejects if an iOS background download produces no result', async () => {
    setPlatform('ios');
    const downloadAsync = jest.fn().mockResolvedValue(undefined);
    mockFileSystem.createDownloadResumable.mockReturnValue({ downloadAsync } as any);

    await expect(
      downloadFileAsyncWithProgress('https://fail.com/x', 'file:///dest', 'dl-empty'),
    ).rejects.toThrow('Background download did not complete: dl-empty');
  });
});

describe('addDownloadProgressListener', () => {
  it('subscribes to native onDownloadProgress events on Android', () => {
    const listener = jest.fn();
    const mockSubscription = { remove: jest.fn() };
    mockModule.addListener.mockReturnValue(mockSubscription);

    const subscription = addDownloadProgressListener(listener);

    expect(mockModule.addListener).toHaveBeenCalledWith('onDownloadProgress', listener);
    expect(subscription).toBe(mockSubscription);
  });

  it('returns a native subscription with remove() on Android', () => {
    const mockRemove = jest.fn();
    mockModule.addListener.mockReturnValue({ remove: mockRemove });

    const subscription = addDownloadProgressListener(jest.fn());
    subscription.remove();

    expect(mockRemove).toHaveBeenCalled();
  });

  it('uses a local removable listener for Expo FileSystem progress on iOS', () => {
    setPlatform('ios');
    const listener = jest.fn();

    const subscription = addDownloadProgressListener(listener);

    expect(mockModule.addListener).not.toHaveBeenCalled();
    expect(subscription).toEqual(expect.objectContaining({ remove: expect.any(Function) }));
    subscription.remove();
  });
});
