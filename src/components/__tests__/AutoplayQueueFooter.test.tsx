jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      textPrimary: '#ffffff',
      textSecondary: '#999999',
    },
  }),
}));

import { render } from '@testing-library/react-native';

import { AutoplayQueueFooter } from '../AutoplayQueueFooter';
import { playerStore } from '../../store/playerStore';

beforeEach(() => {
  playerStore.setState({ autoplayLoading: false });
});

it('stays hidden when Autoplay is idle', () => {
  const { queryByText } = render(<AutoplayQueueFooter />);
  expect(queryByText('Building your autoplay queue…')).toBeNull();
});

it('shows an accessible Autoplay loading status', () => {
  playerStore.setState({ autoplayLoading: true });
  const { getByRole, getByLabelText, getByText } = render(<AutoplayQueueFooter />);

  expect(getByRole('header')).toHaveTextContent('Autoplay');
  expect(getByLabelText('Building your autoplay queue…').props.accessibilityLiveRegion)
    .toBe('polite');
  expect(getByText('Building your autoplay queue…')).toBeTruthy();
});
