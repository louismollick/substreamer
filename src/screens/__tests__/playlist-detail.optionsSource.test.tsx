jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

/** Track options retain their playlist source; editor saves reconcile downloaded and queued membership. */

import React from 'react';
import { Platform } from 'react-native';
import type { PlaylistWithSongs } from '../../services/subsonicService';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import type { Child } from '../../services/subsonicService';
const mockT = (key: string) => key;
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: mockT }) }));

import type { TrackRowProps } from '../../components/TrackRow';

const mockTrackRowProps: TrackRowProps[] = [];
jest.mock('../../components/TrackRow', () => ({
  TrackRow: (props: TrackRowProps) => {
    mockTrackRowProps.push(props);
    return null;
  },
}));

// Lists: render every row synchronously so `renderItem` actually runs.
jest.mock('@shopify/flash-list', () => {
  const { View, Pressable } = require('react-native');
  return {
    FlashList: ({
      data,
      renderItem,
      ListHeaderComponent,
      refreshControl,
    }: {
      data: unknown[];
      renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      refreshControl?: React.ReactElement<{ onRefresh: () => void }>;
    }) => (
      <View>
        {ListHeaderComponent}
        <Pressable testID="refresh" onPress={refreshControl?.props.onRefresh} />
        {data.map((item, index) => (
          <View key={index}>{renderItem({ item, index })}</View>
        ))}
      </View>
    ),
  };
});
jest.mock('react-native-reorderable-list', () => {
  const { View, Pressable } = require('react-native');
  const ReorderableList = ({ data, renderItem, ListHeaderComponent, onReorder }: {
    data: Child[];
    renderItem: (info: { item: Child; index: number }) => React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    onReorder: (event: { from: number; to: number }) => void;
  }) => <View>{ListHeaderComponent}<Pressable testID="reorder" onPress={() => onReorder({ from: 0, to: 1 })} />{data.map((item, index) => <View key={item.id}>{renderItem({ item, index })}</View>)}</View>;
  return {
    __esModule: true,
    default: ReorderableList,
    reorderItems: (items: Child[], from: number, to: number) => { const result = [...items]; const [item] = result.splice(from, 1); result.splice(to, 0, item); return result; },
    ReorderableListItem: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    useReorderableDrag: () => jest.fn(),
  };
});

const mockNavigation = { setOptions: jest.fn() };
let mockId: string | undefined = 'p1';
jest.mock('expo-router', () => {
  const { View, Pressable, Text } = require('react-native');
  const Toolbar = ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
  Toolbar.Button = ({ children, icon, onPress, disabled }: { children?: React.ReactNode; icon?: string; onPress?: () => void; disabled?: boolean }) => <Pressable testID={icon} onPress={onPress} disabled={disabled}><Text>{children}</Text></Pressable>;
  Toolbar.View = ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
  return {
    Stack: { Toolbar },
    useLocalSearchParams: () => ({ id: mockId }),
    useNavigation: () => mockNavigation,
  };
});

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      background: '#000',
      card: '#111',
      textPrimary: '#fff',
      textSecondary: '#888',
      border: '#333',
      inputBg: '#222',
      primary: '#1D9BF0',
      red: '#e91429',
    },
  }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useTransitionComplete', () => ({ useTransitionComplete: () => true }));
jest.mock('../../hooks/useDownloadStatus', () => ({ useDownloadStatus: () => 'none' }));
jest.mock('../../hooks/useLayoutMode', () => ({ useLayoutMode: () => 'compact' }));
jest.mock('../../hooks/useRefreshControlKey', () => ({ useRefreshControlKey: () => 0 }));
jest.mock('../../hooks/useSongCoverArt', () => ({
  useSongCoverArt: () => undefined,
  resolveEntityCoverArt: () => undefined,
}));

