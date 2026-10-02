jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import React from 'react';
import { render } from '@testing-library/react-native';

const mockBegin = jest.fn(() => Promise.resolve());
jest.mock('../../services/backgroundDownloadService', () => ({
  beginBackgroundDownloads: () => mockBegin(),
  remainingQueuedSongs: () => 7,
}));

jest.mock('../../hooks/useTheme', () => ({ useTheme: () => ({ colors: {} }) }));

const mockAlertProps: { current: any } = { current: null };
jest.mock('../ThemedAlert', () => ({
  ThemedAlert: (props: any) => {
    mockAlertProps.current = props;
    return null;
  },
}));

import { downloadResumePromptStore } from '../../store/downloadResumePromptStore';
import { DownloadResumePromptModal } from '../DownloadResumePromptModal';

beforeEach(() => {
  jest.clearAllMocks();
  downloadResumePromptStore.setState({ dismissed: false, visible: true });
});

describe('DownloadResumePromptModal', () => {
  it('shows the pending count', () => {
    render(<DownloadResumePromptModal />);
    expect(mockAlertProps.current.visible).toBe(true);
    expect(mockAlertProps.current.message).toContain('7');
  });

  it('"Not now" suppresses the prompt', () => {
    render(<DownloadResumePromptModal />);
    const [notNow] = mockAlertProps.current.buttons;
    mockAlertProps.current.onDismiss();
    notNow.onPress();
    expect(downloadResumePromptStore.getState()).toMatchObject({ visible: false, dismissed: true });
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it('Resume begins background downloads without suppressing the prompt', () => {
    render(<DownloadResumePromptModal />);
    const [, resume] = mockAlertProps.current.buttons;
    mockAlertProps.current.onDismiss();
    resume.onPress();
    expect(mockBegin).toHaveBeenCalled();
    expect(downloadResumePromptStore.getState()).toMatchObject({ visible: false, dismissed: false });
  });
});
