/**
 * Keeps the download queue running in the background on iOS 26+ through a
 * user-started continued-processing task. Elsewhere every call is a no-op and
 * the queue runs in the foreground only.
 */
import {
  addContinuedProcessingExpiredListener,
  beginContinuedProcessing,
  endContinuedProcessing,
  isContinuedProcessingActive,
  isContinuedProcessingSupported,
  isDownloadDiagnosticsEnabled,
  logDownloadDiagnostic,
  setContinuedProcessingProgress,
} from 'expo-continued-processing';
import { AppState } from 'react-native';

import i18n from '../i18n/i18n';
import { downloadResumePromptStore } from '../store/downloadResumePromptStore';
import { fullLibraryDownloadStore } from '../store/fullLibraryDownloadStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { storageLimitStore } from '../store/storageLimitStore';

import type { DownloadQueueItem } from '../store/musicCacheStore';

const HEARTBEAT_MS = 5000;

/** Songs still to download across queued and in-progress items. */
export function remainingQueuedSongs(
  queue: readonly DownloadQueueItem[] = musicCacheStore.getState().downloadQueue,
): number {
  let remaining = 0;
  for (const item of queue) {
    if (item.status !== 'queued' && item.status !== 'downloading') continue;
    remaining += Math.max(0, item.totalSongs - item.completedSongs);
  }
  return remaining;
}

let unsubscribeProgress: (() => void) | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
/** The system refused the last request; cleared by the next accepted one. */
let beginRefused = false;

/** Songs finished since the running task began, and the remaining count last
 *  seen. Both come from one queue snapshot, so the total never flickers. */
let songsDone = 0;
let lastRemaining = 0;
/** Albums and playlists a full-library run has to queue, and has queued, during
 *  this task. Counted as progress units so queueing work moves the bar, and kept
 *  after queueing ends so the bar never drops back. */
let libraryUnitsTotal = 0;
let libraryUnitsDone = 0;

function progressSubtitle(completed: number, total: number): string {
  return i18n.t('backgroundDownloadProgress', { completed, total });
}

/** Returns true while the full library is still being queued. */
function trackLibraryUnits(): boolean {
  const library = fullLibraryDownloadStore.getState();
  const toQueue = library.albumsTotal + library.playlistsTotal;
  if (library.active && toQueue > 0) {
    libraryUnitsTotal = Math.max(libraryUnitsTotal, toQueue);
    libraryUnitsDone = Math.max(libraryUnitsDone, library.albumsQueued + library.playlistsQueued);
    return library.phase === 'queueing';
  }
  libraryUnitsDone = libraryUnitsTotal;
  return false;
}

/** One progress measure: queueing units plus songs. Completed never decreases. */
function progressCounts(remaining: number): { completed: number; total: number } {
  return {
    completed: libraryUnitsDone + songsDone,
    total: libraryUnitsTotal + songsDone + remaining,
  };
}

function reportProgress(): void {
  const { downloadQueue } = musicCacheStore.getState();
  const queueing = trackLibraryUnits();
  // Ends only once no item is queued or still being finalised, so the last
  // item's completion write lands while the task keeps the app running.
  if (!queueing && !downloadQueue.some((q) => q.status === 'queued' || q.status === 'downloading')) {
    endBackgroundDownloads(!downloadQueue.some((q) => q.status === 'error'));
    return;
  }
  const remaining = remainingQueuedSongs(downloadQueue);
  if (remaining < lastRemaining) songsDone += lastRemaining - remaining;
  lastRemaining = remaining;
  const { completed, total } = progressCounts(remaining);
  const subtitle = queueing
    ? i18n.t('backgroundDownloadQueueing', { completed: libraryUnitsDone, total: libraryUnitsTotal })
    : progressSubtitle(songsDone, songsDone + remaining);
  setContinuedProcessingProgress(completed, total, subtitle);
}

function startTracking(): void {
  if (unsubscribeProgress) return;
  const unsubscribeQueue = musicCacheStore.subscribe((state, prev) => {
    if (state.downloadQueue === prev.downloadQueue) return;
    reportProgress();
  });
  const unsubscribeLibrary = fullLibraryDownloadStore.subscribe(() => reportProgress());
  unsubscribeProgress = () => {
    unsubscribeQueue();
    unsubscribeLibrary();
  };
  if (isDownloadDiagnosticsEnabled()) {
    heartbeat = setInterval(() => {
      logDownloadEvent('heartbeat', {
        appState: AppState.currentState,
        remaining: remainingQueuedSongs(),
        cachedSongs: Object.keys(musicCacheStore.getState().cachedSongs).length,
        queueItems: musicCacheStore.getState().downloadQueue.length,
      });
    }, HEARTBEAT_MS);
  }
}

function stopTracking(): void {
  unsubscribeProgress?.();
  unsubscribeProgress = null;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/**
 * Start the background task, or raise the running one's total. Call from a
 * user's download tap: iOS only grants the task for a foreground user action.
 */
export async function beginBackgroundDownloads(): Promise<void> {
  if (!isContinuedProcessingSupported()) return;
  if (AppState.currentState !== 'active') return;
  const remaining = remainingQueuedSongs();
  if (remaining === 0) return;

  const wasActive = isContinuedProcessingActive();
  if (!wasActive) {
    songsDone = 0;
    libraryUnitsTotal = 0;
    libraryUnitsDone = 0;
  }
  lastRemaining = remaining;
  trackLibraryUnits();
  const { total } = progressCounts(remaining);
  const ok = await beginContinuedProcessing(
    i18n.t('backgroundDownloadTitle'),
    progressSubtitle(songsDone, songsDone + remaining),
    total,
  );
  logDownloadEvent('task.begin', { ok, wasActive, total });
  if (!ok) {
    // Refusals such as Background App Refresh being off persist; stop offering
    // a Resume that cannot work until the next launch.
    beginRefused = true;
    return;
  }
  beginRefused = false;
  downloadResumePromptStore.getState().clearDismissed();
  startTracking();
}

/** Complete the background task, if one is running. */
export function endBackgroundDownloads(success: boolean): void {
  stopTracking();
  if (isContinuedProcessingActive()) {
    endContinuedProcessing(success);
    logDownloadEvent('task.end', { success });
  }
}

/**
 * Run `fn` when the system expires the task or the user cancels it from the
 * Live Activity. Native has already cancelled in-flight transfers.
 */
export function onBackgroundDownloadsExpired(fn: () => void): { remove: () => void } {
  return addContinuedProcessingExpiredListener(() => {
    stopTracking();
    logDownloadEvent('task.expired');
    fn();
  });
}

/**
 * Whether background downloading can be resumed: work is pending, nothing is
 * running it in the background, and it could actually make progress.
 */
export function canResumeInBackground(): boolean {
  if (!isContinuedProcessingSupported()) return false;
  if (isContinuedProcessingActive()) return false;
  if (beginRefused) return false;
  if (offlineModeStore.getState().offlineMode) return false;
  if (storageLimitStore.getState().isStorageFull) return false;
  return remainingQueuedSongs() > 0;
}

/** {@link canResumeInBackground}, unless the user chose "Not now". */
export function shouldOfferResume(): boolean {
  return !downloadResumePromptStore.getState().dismissed && canResumeInBackground();
}

/** Append to the on-device diagnostics log (diagnostics builds only). */
export function logDownloadEvent(event: string, fields: Record<string, unknown> = {}): void {
  if (!isDownloadDiagnosticsEnabled()) return;
  logDownloadDiagnostic({ src: 'js', event, ts: Date.now(), ...fields });
}
