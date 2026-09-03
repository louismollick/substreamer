jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('expo-router/react-navigation', () => ({ useIsFocused: () => true }));

// The four segment screens have their own suites; here they only need to be
// distinguishable, so the gate's two branches can be told apart.
jest.mock('../album-library-list', () => ({ AlbumLibraryListScreen: () => null }));
jest.mock('../playlist-list', () => ({ PlaylistListScreen: () => null }));
jest.mock('../song-library-list', () => ({ SongLibraryListScreen: () => null }));
jest.mock('../artist-list', () => {
  const { Text } = require('react-native');
  return { ArtistListScreen: () => <Text testID="artist-list">artist list</Text> };
});

import React from 'react';
import { fireEvent, render, waitFor, type RenderAPI } from '@testing-library/react-native';

import { filterBarStore } from '../../store/filterBarStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { LibraryScreen } from '../library';

/** Open the Artists segment — the gate under test only renders there. The screen defers
 *  segment content past an idle window (`runWhenIdle`), so callers assert inside
 *  `waitFor`; until it elapses only a spinner is mounted. */
const showArtists = (): RenderAPI => {
  const r = render(<LibraryScreen />);
  fireEvent.press(r.getByText('Artists'));
  return r;
};

beforeEach(() => {
  filterBarStore.setState({ downloadedOnly: false, favoritesOnly: false });
  offlineModeStore.setState({ offlineMode: false });
});

describe('LibraryScreen — the Artists segment under the Downloaded filter', () => {
  it('renders the artist list when no filter is on', async () => {
    const r = showArtists();
    await waitFor(() => expect(r.queryByTestId('artist-list')).not.toBeNull());
  });

  it('renders the downloaded artist list while online', async () => {
    filterBarStore.setState({ downloadedOnly: true });
    const r = showArtists();
    await waitFor(() => expect(r.queryByTestId('artist-list')).not.toBeNull());
  });

  it('renders the downloaded artist list offline', async () => {
    offlineModeStore.setState({ offlineMode: true });
    filterBarStore.setState({ downloadedOnly: true });
    const r = showArtists();
    await waitFor(() => expect(r.queryByTestId('artist-list')).not.toBeNull());
  });

  it('still shows the artist list with only the Favourites filter on', async () => {
    filterBarStore.setState({ favoritesOnly: true });
    const r = showArtists();
    await waitFor(() => expect(r.queryByTestId('artist-list')).not.toBeNull());
  });
});
