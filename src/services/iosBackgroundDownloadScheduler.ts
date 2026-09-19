import { Platform } from 'react-native';

import {
  primeBackgroundDownloads,
  stopBackgroundDownloadsForQueue,
  type BackgroundDownloadRequest,
} from 'expo-async-fs';

import {
  musicCacheStore,
  whenQueuePayloadWritten,
  type DownloadQueueItem,
} from '../store/musicCacheStore';
import { readDownloadQueueSongsAsync } from '../store/persistence/musicCacheTables';
import { ensureCoverArtAuth, getDownloadStreamUrl } from './subsonicService';

const queueOperations = new Map<string, Promise<void>>();

function isPrimeable(item: DownloadQueueItem | undefined): boolean {
  return item?.status === 'queued' || item?.status === 'downloading';
}

function scheduleQueueOperation(queueId: string, operation: () => Promise<void>): void {
  const previous = queueOperations.get(queueId) ?? Promise.resolve();
  const next = previous
    // A failed operation must not block the next queue transition.
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (queueOperations.get(queueId) === next) {
        queueOperations.delete(queueId);
      }
    });
  queueOperations.set(queueId, next);
  // Observe failures immediately, even when no later transition is scheduled.
  void next.catch(() => undefined);
}

async function primeQueueItem(item: DownloadQueueItem): Promise<void> {
  try {
    await whenQueuePayloadWritten(item.queueId);

    let current = musicCacheStore.getState().downloadQueue.find(
      (queued) => queued.queueId === item.queueId,
    );
    if (!isPrimeable(current)) return;

    const songs = await readDownloadQueueSongsAsync(item.queueId);
    if (songs.length === 0) return;

    await ensureCoverArtAuth();

    current = musicCacheStore.getState().downloadQueue.find(
      (queued) => queued.queueId === item.queueId,
    );
    if (!isPrimeable(current)) return;

    const cachedSongs = musicCacheStore.getState().cachedSongs;
    const seen = new Set<string>();
    const requests: BackgroundDownloadRequest[] = [];

    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      if (!song.id || seen.has(song.id) || cachedSongs[song.id]) continue;
      seen.add(song.id);

      const url = getDownloadStreamUrl(song.id);
      if (!url) continue;
      requests.push({
        downloadId: song.id,
        url,
        position: i + 1,
      });
    }

    if (requests.length === 0) return;

    await primeBackgroundDownloads(item.queueId, requests);

    // A cancellation/error transition may have raced the async payload/auth
    // work above. Queued items stay primed so iOS can cross item boundaries
    // without waking JavaScript.
    current = musicCacheStore.getState().downloadQueue.find(
      (queued) => queued.queueId === item.queueId,
    );
    if (!isPrimeable(current)) {
      await stopBackgroundDownloadsForQueue(item.queueId);
    }
  } catch (error) {
    // The normal worker remains a fallback: its first download call can still
    // create a background task directly if proactive priming fails.
    // eslint-disable-next-line no-console
    console.warn('[iosBackgroundDownloadScheduler] Failed to prime queue item:', error);
  }
}

function onQueueChanged(
  state: ReturnType<typeof musicCacheStore.getState>,
  previous: ReturnType<typeof musicCacheStore.getState>,
): void {
  const previousById = new Map(previous.downloadQueue.map((item) => [item.queueId, item]));
  const currentById = new Map(state.downloadQueue.map((item) => [item.queueId, item]));

  // A downloading -> queued transition is the worker parking the queue for
  // offline/storage/recovery. Future queued items are already native tasks now,
  // so stop all of them too. Completed staging files survive and can be consumed
  // after the queue resumes.
  const queueParked = state.downloadQueue.some(
    (item) =>
      item.status === 'queued' &&
      previousById.get(item.queueId)?.status === 'downloading',
  );

  if (queueParked) {
    for (const item of state.downloadQueue) {
      if (!isPrimeable(item)) continue;
      scheduleQueueOperation(item.queueId, () =>
        stopBackgroundDownloadsForQueue(item.queueId, true),
      );
    }
  } else {
    // Starting/resuming one item re-primes the whole queue. This matters after a
    // park, where queued siblings were stopped without changing their status.
    const queueStarted = state.downloadQueue.some(
      (item) =>
        item.status === 'downloading' &&
        previousById.get(item.queueId)?.status !== 'downloading',
    );

    for (const item of state.downloadQueue) {
      if (!isPrimeable(item)) continue;
      const before = previousById.get(item.queueId);
      if (queueStarted || !isPrimeable(before)) {
        scheduleQueueOperation(item.queueId, () => primeQueueItem(item));
      }
    }
  }

  // Removed/error items no longer own native work. A parked item is handled by
  // the queue-wide stop above because its queued siblings must stop as well.
  for (const item of previous.downloadQueue) {
    const current = currentById.get(item.queueId);
    if (!current || !isPrimeable(current)) {
      scheduleQueueOperation(item.queueId, () =>
        stopBackgroundDownloadsForQueue(item.queueId),
      );
    }
  }
}

if (Platform.OS === 'ios') {
  musicCacheStore.subscribe(onQueueChanged);
}
