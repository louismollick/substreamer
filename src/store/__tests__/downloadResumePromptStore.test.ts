jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));

import { downloadResumePromptStore } from '../downloadResumePromptStore';

beforeEach(() => downloadResumePromptStore.setState({ dismissed: false, visible: false }));

describe('downloadResumePromptStore', () => {
  it('shows, and hides without suppressing', () => {
    downloadResumePromptStore.getState().show();
    expect(downloadResumePromptStore.getState().visible).toBe(true);
    downloadResumePromptStore.getState().hide(false);
    expect(downloadResumePromptStore.getState()).toMatchObject({ visible: false, dismissed: false });
  });

  it('"Not now" suppresses until cleared', () => {
    downloadResumePromptStore.getState().show();
    downloadResumePromptStore.getState().hide(true);
    expect(downloadResumePromptStore.getState().dismissed).toBe(true);
    downloadResumePromptStore.getState().hide(false);
    expect(downloadResumePromptStore.getState().dismissed).toBe(true);
    downloadResumePromptStore.getState().clearDismissed();
    expect(downloadResumePromptStore.getState().dismissed).toBe(false);
  });
});
