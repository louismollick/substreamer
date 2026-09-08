import {
  completeHandler,
  createDownloadTask,
  getExistingDownloadTasks,
  setConfig,
} from '@kesha-antonov/react-native-background-downloader';
import { Directory, File, Paths } from 'expo-file-system';
import { type EventSubscription } from 'expo-modules-core';

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
const activeProgressIds = new Set<string>();
const progressListeners = new Set<(event: DownloadProgressEvent) => void>();
let existingTasksPromise: Promise<void> | null = null;

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

  task
    .progress(({ bytesDownloaded, bytesTotal }) => {
      emitProgress(downloadId, bytesDownloaded, bytesTotal);
    })
    .done(({ bytesDownloaded, bytesTotal }) => {
      emitProgress(downloadId, bytesDownloaded, bytesTotal);
      resolveCompletion({ bytes: bytesDownloaded });
    })
    .error(({ error, errorCode }) => {
      rejectCompletion(new Error(`${error} (${errorCode})`));
    });

  if (task.state === 'DONE') {
    resolveCompletion({ bytes: task.bytesDownloaded });
  } else if (task.state === 'FAILED' || task.state === 'STOPPED') {
    rejectCompletion(new Error(`Background download ${task.state.toLowerCase()}: ${downloadId}`));
  }

  const managed = { task, queueId, downloadId, stagingUri, completion };
  downloadsById.set(downloadId, managed);
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
    const existing = downloadsById.get(request.downloadId);
    if (existing) continue;
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
    managed = createManagedDownload(`direct-${Date.now()}`, {
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
    downloadsById.delete(downloadId);
    return { uri: destination.uri, bytes };
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
      try { await download.task.stop(); } catch { /* best-effort */ }
      try {
        const staging = new File(download.stagingUri);
        if (staging.exists) staging.delete();
      } catch { /* best-effort */ }
      activeProgressIds.delete(download.downloadId);
      downloadsById.delete(download.downloadId);
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
