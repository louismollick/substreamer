import {
  completeHandler,
  createDownloadTask,
  getExistingDownloadTasks,
  setConfig,
} from '@kesha-antonov/react-native-background-downloader';
import { Directory, File, Paths } from 'expo-file-system';
import { type EventSubscription } from 'expo-modules-core';

import { resolveServerBase } from '../../expo-ssl-trust/src';

import { type DownloadProgressEvent } from './ExpoAsyncFsModule';

const STAGING_DIR_NAME = 'substreamer-background-downloads';
const OWNER = 'substreamer';

type BackgroundTask = Awaited<ReturnType<typeof getExistingDownloadTasks>>[number];

type BackgroundMetadata = {
  owner?: string;
  queueId?: string;
  downloadId?: string;
  stagingUri?: string;
};

type ManagedDownload = {
  task: BackgroundTask;
  queueId: string;
  downloadId: string;
  stagingUri: string;
  completion: Promise<{ bytes: number }>;
};

export type BackgroundDownloadRequest = {
  downloadId: string;
  url: string;
  position: number;
};

const downloadsById = new Map<string, ManagedDownload>();
const cancelledDownloadIds = new Set<string>();
const activeProgressIds = new Set<string>();
const progressListeners = new Set<(event: DownloadProgressEvent) => void>();
let existingTasksPromise: Promise<void> | null = null;
let directSequence = 0;

function stagingDirectory(): Directory {
  const dir = new Directory(Paths.cache, STAGING_DIR_NAME);
  if (!dir.exists) dir.create();
  return dir;
}

function emitProgress(downloadId: string, bytesWritten: number, totalBytes: number): void {
  if (!activeProgressIds.has(downloadId)) return;
  const event: DownloadProgressEvent = { downloadId, bytesWritten, totalBytes };
  for (const listener of progressListeners) listener(event);
}

function taskMetadata(task: BackgroundTask): BackgroundMetadata {
  const metadata = task.metadata;
  if (!metadata || typeof metadata !== 'object') return {};
  return metadata as BackgroundMetadata;
}

function acknowledgeBackgroundEvents(taskId: string): void {
  void Promise.resolve(completeHandler(taskId)).catch(() => undefined);
}

function attachTask(
  task: BackgroundTask,
  queueId: string,
  downloadId: string,
  stagingUri: string,
): ManagedDownload {
  let resolveCompletion!: (value: { bytes: number }) => void;
  let rejectCompletion!: (reason?: unknown) => void;
  const completion = new Promise<{ bytes: number }>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Primed tasks can fail before the JS worker reaches their song. Mark the
  // rejection handled now; awaiting the original promise later still rejects.
  void completion.catch(() => undefined);

  const managed = { task, queueId, downloadId, stagingUri, completion };
  // Register before attaching callbacks or inspecting state. Reconnected tasks
  // may synchronously report a terminal state while handlers are attached.
  downloadsById.set(downloadId, managed);

  let settled = false;
  const finish = (bytes: number): void => {
    if (settled) return;
    settled = true;
    resolveCompletion({ bytes });
  };
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    if (downloadsById.get(downloadId) === managed) {
      downloadsById.delete(downloadId);
    }
    // iOS can relaunch the app to deliver a terminal background-session event.
    // Tell the OS that JS has processed the failure as well as successful jobs.
    acknowledgeBackgroundEvents(task.id);
    rejectCompletion(error);
  };

  task
    .progress(({ bytesDownloaded, bytesTotal }) => {
      emitProgress(downloadId, bytesDownloaded, bytesTotal);
    })
    .done(({ bytesDownloaded, bytesTotal }) => {
      emitProgress(downloadId, bytesDownloaded, bytesTotal);
      finish(bytesDownloaded);
    })
    .error(({ error, errorCode }) => {
      fail(new Error(`${error} (${errorCode})`));
    });

  if (task.state === 'DONE') {
    finish(task.bytesDownloaded);
  } else if (task.state === 'FAILED' || task.state === 'STOPPED') {
    fail(new Error(`Background download ${task.state.toLowerCase()}: ${downloadId}`));
  }

  return managed;
}

async function loadExistingTasks(): Promise<void> {
  if (existingTasksPromise) return existingTasksPromise;
  existingTasksPromise = (async () => {
    const tasks = await getExistingDownloadTasks();
    for (const task of tasks) {
      const metadata = taskMetadata(task);
      if (
        metadata.owner !== OWNER ||
        !metadata.queueId ||
        !metadata.downloadId ||
        !metadata.stagingUri
      ) {
        continue;
      }
      if (downloadsById.has(metadata.downloadId)) continue;
      attachTask(
        task,
        metadata.queueId,
        metadata.downloadId,
        metadata.stagingUri,
      );
    }
  })().catch((error) => {
    existingTasksPromise = null;
    throw error;
  });
  return existingTasksPromise;
}

