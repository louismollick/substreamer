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

function scheduleQueueOperation(queueId: string, operation: () => Promise<void>): void {
  const previous = queueOperations.get(queueId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (queueOperations.get(queueId) === next) {
        queueOperations.delete(queueId);
      }
    });
  queueOperations.set(queueId, next);
  void next.catch(() => undefined);
}

async function primeQueueItem(item: DownloadQueueItem): Promise<void> {
  try {
    await whenQueuePayloadWritten(item.queueId);

    let current = musicCacheStore.getState().downloadQueue.find(
      (queued) => queued.queueId === item.queueId,
    );
    if (current?.status !== 'downloading') return;

    const songs = await readDownloadQueueSongsAsync(item.queueId);
    if (songs.length === 0) return;

    await ensureCoverArtAuth();

    current = musicCacheStore.getState().downloadQueue.find(
      (queued) => queued.queueId === item.queueId,
    );
    if (current?.status !== 'downloading') return;

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

    // A cancel/offline/storage transition may have raced the async payload/auth
    // work above. Never leave newly-created native tasks running for a parked item.
    current = musicCacheStore.getState().downloadQueue.find(
      (queued) => queued.queueId === item.queueId,
    );
    if (current?.status !== 'downloading') {
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

  for (const item of state.downloadQueue) {
    const before = previousById.get(item.queueId);
    if (item.status === 'downloading' && before?.status !== 'downloading') {
      scheduleQueueOperation(item.queueId, () => primeQueueItem(item));
    }
  }

  for (const item of previous.downloadQueue) {
    if (item.status !== 'downloading') continue;
    const current = currentById.get(item.queueId);
    if (!current || current.status !== 'downloading') {
      scheduleQueueOperation(item.queueId, () => stopBackgroundDownloadsForQueue(item.queueId));
    }
  }
}

if (Platform.OS === 'ios') {
  musicCacheStore.subscribe(onQueueChanged);
}
