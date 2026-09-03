jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage')
);

import { act, renderHook } from '@testing-library/react-native';

import { albumInfoStore } from '../../store/albumInfoStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { usePlayerAlbumInfo } from '../usePlayerAlbumInfo';

const hydrateAlbumInfo = jest.fn<Promise<null>, [string]>();
const fetchAlbumInfo = jest.fn<Promise<null>, [string, string?, string?]>();

beforeEach(() => {
  jest.clearAllMocks();
  hydrateAlbumInfo.mockResolvedValue(null);
  fetchAlbumInfo.mockResolvedValue(null);
  albumInfoStore.setState({
    entries: {},
    loading: {},
    errors: {},
    hydrateAlbumInfo,
    fetchAlbumInfo,
  });
  offlineModeStore.setState({ offlineMode: false });
});

const setUp = () => renderHook(() => usePlayerAlbumInfo('al1', 'Artist', 'Album'));

it('does not fetch if offline mode starts while cache hydration is pending', async () => {
  let resolveHydration!: (value: null) => void;
  hydrateAlbumInfo.mockReturnValueOnce(new Promise((resolve) => {
    resolveHydration = resolve;
  }));
  setUp();

  act(() => {
    offlineModeStore.setState({ offlineMode: true });
  });
  await act(async () => {
    resolveHydration(null);
  });

  expect(fetchAlbumInfo).not.toHaveBeenCalled();
});

it('fetches after switching online when the offline cache read misses', async () => {
  offlineModeStore.setState({ offlineMode: true });
  setUp();
  await act(async () => {});

  act(() => {
    offlineModeStore.setState({ offlineMode: false });
  });
  await act(async () => {});

  expect(fetchAlbumInfo).toHaveBeenCalledTimes(1);
  expect(fetchAlbumInfo).toHaveBeenCalledWith('al1', 'Artist', 'Album');
});

it('keeps the request guard set after a failed fetch settles', async () => {
  setUp();
  await act(async () => {});
  expect(fetchAlbumInfo).toHaveBeenCalledTimes(1);

  act(() => {
    albumInfoStore.setState({ loading: { al1: true } });
  });
  act(() => {
    albumInfoStore.setState({ loading: {}, errors: { al1: 'error' } });
  });

  expect(fetchAlbumInfo).toHaveBeenCalledTimes(1);
});
