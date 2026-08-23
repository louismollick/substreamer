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

it('uses online fallback order and stops once full', async () => {
  (getSimilarSongs as jest.Mock).mockResolvedValue([song('similar')]);
  (getSimilarSongs2 as jest.Mock).mockResolvedValue([song('artist')]);
  (getRandomSongsFiltered as jest.Mock).mockResolvedValue([song('genre')]);
  const result = await buildAutoplayQueue(
    song('source', { artistId: 'artist-id', artist: 'Artist', genre: 'Rock' }),
    options(),
  );
  expect(result.map((track) => track.id)).toEqual(['similar', 'artist', 'genre']);
  expect(getTopSongs).not.toHaveBeenCalled();
  expect(getRandomSongs).not.toHaveBeenCalled();
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
});

it('continues past unavailable sources and returns empty when none yield tracks', async () => {
  (getRandomSongsFiltered as jest.Mock).mockResolvedValue(null);
  (getTopSongs as jest.Mock).mockResolvedValue(null);
  (getRandomSongs as jest.Mock).mockResolvedValue([song('fallback')]);
  const source = song('source', { artistId: 'artist-id', artist: 'Artist', genre: 'Rock' });
  await expect(buildAutoplayQueue(source, options())).resolves.toEqual([song('fallback')]);
  (getRandomSongs as jest.Mock).mockResolvedValue(null);
  await expect(buildAutoplayQueue(song('source'), options())).resolves.toEqual([]);
});