jest.mock('../../components/CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View /> };
});
jest.mock('../../components/MarqueeText', () => {
  const { Text } = require('react-native');
  return { MarqueeText: ({ children }: { children: React.ReactNode }) => <Text>{children}</Text> };
});
jest.mock('../../components/DetailScreenBackground', () => ({ DetailScreenBackground: () => null }));
jest.mock('../../components/BottomChrome', () => ({ BottomChrome: () => null }));
jest.mock('../../components/DownloadButton', () => ({ DownloadButton: () => null }));
jest.mock('../../components/MoreOptionsButton', () => ({ MoreOptionsButton: () => null }));
jest.mock('../../components/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('../../components/DetailHeroButtons', () => {
  const { Pressable } = require('react-native');
  return { PlayAllButton: ({ onPress }: { onPress: () => void }) => <Pressable testID="play-all" onPress={onPress} />, ShufflePlayButton: ({ onPress }: { onPress: () => void }) => <Pressable testID="shuffle" onPress={onPress} /> };
});
jest.mock('../../components/SwipeableRow', () => {
  const { View, Pressable } = require('react-native');
  return {
    SwipeableRow: ({ children, rightActions }: { children: React.ReactNode; rightActions?: { onPress: () => void }[] }) => <View>{children}<Pressable testID="remove-track" onPress={rightActions?.[0]?.onPress} /></View>,
    closeOpenRow: jest.fn(),
  };
});

const playlist: PlaylistWithSongs = {
  id: 'p1',
  name: 'Road Trip',
  songCount: 2,
  duration: 360,
  owner: 'tester',
  entry: [
    { id: 's1', title: 'First', artist: 'A', duration: 180 },
    { id: 's2', title: 'Second', artist: 'B', duration: 180 },
  ] as Child[],
};

jest.mock('../../services/detailFetchService', () => ({
  fetchPlaylistDetail: jest.fn(async () => playlist),
}));
jest.mock('../../services/musicCacheService', () => ({
  enqueuePlaylistDownload: jest.fn(),
  syncCachedItemTracks: jest.fn(),
}));
jest.mock('../../services/imageCacheService', () => ({
  ensureCached: jest.fn(),
  refreshCoverArt: jest.fn(async () => undefined),
}));
jest.mock('../../services/playerService', () => ({ playTrack: jest.fn() }));
jest.mock('../../services/subsonicService', () => ({
  updatePlaylistDetails: jest.fn(),
  updatePlaylistOrder: jest.fn(),
}));

let mockDbAvailable = false;
jest.mock('../../store/persistence/db', () => ({ getDb: () => mockDbAvailable ? {} : null }));
jest.mock('../../db/repository/details', () => ({ getPlaylistDetail: jest.fn() }));
jest.mock('../../store/authStore', () => ({
  authStore: Object.assign(
    (sel: (s: { username: string }) => unknown) => sel({ username: 'tester' }),
    { getState: () => ({ username: 'tester' }) },
  ),
}));
let mockOffline = false;
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: Object.assign(
    (sel: (s: { offlineMode: boolean }) => unknown) => sel({ offlineMode: mockOffline }),
    { getState: () => ({ offlineMode: mockOffline }) },
  ),
}));
const mockCacheState: { cachedItems: Record<string, unknown>; downloadQueue: { itemId: string }[] } = { cachedItems: {}, downloadQueue: [] };
jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: Object.assign(
    (sel: (s: { cachedItems: Record<string, unknown> }) => unknown) => sel(mockCacheState),
    { getState: () => mockCacheState },
  ),
}));
jest.mock('../../store/syncStatusStore', () => ({
  syncStatusStore: { getState: () => ({ bumpLibraryUpdated: jest.fn() }) },
}));
const mockShowMore = jest.fn();
jest.mock('../../store/moreOptionsStore', () => ({ moreOptionsStore: { getState: () => ({ show: mockShowMore }) } }));
const mockOverlay = { show: jest.fn(), hide: jest.fn(), showError: jest.fn(), showSuccess: jest.fn() };
jest.mock('../../store/processingOverlayStore', () => ({
  processingOverlayStore: { getState: () => mockOverlay },
  runWithOverlay: jest.fn(),
}));

