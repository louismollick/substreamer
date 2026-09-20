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
let primeOperation: Promise<void> = Promise.resolve();
let primingPaused = false;

function serializePrime(operation: () => Promise<void>): Promise<void> {
  const next = primeOperation
    .catch(() => undefined)
    .then(operation);
  primeOperation = next;
  return next;
}

function isPrimeable(item: DownloadQueueItem | undefined): boolean {
  return item?.status === 'queued' || item?.status === 'downloading';
}

/**
 * Wait for priming already scheduled from earlier queue states before releasing
 * ownership. On restart this lets shared songs rebuild all live queue owners
 * before cancellation can stop their one native transfer.
 */
async function stopQueueAfterPendingPrimes(
  queueId: string,
  preserveCompleted = false,
): Promise<void> {
  const pendingPrimes = primeOperation;
  await pendingPrimes.catch(() => undefined);
  await stopBackgroundDownloadsForQueue(queueId, preserveCompleted);
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
    if (primingPaused || !isPrimeable(current)) return;

    const songs = await readDownloadQueueSongsAsync(item.queueId);
    if (songs.length === 0) return;

    await ensureCoverArtAuth();

    current = musicCacheStore.getState().downloadQueue.find(
      (queued) => queued.queueId === item.queueId,
    );
    if (primingPaused || !isPrimeable(current)) return;

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
      // The state transition may have scheduled its stop before this async
      // prime actually created native work. Queue a second cleanup behind this
      // operation; it will also wait for sibling priming to rebuild shared owners.
      scheduleQueueOperation(item.queueId, () =>
        stopQueueAfterPendingPrimes(item.queueId),
      );
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
    primingPaused = true;
    for (const item of state.downloadQueue) {
      if (!isPrimeable(item)) continue;
      scheduleQueueOperation(item.queueId, () =>
        stopQueueAfterPendingPrimes(item.queueId, true),
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
    if (queueStarted) primingPaused = false;

    for (const item of state.downloadQueue) {
      if (!isPrimeable(item)) continue;
      const before = previousById.get(item.queueId);
      if (queueStarted || !isPrimeable(before)) {
        scheduleQueueOperation(item.queueId, () =>
          serializePrime(() => primeQueueItem(item)),
        );
      }
    }
  }

  // Removed/error items no longer own native work. A parked item is handled by
  // the queue-wide stop above because its queued siblings must stop as well.
  for (const item of previous.downloadQueue) {
    const current = currentById.get(item.queueId);
    if (!current || !isPrimeable(current)) {
      scheduleQueueOperation(item.queueId, () =>
        stopQueueAfterPendingPrimes(item.queueId),
      );
    }
  }
}

if (Platform.OS === 'ios') {
  musicCacheStore.subscribe(onQueueChanged);
}
