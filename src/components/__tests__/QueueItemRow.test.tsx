jest.mock('../CachedImage', () => ({ CachedImage: () => null }));
jest.mock('../NowPlayingIndicator', () => ({ NowPlayingIndicator: () => null }));
jest.mock('../RowMetaLine', () => ({ RowMetaLine: () => null }));
jest.mock('../SwipeableRow', () => ({
  SwipeableRow: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../hooks/useDownloadStatus', () => ({ useDownloadStatus: () => 'none' }));
jest.mock('../../hooks/useIsStarred', () => ({ useIsStarred: () => false }));
jest.mock('../../hooks/useRating', () => ({ useRating: () => 0 }));
jest.mock('../../hooks/useSongCoverArt', () => ({ useSongCoverArt: () => null }));
jest.mock('../../services/moreOptionsService', () => ({
  removeItemFromQueue: jest.fn(),
  toggleStar: jest.fn(),
}));
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: (selector: (state: { offlineMode: boolean }) => unknown) =>
    selector({ offlineMode: false }),
}));

import { render } from '@testing-library/react-native';
import { QueueItemRow } from '../QueueItemRow';

const colors = {
  textPrimary: '#fff', textSecondary: '#aaa', primary: '#f60', border: '#333', red: '#f00',
};
const track = { id: 'song', title: 'A long song title', artist: 'Artist', duration: 120 } as any;
const props = { track, index: 0, isActive: false, colors, onPress: jest.fn() };

it('shows the translated accessible badge only for autoplay rows', () => {
  const manual = render(<QueueItemRow {...props} />);
  expect(manual.queryByLabelText('Infinite Play')).toBeNull();
  manual.unmount();

  const autoplay = render(<QueueItemRow {...props} isAutoplay />);
  expect(autoplay.getByLabelText('Infinite Play')).toBeTruthy();
  expect(autoplay.getByText('● Infinite Play')).toBeTruthy();
});
