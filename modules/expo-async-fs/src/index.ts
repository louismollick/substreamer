import * as FileSystem from 'expo-file-system/legacy';
import { type EventSubscription } from 'expo-modules-core';
import { Platform } from 'react-native';

import ExpoAsyncFsModule, {
  type DownloadProgressEvent,
  type DirectoryEntry,
  type StatResult,
} from './ExpoAsyncFsModule';

export type { DownloadProgressEvent, DirectoryEntry, StatResult };

const iosDownloadProgressListeners = new Set<(event: DownloadProgressEvent) => void>();

function emitIosDownloadProgress(event: DownloadProgressEvent): void {
  for (const listener of iosDownloadProgressListeners) {
    listener(event);
  }
}

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
): Promise<DirectoryEntry[]> {
  return ExpoAsyncFsModule.listDirectoryWithSizesAsync(uri);
}

/**
 * Stat a path on a native background thread: existence, byte size, and whether
 * it's a directory, in one off-thread call. `size` is 0 for missing entries and
 * directories. Use this instead of expo-file-system's sync `File.exists` /
 * `.size` on hot/interactive paths — those block the JS thread.
 */
export function statAsync(uri: string): Promise<StatResult> {
  return ExpoAsyncFsModule.statAsync(uri);
}

/**
 * Convenience over {@link statAsync}: resolves true when the path exists.
 */
export function existsAsync(uri: string): Promise<boolean> {
  return ExpoAsyncFsModule.statAsync(uri).then((r) => r.exists);
}

/**
 * Delete a single file on a native background thread. Resolves true if a file
 * existed and was deleted, false otherwise.
 */
export function deleteFileAsync(uri: string): Promise<boolean> {
  return ExpoAsyncFsModule.deleteFileAsync(uri);
}

/**
 * Recursively delete a directory and all its contents on a native background
 * thread (Android: Dispatchers.IO). For whole-cache wipes — expo-file-system's
 * `Directory.delete()` is sync-only and would block the JS thread unlinking
 * thousands of files. Resolves true if the directory existed and was removed.
 */
export function deleteDirectoryAsync(uri: string): Promise<boolean> {
  return ExpoAsyncFsModule.deleteDirectoryAsync(uri);
}

/**
 * Calculate total size (in bytes) of a directory recursively
 * on a native background thread.
 */
export function getDirectorySizeAsync(uri: string): Promise<number> {
  return ExpoAsyncFsModule.getDirectorySizeAsync(uri);
}

/**
 * Download a file with progress events.
 *
 * Android keeps the existing native implementation. On iOS, use Expo
 * FileSystem's legacy DownloadResumable API with an explicit BACKGROUND
 * session. That hands the transfer to iOS's background URLSession machinery,
 * so the bytes can keep moving after React Native is suspended.
 *
 * Progress callbacks pause while JS is suspended and resume when the app gets
 * execution again; the underlying iOS transfer itself continues.
 */
export async function downloadFileAsyncWithProgress(
  url: string,
  destinationUri: string,
  downloadId: string,
): Promise<{ uri: string; bytes: number }> {
  if (Platform.OS !== 'ios') {
    return ExpoAsyncFsModule.downloadFileAsyncWithProgress(url, destinationUri, downloadId);
  }

  const resumable = FileSystem.createDownloadResumable(
    url,
    destinationUri,
    { sessionType: FileSystem.FileSystemSessionType.BACKGROUND },
    (progress) => {
      emitIosDownloadProgress({
        downloadId,
        bytesWritten: progress.totalBytesWritten,
        totalBytes: progress.totalBytesExpectedToWrite,
      });
    },
  );

  const result = await resumable.downloadAsync();
  if (!result) {
    throw new Error(`Background download did not complete: ${downloadId}`);
  }

  const info = await FileSystem.getInfoAsync(result.uri, { size: true });
  return {
    uri: result.uri,
    bytes: info.exists ? (info.size ?? 0) : 0,
  };
}

/**
 * Subscribe to download progress events. Each event contains
 * downloadId, bytesWritten, and totalBytes (-1 if unknown).
 *
 * On iOS the events come from Expo FileSystem's progress callback. Elsewhere
 * they continue to come from the expo-async-fs native module.
 */
export function addDownloadProgressListener(
  listener: (event: DownloadProgressEvent) => void,
): EventSubscription {
  if (Platform.OS !== 'ios') {
    return ExpoAsyncFsModule.addListener('onDownloadProgress', listener);
  }

  iosDownloadProgressListeners.add(listener);
  return {
    remove: () => {
      iosDownloadProgressListeners.delete(listener);
    },
  } as EventSubscription;
}