function createManagedDownload(
  queueId: string,
  request: BackgroundDownloadRequest,
): ManagedDownload {
  const taskId = `substreamer-${queueId}-${request.position}`;
  const staging = new File(stagingDirectory(), `${taskId}.download`);
  if (staging.exists) {
    try { staging.delete(); } catch { /* best-effort stale staging cleanup */ }
  }

  const task = createDownloadTask({
    id: taskId,
    url: request.url,
    destination: staging.uri,
    metadata: {
      owner: OWNER,
      queueId,
      downloadId: request.downloadId,
      stagingUri: staging.uri,
    },
  });
  const managed = attachTask(task, queueId, request.downloadId, staging.uri);
  task.start();
  return managed;
}

/**
 * True when an iOS background URLSession can reach this URL directly.
 * Trusted self-signed servers are handled by expo-ssl-trust's in-process
 * URLProtocol/proxy path, neither of which is available to background sessions.
 */
export function canUseBackgroundDownloadUrl(url: string): boolean {
  return resolveServerBase(url) === url;
}

/**
 * Submit every transfer for the active queue item to iOS before React Native
 * can be suspended. The native URLSession owns scheduling from this point on;
 * maxParallelDownloads limits simultaneous connections without leaving later
 * tracks dependent on a JS worker wake-up.
 */
export async function primeBackgroundDownloads(
  queueId: string,
  requests: readonly BackgroundDownloadRequest[],
  maxParallelDownloads: number,
): Promise<void> {
  await loadExistingTasks();
  setConfig({ maxParallelDownloads });

  for (const request of requests) {
    cancelledDownloadIds.delete(request.downloadId);
    const existing = downloadsById.get(request.downloadId);
    if (existing) {
      // The worker may have created a direct fallback before proactive priming
      // won the race. Adopt it into the real queue so a later park/cancel stops it.
      existing.queueId = queueId;
      continue;
    }
    createManagedDownload(queueId, request);
  }
}

/**
 * Await a primed native transfer and hand its staged file back to the existing
 * expo-async-fs contract. If the scheduler lost the race, create the task here
 * so direct callers still get the same background-capable behavior.
 */
export async function consumeBackgroundDownload(
  url: string,
  destinationUri: string,
  downloadId: string,
): Promise<{ uri: string; bytes: number }> {
  await loadExistingTasks();

  let managed = downloadsById.get(downloadId);
  if (!managed) {
    // A queue transition deliberately stopped this song. The existing music
    // worker retries once after a failed transfer, so block that retry until
    // the queue is claimed again and primeBackgroundDownloads clears the mark.
    if (cancelledDownloadIds.has(downloadId)) {
      throw new Error(`Background download cancelled: ${downloadId}`);
    }
    managed = createManagedDownload(`direct-${Date.now()}-${++directSequence}`, {
      downloadId,
      url,
      position: 0,
    });
  }

  activeProgressIds.add(downloadId);
  try {
    const result = await managed.completion;
    const source = new File(managed.stagingUri);
    if (!source.exists) {
      throw new Error(`Background download completed without a staged file: ${downloadId}`);
    }

    const destination = new File(destinationUri);
    if (destination.exists) {
      try { destination.delete(); } catch { /* destination is a disposable tmp file */ }
    }
    await source.move(destination);

    const bytes = destination.exists ? (destination.size ?? result.bytes) : result.bytes;
    await Promise.resolve(completeHandler(managed.task.id));
    if (downloadsById.get(downloadId) === managed) {
      downloadsById.delete(downloadId);
    }
    return { uri: destination.uri, bytes };
  } catch (error) {
    // Network/native failures should allow downloadSong's retry-once path to
    // create a fresh task. Cancellation is tracked separately above.
    if (downloadsById.get(downloadId) === managed) {
      downloadsById.delete(downloadId);
    }
    try {
      const staging = new File(managed.stagingUri);
      if (staging.exists) staging.delete();
    } catch { /* best-effort */ }
    throw error;
  } finally {
    activeProgressIds.delete(downloadId);
  }
}

/** Stop native transfers belonging to a queue item that was cancelled/parked. */
export async function stopBackgroundDownloadsForQueue(queueId: string): Promise<void> {
  await loadExistingTasks().catch(() => undefined);
  const matching = Array.from(downloadsById.values()).filter(
    (download) => download.queueId === queueId,
  );

  await Promise.all(
    matching.map(async (download) => {
      cancelledDownloadIds.add(download.downloadId);
      try { await download.task.stop(); } catch { /* best-effort */ }

      // A retry/re-prime may have replaced this task while stop() was in flight.
      // Never let stale cleanup delete the replacement's staging file or map entry.
      const current = downloadsById.get(download.downloadId);
      if (current && current !== download) return;

      try {
        const staging = new File(download.stagingUri);
        if (staging.exists) staging.delete();
      } catch { /* best-effort */ }
      activeProgressIds.delete(download.downloadId);
      if (current === download) {
        downloadsById.delete(download.downloadId);
      }
    }),
  );
}

export function addBackgroundDownloadProgressListener(
  listener: (event: DownloadProgressEvent) => void,
): EventSubscription {
  progressListeners.add(listener);
  return {
    remove: () => {
      progressListeners.delete(listener);
    },
  } as EventSubscription;
}
