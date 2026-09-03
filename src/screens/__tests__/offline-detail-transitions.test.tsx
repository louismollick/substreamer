jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage')
);

import React from 'react';
import { Text as MockText, View as MockView } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';

const mockNavigation = { setOptions: jest.fn() };
jest.mock('expo-router', () => ({
  Stack: { Toolbar: Object.assign(({ children }: { children: React.ReactNode }) => children, {
    Button: () => null,
    View: ({ children }: { children: React.ReactNode }) => children,
  }) },
  useLocalSearchParams: () => ({ id: 'detail-id' }),
  useNavigation: () => mockNavigation,
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@shopify/flash-list', () => ({
  FlashList: ({ data = [], renderItem, ListHeaderComponent, ListEmptyComponent }: {
    data?: unknown[];
    renderItem?: (args: { item: unknown; index: number }) => React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    ListEmptyComponent?: React.ReactNode;
  }) => (
    <MockView>
      {ListHeaderComponent}
      {data.length > 0
        ? data.map((item, index) => <MockView key={index}>{renderItem?.({ item, index })}</MockView>)
        : ListEmptyComponent}
    </MockView>
  ),
}));

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#fff' }) }),
}));
jest.mock('../../hooks/useDetailFetch', () => ({
  useDetailFetch: () => ({ loading: false, refreshing: false, error: null, onRefresh: jest.fn() }),
}));
jest.mock('../../hooks/useDownloadStatus', () => ({ useDownloadStatus: () => 'complete' }));
jest.mock('../../hooks/useIsStarred', () => ({ useIsStarred: () => false }));
jest.mock('../../hooks/useLayoutMode', () => ({ useLayoutMode: () => 'narrow' }));
jest.mock('../../hooks/useRefreshControlKey', () => ({ useRefreshControlKey: () => 0 }));
jest.mock('../../hooks/useTransitionComplete', () => ({ useTransitionComplete: () => true }));

jest.mock('../../components/CachedImage', () => ({ CachedImage: () => null }));
jest.mock('../../components/DownloadButton', () => ({ DownloadButton: () => null }));
jest.mock('../../components/MoreOptionsButton', () => ({ MoreOptionsButton: () => null }));
jest.mock('../../components/BottomChrome', () => ({ BottomChrome: () => null }));
jest.mock('../../components/DetailScreenBackground', () => ({ DetailScreenBackground: () => null }));
jest.mock('../../components/MarqueeText', () => ({
  MarqueeText: ({ children }: { children: React.ReactNode }) => <MockText>{children}</MockText>,
}));
jest.mock('../../components/EmptyState', () => ({
  EmptyState: ({ title }: { title: string }) => <MockText>{title}</MockText>,
}));
jest.mock('../../components/TrackRow', () => ({
  TrackRow: ({ track }: { track: { title: string } }) => <MockText>{track.title}</MockText>,
}));
jest.mock('../../components/AlbumRow', () => ({ AlbumRow: () => null }));
jest.mock('../../components/ArtistCard', () => ({ ArtistCard: () => null }));
jest.mock('../../components/SectionTitle', () => ({ SectionTitle: () => null }));
jest.mock('../../components/SongCard', () => ({ SongCard: () => null }));
jest.mock('../../components/PillToggle', () => ({ PillToggle: () => null }));
jest.mock('../../components/DetailHeroButtons', () => ({
  PlayAllButton: () => null,
  ShufflePlayButton: () => null,
}));
jest.mock('../../components/SwipeableRow', () => ({ closeOpenRow: jest.fn() }));

const db = {};
jest.mock('../../store/persistence/db', () => ({ getDb: () => db }));
const mockGetAlbumDetail = jest.fn();
const mockGetDownloadedAlbumProjection = jest.fn();
const mockGetArtistBase = jest.fn();
const mockFetchDownloadedArtist = jest.fn();
jest.mock('../../db/repository/details', () => ({
  getAlbumDetail: (...args: unknown[]) => mockGetAlbumDetail(...args),
  getArtistBase: (...args: unknown[]) => mockGetArtistBase(...args),
}));
jest.mock('../../db/repository/downloads', () => ({
  getDownloadedAlbumProjection: (...args: unknown[]) => mockGetDownloadedAlbumProjection(...args),
}));
jest.mock('../../services/downloadedArtistService', () => ({
  fetchDownloadedArtist: (...args: unknown[]) => mockFetchDownloadedArtist(...args),
  hasDownloadedArtist: jest.fn(async () => true),
}));
jest.mock('../../services/detailFetchService', () => ({
  fetchAlbumDetail: jest.fn(),
  fetchArtistBase: jest.fn(),
  fetchArtistBio: jest.fn(async () => null),
  fetchArtistInfo: jest.fn(async () => null),
  fetchArtistTopSongs: jest.fn(async () => null),
}));
jest.mock('../../services/imageCacheService', () => ({ refreshCoverArt: jest.fn() }));
jest.mock('../../services/moreOptionsService', () => ({
  playAllByArtist: jest.fn(),
  playMoreByArtist: jest.fn(),
  toggleStar: jest.fn(),
}));
jest.mock('../../services/musicCacheService', () => ({ enqueueAlbumDownload: jest.fn() }));
jest.mock('../../services/playerService', () => ({ playTrack: jest.fn() }));
jest.mock('../../db/detailNotifier', () => ({ subscribeDetailChanged: () => () => {} }));

import { offlineModeStore } from '../../store/offlineModeStore';
import { AlbumDetailScreen } from '../album-detail';
import { ArtistDetailScreen } from '../artist-detail';

beforeEach(() => {
  jest.clearAllMocks();
  offlineModeStore.setState({ offlineMode: false });
  mockGetAlbumDetail.mockResolvedValue({
    album: { id: 'detail-id', name: 'Online album', artistId: 'ar1' },
    songs: [{ id: 'online-song', title: 'Online track', isDir: false }],
  });
  mockGetDownloadedAlbumProjection.mockResolvedValue(null);
  mockGetArtistBase.mockResolvedValue({
    artist: { id: 'detail-id', name: 'Online artist', albumCount: 1 },
    albums: [],
  });
  mockFetchDownloadedArtist.mockResolvedValue(null);
});

it('replaces an online album with its downloaded-only track projection', async () => {
  mockGetDownloadedAlbumProjection.mockResolvedValue({
    album: { id: 'detail-id', name: 'Offline album', artistId: 'ar1' },
    songs: [{ id: 'offline-song', title: 'Offline track', isDir: false }],
  });
  const view = render(<AlbumDetailScreen />);
  await view.findByText('Online track');

  act(() => offlineModeStore.setState({ offlineMode: true }));

  await view.findByText('Offline track');
  expect(view.queryByText('Online track')).toBeNull();
});

it('clears an online album when it has no downloaded projection', async () => {
  const view = render(<AlbumDetailScreen />);
  await view.findByText('Online album');

  act(() => offlineModeStore.setState({ offlineMode: true }));

  await view.findByText('couldntLoadAlbum');
  expect(view.queryByText('Online album')).toBeNull();
});

it('clears an online artist when it has no downloaded projection', async () => {
  const view = render(<ArtistDetailScreen />);
  await view.findByText('Online artist');

  act(() => offlineModeStore.setState({ offlineMode: true }));

  await waitFor(() => expect(view.queryByText('Online artist')).toBeNull());
  expect(view.getByText('couldntLoadArtist')).toBeTruthy();
});
