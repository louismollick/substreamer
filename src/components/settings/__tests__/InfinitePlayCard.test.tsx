jest.mock('../../../store/persistence/kvStorage', () =>
  require('../../../store/persistence/__mocks__/kvStorage'),
);
jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#f60', textPrimary: '#fff', textSecondary: '#888',
      border: '#333', card: '#111',
    },
  }),
}));
const mockSetInfinitePlayEnabled = jest.fn();
jest.mock('../../../services/playerService', () => ({
  setInfinitePlayEnabled: (enabled: boolean) => mockSetInfinitePlayEnabled(enabled),
}));

import { fireEvent, render, screen } from '@testing-library/react-native';
import { InfinitePlayCard } from '../InfinitePlayCard';
import { playbackSettingsStore } from '../../../store/playbackSettingsStore';

beforeEach(() => {
  mockSetInfinitePlayEnabled.mockClear();
  playbackSettingsStore.setState({ infinitePlayEnabled: false });
});

it('uses the service-level toggle and explains offline behavior', () => {
  render(<InfinitePlayCard />);
  expect(screen.getByText(/Uses downloaded music while offline/)).toBeTruthy();
  fireEvent(screen.getByTestId('infinite-play-toggle'), 'valueChange', true);
  expect(mockSetInfinitePlayEnabled).toHaveBeenCalledWith(true);
});