import { PlaylistDetailScreen } from '../playlist-detail';
import { fetchPlaylistDetail } from '../../services/detailFetchService';
import { getPlaylistDetail } from '../../db/repository/details';
import { songListRowToChild, type SongListRow } from '../../db/repository/songs';
import { songRow } from '../../db/repository/mappers';
import { updatePlaylistDetails, updatePlaylistOrder } from '../../services/subsonicService';
import { syncCachedItemTracks, enqueuePlaylistDownload } from '../../services/musicCacheService';
import { moreOptionsStore } from '../../store/moreOptionsStore';
import { playTrack } from '../../services/playerService';

beforeEach(() => {
  mockTrackRowProps.length = 0;
  mockId = 'p1';
  mockOffline = false;
  mockDbAvailable = false;
  mockCacheState.cachedItems = {};
  mockCacheState.downloadQueue = [];
  jest.clearAllMocks();
  jest.mocked(getPlaylistDetail).mockReset();
  jest.mocked(fetchPlaylistDetail).mockReset().mockResolvedValue(playlist);
  jest.mocked(updatePlaylistOrder).mockReset().mockResolvedValue(true);
  jest.mocked(updatePlaylistDetails).mockReset().mockResolvedValue(true);
  jest.mocked(syncCachedItemTracks).mockReset().mockResolvedValue(undefined);
});

describe('PlaylistDetailScreen — options-sheet source', () => {
  it('renders every track row with optionsSource="playlist-detail"', async () => {
    render(<PlaylistDetailScreen />);

    await waitFor(() => expect(mockTrackRowProps.length).toBeGreaterThanOrEqual(2));

    const ids = mockTrackRowProps.map((p) => p.track.id);
    expect(ids).toEqual(expect.arrayContaining(['s1', 's2']));
    for (const props of mockTrackRowProps) {
      expect(props.optionsSource).toBe('playlist-detail');
    }
  });
});

async function openEditor() {
  mockTrackRowProps.length = 0;
  const screen = render(<PlaylistDetailScreen />);
  await waitFor(() => expect(mockTrackRowProps.length).toBeGreaterThanOrEqual(2));
  if (Platform.OS === 'ios') fireEvent.press(screen.getByTestId('pencil'));
  else {
    const options = mockNavigation.setOptions.mock.calls.at(-1)?.[0] as { headerRight: () => React.ReactElement };
    const header = options.headerRight() as React.ReactElement<{ children: React.ReactElement<{ onPress: () => void }>[] }>;
    act(() => { header.props.children[0].props.onPress(); });
  }
  return screen;
}

async function editorAction(screen: ReturnType<typeof render>, action: 'save' | 'cancel') {
  if (Platform.OS === 'ios') fireEvent.press(screen.getByText(action));
  else {
    const options = mockNavigation.setOptions.mock.calls.at(-1)?.[0] as { headerRight: () => React.ReactElement; headerLeft: () => React.ReactElement };
    const button = (action === 'save' ? options.headerRight() : options.headerLeft()) as React.ReactElement<{ onPress: () => void | Promise<void> }>;
    await act(async () => { await button.props.onPress(); });
  }
  await act(async () => { await Promise.resolve(); });
}

