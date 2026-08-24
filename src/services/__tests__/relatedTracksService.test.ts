const mockOffline = { offlineMode: false };
const mockCachedSongs: Record<string, unknown> = {};
const mockEnvelopes: Record<string, any> = {};

jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: () => mockOffline },
}));
jest.mock('../../store/layoutPreferencesStore', () => ({
  layoutPreferencesStore: { getState: () => ({ listLength: 3 }) },
}));
jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: { getState: () => ({ cachedSongs: mockCachedSongs }) },
  getSongEnvelope: (id: string) => mockEnvelopes[id] ?? null,
}));
jest.mock('../subsonicService');
jest.mock('../../utils/arrayHelpers', () => ({ shuffleArray: <T>(items: T[]) => items }));

import {
  getRandomSongs,
  getRandomSongsFiltered,
  getSimilarSongs,
  getSimilarSongs2,
  getTopSongs,
  type Child,
} from '../subsonicService';
import { buildAutoplayQueue, buildMoreLikeThisQueue } from '../relatedTracksService';

const song = (id: string, fields: Partial<Child> = {}) => ({ id, title: id, ...fields } as Child);
const options = (queue: Child[] = [song('source')]) => ({
  currentQueue: queue,
  currentTrackIndex: queue.length - 1,
  target: 3,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockOffline.offlineMode = false;
  for (const key of Object.keys(mockCachedSongs)) delete mockCachedSongs[key];
  for (const key of Object.keys(mockEnvelopes)) delete mockEnvelopes[key];
  (getSimilarSongs as jest.Mock).mockResolvedValue([]);
  (getSimilarSongs2 as jest.Mock).mockResolvedValue([]);
  (getRandomSongsFiltered as jest.Mock).mockResolvedValue([]);
  (getTopSongs as jest.Mock).mockResolvedValue([]);
  (getRandomSongs as jest.Mock).mockResolvedValue([]);
});

it('shares the ordered online fallback chain with more-like-this', async () => {
  (getSimilarSongs as jest.Mock).mockResolvedValue([song('similar')]);
  (getSimilarSongs2 as jest.Mock).mockResolvedValue([song('artist')]);
  (getRandomSongsFiltered as jest.Mock).mockResolvedValue([song('genre')]);
  const source = song('source', { artistId: 'artist-id', artist: 'Artist', genre: 'Rock' });

  await expect(buildMoreLikeThisQueue(source, 3)).resolves.toEqual([
    song('similar'),
    song('artist'),
    song('genre'),
  ]);
  expect(getTopSongs).not.toHaveBeenCalled();
});

it('uses a non-empty similar response without calling another autoplay endpoint', async () => {
  (getSimilarSongs as jest.Mock).mockResolvedValue([song('similar')]);
  (getSimilarSongs2 as jest.Mock).mockResolvedValue([song('artist')]);
  (getRandomSongsFiltered as jest.Mock).mockResolvedValue([song('genre')]);
  const result = await buildAutoplayQueue(
    song('source', { artistId: 'artist-id', artist: 'Artist', genre: 'Rock' }),
    options(),
  );
  expect(result.map((track) => track.id)).toEqual(['similar']);
  expect(getSimilarSongs2).not.toHaveBeenCalled();
  expect(getRandomSongsFiltered).not.toHaveBeenCalled();
  expect(getTopSongs).not.toHaveBeenCalled();
  expect(getRandomSongs).not.toHaveBeenCalled();
});

it('normalizes an object genre for the explicit-action fallback', async () => {
  (getRandomSongsFiltered as jest.Mock).mockResolvedValue([song('genre')]);
  const source = song('source', {
    genres: [{ name: 'Rock' }] as unknown as string[],
  });

  await expect(buildMoreLikeThisQueue(source, 3)).resolves.toEqual([song('genre')]);
  expect(getRandomSongsFiltered).toHaveBeenCalledWith({ size: 6, genre: 'Rock' });
});

it('uses downloaded genre tracks first, then all downloads', async () => {
  mockOffline.offlineMode = true;
  Object.assign(mockCachedSongs, { jazz: {}, rock: {}, other: {} });
  Object.assign(mockEnvelopes, {
    jazz: song('jazz', { genre: 'Jazz' }),
    rock: song('rock', { genre: 'Rock' }),
    other: song('other'),
  });
  const result = await buildAutoplayQueue(song('source', { genre: 'Rock' }), options());
  expect(result.map((track) => track.id)).toEqual(['rock', 'jazz', 'other']);
  expect(getSimilarSongs).not.toHaveBeenCalled();
});

it('matches object and string genre shapes in the downloaded library', async () => {
  mockOffline.offlineMode = true;
  Object.assign(mockCachedSongs, { jazz: {}, rock: {} });
  Object.assign(mockEnvelopes, {
    jazz: song('jazz', { genres: ['Jazz'] }),
    rock: song('rock', { genres: ['Rock'] }),
  });
  const source = song('source', {
    genres: [{ name: 'Rock' }] as unknown as string[],
  });

  const result = await buildAutoplayQueue(source, options());

  expect(result.map((track) => track.id)).toEqual(['rock', 'jazz']);
});

it('excludes source, manual future tracks, duplicates, then recycles played tracks', async () => {
  (getSimilarSongs as jest.Mock).mockResolvedValue([
    song('source'), song('manual'), song('played'), song('fresh'), song('fresh'),
  ]);
  const result = await buildAutoplayQueue(song('source'), {
    ...options([song('played'), song('source')]),
    currentQueue: [song('played'), song('source'), song('manual')],
  });
  expect(result.map((track) => track.id)).toEqual(['fresh', 'played']);
});

it('does not recycle an autoplay track that is still ahead in the queue', async () => {
  const future = song('future-autoplay');
  (getSimilarSongs as jest.Mock).mockResolvedValue([future]);

  const result = await buildAutoplayQueue(song('source'), {
    ...options([song('source'), future]),
    currentTrackIndex: 0,
  });

  expect(result).toEqual([]);
  expect(getRandomSongs).not.toHaveBeenCalled();
  expect(getSimilarSongs2).not.toHaveBeenCalled();
  expect(getRandomSongsFiltered).not.toHaveBeenCalled();
  expect(getTopSongs).not.toHaveBeenCalled();
});

it('uses random songs when similar songs are empty', async () => {
  (getRandomSongs as jest.Mock).mockResolvedValue([song('fallback')]);
  const source = song('source', { artistId: 'artist-id', artist: 'Artist', genre: 'Rock' });
  await expect(buildAutoplayQueue(source, options())).resolves.toEqual([song('fallback')]);
  expect(getRandomSongs).toHaveBeenCalledWith(3);
  expect(getSimilarSongs2).not.toHaveBeenCalled();
  expect(getRandomSongsFiltered).not.toHaveBeenCalled();
  expect(getTopSongs).not.toHaveBeenCalled();

  (getRandomSongs as jest.Mock).mockResolvedValue(null);
  await expect(buildAutoplayQueue(song('source'), options())).resolves.toEqual([]);
});
