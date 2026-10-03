import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AddToPlaylistSheet } from '../AddToPlaylistSheet';
import { addToPlaylistStore } from '../../store/addToPlaylistStore';
import type { AlbumID3, Child } from '../../services/subsonicService';

const mockPlaylists = [{ id: 'p1', name: 'Mix', songCount: 2 }];
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true, default: { View },
    useSharedValue: (value: unknown) => require('react').useRef({ value }).current,
    useAnimatedStyle: (work: () => unknown) => work(),
    withTiming: (value: number, _config: unknown, done?: (finished: boolean) => void) => { done?.(true); return value; },
    runOnJS: (work: unknown) => work,
    Easing: { out: (work: unknown) => work, cubic: jest.fn() },
  };
});
const mockList = jest.fn().mockResolvedValue(mockPlaylists);
const mockRefresh = jest.fn().mockResolvedValue(undefined);
const mockAdd = jest.fn().mockResolvedValue(true);
const mockCreate = jest.fn().mockResolvedValue(true);
const mockAlbum = jest.fn();
const mockFetchDetail = jest.fn();
const mockSyncTracks = jest.fn().mockResolvedValue(true);
const mockOverlay = { show: jest.fn(), showSuccess: jest.fn(), showError: jest.fn() };
let mockCache = { cachedItems: {} as Record<string, unknown>, downloadQueue: [] as { itemId: string }[] };
let mockDb: object | null = {};

jest.mock('../BottomSheet', () => {
  const { View } = require('react-native');
  return { BottomSheet: ({ children, onClose }: { children: React.ReactNode; onClose: () => void }) =>
    <View testID="sheet" onTouchEnd={onClose}>{children}</View> };
});
jest.mock('../CachedImage', () => ({ CachedImage: () => null }));
jest.mock('../../hooks/useTheme', () => ({ useTheme: () => ({ colors: {
  textPrimary: '#fff', textSecondary: '#888', inputBg: '#111', border: '#333', primary: '#fff', red: '#f00',
} }) }));
jest.mock('../../hooks/useSongCoverArt', () => ({ resolveSongCoverArt: (song: Child) => song.coverArt }));
jest.mock('../../utils/coverArtId', () => ({ coverArtForAlbum: (album: AlbumID3) => album.coverArt }));
jest.mock('../../services/musicCacheService', () => ({ syncCachedItemTracks: (...args: unknown[]) => mockSyncTracks(...args) }));
jest.mock('../../services/subsonicService', () => ({
  addToPlaylist: (...args: unknown[]) => mockAdd(...args),
  createNewPlaylist: (...args: unknown[]) => mockCreate(...args),
  getAlbum: (...args: unknown[]) => mockAlbum(...args),
}));
jest.mock('../../services/detailFetchService', () => ({ fetchPlaylistDetail: (...args: unknown[]) => mockFetchDetail(...args) }));
jest.mock('../../services/normalizedLibrarySync', () => ({ refreshPlaylistLibrary: () => mockRefresh() }));
jest.mock('../../store/persistence/db', () => ({ getDb: () => mockDb }));
jest.mock('../../db/repository/playlists', () => ({
  listAllPlaylists: () => mockList(), playlistBrowseRowToPlaylist: (row: unknown) => row,
}));
jest.mock('../../store/musicCacheStore', () => ({ musicCacheStore: { getState: () => mockCache } }));
jest.mock('../../store/processingOverlayStore', () => ({
  processingOverlayStore: { getState: () => mockOverlay },
  runWithOverlay: async (work: () => Promise<void>, messages: { error: string }) => {
    try { await work(); } catch { mockOverlay.showError(messages.error); }
  },
}));

const song: Child = { id: 's1', title: 'Song', artist: 'Artist', coverArt: 'cover', isDir: false };

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockList.mockResolvedValue(mockPlaylists);
  mockRefresh.mockResolvedValue(undefined);
  mockAdd.mockResolvedValue(true);
  mockCreate.mockResolvedValue(true);
  mockAlbum.mockResolvedValue({ song: [song] });
  mockFetchDetail.mockResolvedValue({ entry: [song] });
  mockSyncTracks.mockResolvedValue(true);
  mockCache = { cachedItems: {}, downloadQueue: [] };
  mockDb = {};
  addToPlaylistStore.setState({ visible: false, target: null });
});
afterEach(() => { jest.useRealTimers(); });

async function open() {
  const result = render(<AddToPlaylistSheet />);
  await act(async () => { await jest.advanceTimersByTimeAsync(750); });
  return result;
}

it.each(['cached', 'queued', 'remote'])('adds songs and reconciles the %s playlist when necessary', async (status) => {
  addToPlaylistStore.getState().showSong(song);
  if (status === 'cached') mockCache.cachedItems.p1 = {};
  if (status === 'queued') mockCache.downloadQueue = [{ itemId: 'p1' }];
  const ui = await open();
  await act(async () => { fireEvent.press(ui.getByText('Mix')); });
  expect(mockAdd).toHaveBeenCalledWith('p1', ['s1']);
  if (status === 'remote') expect(mockSyncTracks).not.toHaveBeenCalled();
  else expect(mockSyncTracks).toHaveBeenCalledWith('p1', [song]);
  expect(addToPlaylistStore.getState().visible).toBe(false);
});

