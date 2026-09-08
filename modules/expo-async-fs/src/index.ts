import { type EventSubscription } from 'expo-modules-core';
import { Platform } from 'react-native';

import ExpoAsyncFsModule from './ExpoAsyncFsModule';
import {
  addBackgroundDownloadProgressListener,
  canUseBackgroundDownloadUrl,
  consumeBackgroundDownload,
  primeBackgroundDownloads,
  stopBackgroundDownloadsForQueue,
  type BackgroundDownloadRequest,
} from './backgroundDownloader';

export { type DownloadProgressEvent, type DirectoryEntry, type StatResult } from './ExpoAsyncFsModule';
export {
  canUseBackgroundDownloadUrl,
  primeBackgroundDownloads,
  stopBackgroundDownloadsForQueue,
  type BackgroundDownloadRequest,
};

/**
 * List directory contents asynchronously on a native background thread.
 * Returns an array of entry names (not full paths).
 *
 * A MISSING path resolves to `[]`; a path that exists but cannot be read
 * REJECTS. Callers that delete state for whatever they don't see must treat an
 * empty array as "genuinely empty" and a rejection as "no reliable view".
 */
export function listDirectoryAsync(uri: string): Promise<string[]> {
  return ExpoAsyncFsModule.listDirectoryAsync(uri);
}

/**
 * List directory contents with each entry's size and type in a single
 * off-thread native call. Avoids a sync `File.exists`/`File.size` stat per
 * child on the JS thread (those are sync-only in expo-file-system). `size` is
 * 0 for directories.
 *
 * Same missing-vs-unreadable contract as {@link listDirectoryAsync}.
 */
export function listDirectoryWithSizesAsync(
  uri: string,
): Promise<import('./ExpoAsyncFsModule').DirectoryEntry[]> {
  return ExpoAsyncFsModule.listDirectoryWithSizesAsync(uri);
}

/**
 * Stat a path on a native background thread: existence, byte size, and whether
 * it's a directory, in one off-thread call. `size` is 0 for missing entries and
 * directories. Use this instead of expo-file-system's sync `File.exists` /
 * `.size` on hot/interactive paths — those block the JS thread.
 */
export function statAsync(
  uri: string,
): Promise<import('./ExpoAsyncFsModule').StatResult> {
  return ExpoAsyncFsModule.statAsync(uri);
}

/** Convenience over {@link statAsync}: resolves true when the path exists. */
export function existsAsync(uri: string): Promise<boolean> {
  return ExpoAsyncFsModule.statAsync(uri).then((r) => r.exists);
}

/** Delete a single file on a native background thread. */
export function deleteFileAsync(uri: string): Promise<boolean> {
  return ExpoAsyncFsModule.deleteFileAsync(uri);
}

/** Recursively delete a directory and all its contents off the JS thread. */
export function deleteDirectoryAsync(uri: string): Promise<boolean> {
  return ExpoAsyncFsModule.deleteDirectoryAsync(uri);
}

/** Calculate total size (in bytes) of a directory recursively off-thread. */
export function getDirectorySizeAsync(uri: string): Promise<number> {
  return ExpoAsyncFsModule.getDirectorySizeAsync(uri);
}

/**
 * Download a file with progress events.
 *
 * Android keeps the existing native expo-async-fs implementation. iOS consumes
 * a persistent background task when the URL is reachable by a system background
 * session. Trusted self-signed hosts stay on the existing foreground path because
 * their custom trust handler is process-local.
 */
export function downloadFileAsyncWithProgress(
  url: string,
  destinationUri: string,
  downloadId: string,
): Promise<{ uri: string; bytes: number }> {
  if (Platform.OS === 'ios' && canUseBackgroundDownloadUrl(url)) {
    return consumeBackgroundDownload(url, destinationUri, downloadId);
  }
  return ExpoAsyncFsModule.downloadFileAsyncWithProgress(url, destinationUri, downloadId);
}

/** Subscribe to download progress events. */
export function addDownloadProgressListener(
  listener: (event: { downloadId: string; bytesWritten: number; totalBytes: number }) => void,
): EventSubscription {
  if (Platform.OS === 'ios') {
    const backgroundSubscription = addBackgroundDownloadProgressListener(listener);
    const foregroundSubscription = ExpoAsyncFsModule.addListener('onDownloadProgress', listener);
    return {
      remove: () => {
        backgroundSubscription.remove();
        foregroundSubscription.remove();
      },
    } as EventSubscription;
  }
  return ExpoAsyncFsModule.addListener('onDownloadProgress', listener);
}