describe('PlaylistDetailScreen editing', () => {
  it('cancels edits and skips unchanged saves', async () => {
    const screen = await openEditor();
    fireEvent.changeText(screen.getByPlaceholderText('playlistName'), 'Discard');
    await editorAction(screen, 'cancel');
    expect(screen.queryByPlaceholderText('playlistName')).toBeNull();
    screen.unmount();
    const unchanged = await openEditor();
    await editorAction(unchanged, 'save');
    expect(updatePlaylistOrder).not.toHaveBeenCalled();
    expect(updatePlaylistDetails).not.toHaveBeenCalled();
  });

  it('validates empty names while retaining the editor', async () => {
    const screen = await openEditor();
    fireEvent.changeText(screen.getByPlaceholderText('playlistName'), '  ');
    await editorAction(screen, 'save');
    expect(mockOverlay.showError).toHaveBeenCalledWith('pleaseEnterPlaylistName');
    expect(updatePlaylistDetails).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('playlistName')).toBeTruthy();
  });

  it.each(['cached', 'queued', 'uncached'] as const)('replaces changed membership and reconciles %s downloads before properties', async (kind) => {
    if (kind === 'cached') mockCacheState.cachedItems.p1 = {};
    if (kind === 'queued') mockCacheState.downloadQueue = [{ itemId: 'p1' }];
    const screen = await openEditor();
    fireEvent.press(screen.getByTestId('reorder'));
    fireEvent.changeText(screen.getByPlaceholderText('descriptionOptional'), 'New description');
    fireEvent(screen.getByLabelText('publicPlaylist'), 'valueChange', true);
    await editorAction(screen, 'save');
    await waitFor(() => expect(mockOverlay.showSuccess).toHaveBeenCalledWith('playlistSaved'));
    expect(updatePlaylistOrder).toHaveBeenCalledWith('p1', 'Road Trip', ['s2', 's1']);
    expect(updatePlaylistDetails).toHaveBeenCalledWith('p1', { name: 'Road Trip', comment: 'New description', public: true });
    if (kind === 'uncached') expect(syncCachedItemTracks).not.toHaveBeenCalled();
    else {
      expect(syncCachedItemTracks).toHaveBeenCalledWith('p1', [playlist.entry![1], playlist.entry![0]]);
      expect(jest.mocked(syncCachedItemTracks).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(updatePlaylistDetails).mock.invocationCallOrder[0]);
    }
    expect(fetchPlaylistDetail).toHaveBeenLastCalledWith('p1', { force: true });
  });

  it('saves track deletion and reports a partial property-write failure', async () => {
    jest.mocked(updatePlaylistDetails).mockResolvedValue(false);
    const screen = await openEditor();
    fireEvent.press(screen.getAllByTestId('remove-track')[0]);
    await editorAction(screen, 'save');
    await waitFor(() => expect(mockOverlay.showError).toHaveBeenCalledWith('playlistTracksSavedPropsFailed'));
    expect(updatePlaylistOrder).toHaveBeenCalledWith('p1', 'Road Trip', ['s2']);
    expect(screen.queryByPlaceholderText('playlistName')).toBeNull();
  });

  it.each(['order', 'properties', 'exception'] as const)('retains edits after %s save failure', async (failure) => {
    const screen = await openEditor();
    fireEvent.changeText(screen.getByPlaceholderText('playlistName'), 'Retry name');
    if (failure === 'order') { fireEvent.press(screen.getByTestId('reorder')); jest.mocked(updatePlaylistOrder).mockResolvedValue(false); }
    else if (failure === 'properties') jest.mocked(updatePlaylistDetails).mockResolvedValue(false);
    else jest.mocked(updatePlaylistDetails).mockRejectedValue(new Error('network'));
    await editorAction(screen, 'save');
    await waitFor(() => expect(mockOverlay.showError).toHaveBeenCalledWith('failedToSavePlaylist'));
    expect(screen.getByPlaceholderText('playlistName')).toBeTruthy();
    expect(fetchPlaylistDetail).toHaveBeenCalledTimes(1);
  });

  it('finishes a property-only save when the reconciliation fetch returns no detail', async () => {
    const screen = await openEditor();
    fireEvent.changeText(screen.getByPlaceholderText('playlistName'), 'New name');
    jest.mocked(fetchPlaylistDetail).mockResolvedValue(null);
    await editorAction(screen, 'save');
    await waitFor(() => expect(mockOverlay.showSuccess).toHaveBeenCalledWith('playlistSaved'));
    expect(updatePlaylistOrder).not.toHaveBeenCalled();
    expect(updatePlaylistDetails).toHaveBeenCalledWith('p1', { name: 'New name', comment: '', public: false });
  });
});