it('keeps the overlay operation pending until queued membership is reconciled', async () => {
  addToPlaylistStore.getState().showQueue([song]);
  mockCache.downloadQueue = [{ itemId: 'p1' }];
  let finish: (() => void) | undefined;
  mockSyncTracks.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const ui = await open();
  await act(async () => { fireEvent.press(ui.getByText('Mix')); });
  expect(mockSyncTracks).toHaveBeenCalledWith('p1', [song]);
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  await act(async () => { finish?.(); });
  expect(mockRefresh).toHaveBeenCalledTimes(2);
});

it.each(['album', 'queue'])('resolves %s tracks for a new playlist', async (target) => {
  if (target === 'album') addToPlaylistStore.getState().showAlbum({ id: 'a1', coverArt: 'cover' } as AlbumID3);
  else addToPlaylistStore.getState().showQueue([song]);
  const ui = await open();
  fireEvent.press(ui.getByText('newPlaylist'));
  fireEvent.changeText(ui.getByPlaceholderText('enterPlaylistNamePlaceholder'), '  New mix  ');
  await act(async () => { fireEvent.press(ui.getByText('createPlaylist')); });
  expect(mockCreate).toHaveBeenCalledWith('New mix', ['s1']);
  expect(mockOverlay.showSuccess).toHaveBeenCalledWith('playlistCreated');
});

it('validates the name, retains failed input and allows returning to the picker', async () => {
  addToPlaylistStore.getState().showSong({ id: 's1', title: 'Song', isDir: false });
  const ui = await open();
  fireEvent.press(ui.getByText('newPlaylist'));
  fireEvent.press(ui.getByText('createPlaylist'));
  expect(ui.getByText('pleaseEnterPlaylistName')).toBeTruthy();
  fireEvent.changeText(ui.getByPlaceholderText('enterPlaylistNamePlaceholder'), 'Mix');
  mockCreate.mockResolvedValue(false);
  await act(async () => { fireEvent.press(ui.getByText('createPlaylist')); });
  expect(ui.getByText('failedToCreatePlaylist')).toBeTruthy();
  expect(ui.getByPlaceholderText('enterPlaylistNamePlaceholder').props.value).toBe('Mix');
  fireEvent.press(ui.getByText('back'));
  expect(ui.getByText('Mix')).toBeTruthy();
});

it.each(['emptyQueue', 'emptyAlbum', 'apiFailure'])('shows the add failure for %s', async (failure) => {
  if (failure === 'emptyQueue') addToPlaylistStore.getState().showQueue([]);
  else if (failure === 'emptyAlbum') {
    addToPlaylistStore.getState().showAlbum({ id: 'a1' } as AlbumID3);
    mockAlbum.mockResolvedValue(null);
  } else {
    addToPlaylistStore.getState().showSong(song);
    mockAdd.mockResolvedValue(false);
  }
  const ui = await open();
  await act(async () => { fireEvent.press(ui.getByText('Mix')); });
  expect(mockOverlay.showError).toHaveBeenCalledWith('failedToAddToPlaylist');
});

it('handles missing refreshed detail and empty membership', async () => {
  mockCache.cachedItems.p1 = {};
  mockFetchDetail.mockResolvedValue(null);
  addToPlaylistStore.getState().showSong(song);
  let ui = await open();
  await act(async () => { fireEvent.press(ui.getByText('Mix')); });
  expect(mockSyncTracks).not.toHaveBeenCalled();
  ui.unmount();
  addToPlaylistStore.getState().showSong(song);
  mockFetchDetail.mockResolvedValue({});
  ui = await open();
  await act(async () => { fireEvent.press(ui.getByText('Mix')); });
  expect(mockSyncTracks).toHaveBeenCalledWith('p1', []);
});

it('reports an empty picker and a failed initial refresh', async () => {
  addToPlaylistStore.getState().showQueue([]);
  mockList.mockResolvedValue([]);
  const ui = await open();
  expect(ui.getByText('noPlaylistsYet')).toBeTruthy();
  ui.unmount();
  mockRefresh.mockRejectedValue(new Error('offline'));
  const failed = await open();
  expect(failed.getByText('failedToLoadPlaylists')).toBeTruthy();
});

it('cancels delayed loading on dismissal and tolerates an unavailable database', async () => {
  addToPlaylistStore.getState().showSong(song);
  const ui = render(<AddToPlaylistSheet />);
  fireEvent(ui.getByTestId('sheet'), 'touchEnd');
  await act(async () => { await jest.advanceTimersByTimeAsync(750); });
  expect(mockRefresh).not.toHaveBeenCalled();
  ui.unmount();
  mockDb = null;
  addToPlaylistStore.getState().showSong(song);
  const empty = await open();
  expect(empty.getByText('noPlaylistsYet')).toBeTruthy();
});
