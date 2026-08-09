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
const mockSetAutoplayEnabled = jest.fn();
jest.mock('../../../services/playerService', () => ({
  setAutoplayEnabled: (enabled: boolean) => mockSetAutoplayEnabled(enabled),
}));

import { fireEvent, render, screen } from '@testing-library/react-native';
import { AutoplayCard } from '../AutoplayCard';
import { playbackSettingsStore } from '../../../store/playbackSettingsStore';

beforeEach(() => {
  mockSetAutoplayEnabled.mockClear();
  playbackSettingsStore.setState({ autoplayEnabled: false });
});

it('uses the service-level toggle and explains autoplay behavior', () => {
  render(<AutoplayCard />);
  expect(screen.getByText('Autoplay')).toBeTruthy();
  expect(screen.getByText('Similar content will play when what you’re listening to ends.')).toBeTruthy();
  fireEvent(screen.getByTestId('autoplay-toggle'), 'valueChange', true);
  expect(mockSetAutoplayEnabled).toHaveBeenCalledWith(true);
});
