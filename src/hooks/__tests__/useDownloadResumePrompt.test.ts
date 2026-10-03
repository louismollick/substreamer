jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import { renderHook } from '@testing-library/react-native';

const mockOffer = { value: true };
jest.mock('../../services/backgroundDownloadService', () => ({
  shouldOfferResume: () => mockOffer.value,
}));

let mockForeground: (() => void) | null = null;
jest.mock('../../utils/onAppForeground', () => ({
  onAppForeground: (fn: () => void) => {
    mockForeground = fn;
    return { remove: () => { mockForeground = null; } };
  },
}));

import { downloadResumePromptStore } from '../../store/downloadResumePromptStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { useDownloadResumePrompt } from '../useDownloadResumePrompt';

beforeEach(() => {
  mockOffer.value = true;
  downloadResumePromptStore.setState({ dismissed: false, visible: false });
  musicCacheStore.setState({ hasHydrated: true } as any);
});

describe('useDownloadResumePrompt', () => {
  it('offers on mount once hydrated', () => {
    renderHook(() => useDownloadResumePrompt());
    expect(downloadResumePromptStore.getState().visible).toBe(true);
  });

  it('waits for hydration, then offers', () => {
    musicCacheStore.setState({ hasHydrated: false } as any);
    renderHook(() => useDownloadResumePrompt());
    expect(downloadResumePromptStore.getState().visible).toBe(false);
    musicCacheStore.setState({ hasHydrated: true } as any);
    expect(downloadResumePromptStore.getState().visible).toBe(true);
  });

  it('offers on foreground only when the service says so', () => {
    mockOffer.value = false;
    const { unmount } = renderHook(() => useDownloadResumePrompt());
    mockForeground!();
    expect(downloadResumePromptStore.getState().visible).toBe(false);
    mockOffer.value = true;
    mockForeground!();
    expect(downloadResumePromptStore.getState().visible).toBe(true);
    unmount();
    expect(mockForeground).toBeNull();
  });
});
