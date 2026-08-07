jest.mock('../CachedImage', () => ({ CachedImage: () => null }));
jest.mock('../NowPlayingIndicator', () => ({ NowPlayingIndicator: () => null }));
var mockRowMetaProps: any;
jest.mock('../RowMetaLine', () => ({
  RowMetaLine: (props: any) => {
    mockRowMetaProps = props;
    return null;
  },
}));
var mockSwipeableProps: any;
jest.mock('../SwipeableRow', () => ({
  SwipeableRow: (props: { children: React.ReactNode }) => {
    mockSwipeableProps = props;
    return props.children;
  },
}));
var mockDownloadStatus = 'none';
jest.mock('../../hooks/useDownloadStatus', () => ({ useDownloadStatus: () => mockDownloadStatus }));
var mockStarred = false;
jest.mock('../../hooks/useIsStarred', () => ({ useIsStarred: () => mockStarred }));
jest.mock('../../hooks/useRating', () => ({ useRating: () => 0 }));
jest.mock('../../hooks/useSongCoverArt', () => ({ useSongCoverArt: () => null }));
jest.mock('../../services/moreOptionsService', () => ({
  removeItemFromQueue: jest.fn(),
  toggleStar: jest.fn(),
}));
var mockOfflineMode = false;
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: (selector: (state: { offlineMode: boolean }) => unknown) =>
    selector({ offlineMode: mockOfflineMode }),
}));

import { render } from '@testing-library/react-native';
import { QueueItemRow } from '../QueueItemRow';

const colors = {
  textPrimary: '#fff', textSecondary: '#aaa', primary: '#f60', border: '#333', red: '#f00',
};
const track = { id: 'song', title: 'A long song title', artist: 'Artist', duration: 120 } as any;
const props = { track, index: 0, isActive: false, colors, onPress: jest.fn() };

beforeEach(() => {
  mockDownloadStatus = 'none';
  mockStarred = false;
  mockOfflineMode = false;
  props.onPress.mockClear();
});

it('shows one plain section heading instead of a per-track autoplay badge', () => {
  const manual = render(<QueueItemRow {...props} />);
  expect(manual.queryByRole('header')).toBeNull();
  manual.unmount();

  const autoplay = render(<QueueItemRow {...props} startsInfinitePlaySection />);
  expect(autoplay.getByRole('header')).toHaveTextContent('Next up');
  expect(autoplay.queryByText('● Infinite Play')).toBeNull();
});

it('preserves queue press, long-press, remove, favorite, and playlist actions', () => {
  const onLongPress = jest.fn();
  const { removeItemFromQueue, toggleStar } = require('../../services/moreOptionsService');
  render(<QueueItemRow {...props} onLongPress={onLongPress} />);

  mockSwipeableProps.onPress();
  mockSwipeableProps.onLongPress();
  mockSwipeableProps.rightActions[0].onPress();
  mockSwipeableProps.leftActions[0].onPress();
  mockSwipeableProps.leftActions[1].onPress();

  expect(props.onPress).toHaveBeenCalledWith(0);
  expect(onLongPress).toHaveBeenCalledWith(track);
  expect(removeItemFromQueue).toHaveBeenCalledWith(0);
  expect(toggleStar).toHaveBeenCalledWith('song', 'song');
});

it('keeps offline and downloaded-row behavior intact', () => {
  mockOfflineMode = true;
  mockDownloadStatus = 'complete';
  const offline = render(
    <QueueItemRow
      {...props}
      track={{ ...track, artist: undefined, duration: undefined }}
      isActive
    />,
  );

  expect(mockSwipeableProps.leftActions).toEqual([]);
  expect(mockSwipeableProps.enableFullSwipeLeft).toBe(false);
  expect(mockRowMetaProps.downloadStatus).toBe('complete');
  expect(offline.queryByText('Artist')).toBeNull();

  offline.unmount();
  mockOfflineMode = false;
  mockDownloadStatus = 'partial';
  mockStarred = true;
  render(<QueueItemRow {...props} />);
  expect(mockRowMetaProps.downloadStatus).toBe('partial');
  expect(mockSwipeableProps.leftActions[1].label).toBe('Remove');
});