describe('PlaylistDetailScreen loaded content', () => {
  it('loads cached public detail offline without fetching the server or enabling edits', async () => {
    mockDbAvailable = true;
    mockOffline = true;
    const { entry, ...meta } = { ...playlist, public: true, comment: 'Saved description' };
    jest.mocked(getPlaylistDetail).mockResolvedValue({ playlist: { ...meta, coverArt: meta.coverArt, created: meta.created, changed: meta.changed, owner: meta.owner }, entry: (entry ?? []).map((song) => songListRowToChild(songRow(song) as unknown as SongListRow)) });
    const screen = render(<PlaylistDetailScreen />);
    await waitFor(() => expect(screen.getByText('Saved description')).toBeTruthy());
    expect(fetchPlaylistDetail).not.toHaveBeenCalled();
    expect(screen.getByText('publicPlaylist')).toBeTruthy();
    expect(screen.queryByTestId('pencil')).toBeNull();
    if (Platform.OS === 'android') {
      const options = mockNavigation.setOptions.mock.calls.at(-1)?.[0] as { headerRight: () => React.ReactElement<{ children: React.ReactNode[] }> };
      expect(options.headerRight().props.children[0]).toBe(false);
    }
  });

  it('falls back to the server when the local playlist detail is absent', async () => {
    mockDbAvailable = true;
    jest.mocked(getPlaylistDetail).mockResolvedValue(null);
    const screen = render(<PlaylistDetailScreen />);
    await waitFor(() => expect(screen.getByText('Road Trip')).toBeTruthy());
    expect(fetchPlaylistDetail).toHaveBeenCalledWith('p1', { force: false });
  });

  it('plays and shuffles the playlist, refreshes from the server and opens options', async () => {
    const screen = render(<PlaylistDetailScreen />);
    await waitFor(() => expect(screen.getByTestId('play-all')).toBeTruthy());
    fireEvent.press(screen.getByTestId('play-all'));
    expect(playTrack).toHaveBeenCalledWith(playlist.entry![0], playlist.entry, 'p1');
    fireEvent.press(screen.getByTestId('shuffle'));
    expect(playTrack).toHaveBeenCalledTimes(2);
    await act(async () => { await fireEvent.press(screen.getByTestId('refresh')); });
    await waitFor(() => expect(fetchPlaylistDetail).toHaveBeenCalledWith('p1', { force: true }));
    if (Platform.OS === 'ios') {
      fireEvent.press(screen.getByTestId('ellipsis'));
      fireEvent.press(screen.getByTestId('arrow.down.circle'));
      expect(enqueuePlaylistDownload).toHaveBeenCalledWith('p1');
    } else {
      const options = mockNavigation.setOptions.mock.calls.at(-1)?.[0] as { headerRight: () => React.ReactElement<{ children: React.ReactElement<{ onPress?: () => void }>[] }> };
      act(() => { options.headerRight().props.children[2].props.onPress?.(); });
    }
    expect(moreOptionsStore.getState().show).toHaveBeenCalledWith({ type: 'playlist', item: playlist });
  });

  it('shows another owner as shared and hides the edit action', async () => {
    jest.mocked(fetchPlaylistDetail).mockResolvedValue({ ...playlist, owner: 'another-owner', public: false, comment: 'Shared music' });
    const screen = render(<PlaylistDetailScreen />);
    await waitFor(() => expect(screen.getByText('sharedByOwner')).toBeTruthy());
    expect(screen.getByText('Shared music')).toBeTruthy();
    expect(screen.queryByTestId('pencil')).toBeNull();
  });
});
