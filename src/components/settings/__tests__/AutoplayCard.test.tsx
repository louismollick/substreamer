jest.mock('../../../store/persistence/kvStorage', () =>
  require('../../../store/persistence/__mocks__/kvStorage'),
);
jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: { primary: '#f60', textPrimary: '#fff', textSecondary: '#888', border: '#333' },
  }),
}));
const mockSetAutoplayEnabled = jest.fn();
jest.mock('../../../services/playerService', () => ({
  setAutoplayEnabled: (enabled: boolean) => mockSetAutoplayEnabled(enabled),
}));

import { fireEvent, render, screen } from '@testing-library/react-native';

import { playbackSettingsStore } from '../../../store/playbackSettingsStore';
import { AutoplayCard } from '../AutoplayCard';

beforeEach(() => {
  mockSetAutoplayEnabled.mockClear();
  playbackSettingsStore.setState({ autoplayEnabled: false });
});

it('explains autoplay and delegates queue effects to the player service', () => {
  render(<AutoplayCard />);
  expect(screen.getByText('Keep playing related music when your queue runs out.')).toBeTruthy();
  fireEvent(screen.getByTestId('autoplay-toggle'), 'valueChange', true);
  expect(mockSetAutoplayEnabled).toHaveBeenCalledWith(true);
});
