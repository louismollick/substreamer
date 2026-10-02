import { renderHook } from '@testing-library/react-native';

const mockScheduleNotification = jest.fn(() => Promise.resolve('notif-1'));
const mockDismissNotification = jest.fn(() => Promise.resolve());
const mockRequestPermissions = jest.fn(() => Promise.resolve({ granted: true }));

jest.mock('expo-notifications', () => ({
  __esModule: true,
  setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  setNotificationHandler: jest.fn(),
  scheduleNotificationAsync: (...a: unknown[]) => (mockScheduleNotification as any)(...a),
  dismissNotificationAsync: (...a: unknown[]) => (mockDismissNotification as any)(...a),
  requestPermissionsAsync: (...a: unknown[]) => (mockRequestPermissions as any)(...a),
  AndroidImportance: { LOW: 2 },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));

let appStateListener: ((state: string) => Promise<void>) | null = null;

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (_e: string, cb: (state: string) => Promise<void>) => {
      appStateListener = cb;
      return { remove: () => { appStateListener = null; } };
    },
  },
  Platform: {
    OS: 'android',
    select(o: Record<string, unknown>) { return o[this.OS] ?? o.default; },
  },
}));

jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import { Platform } from 'react-native';

import { musicCacheStore } from '../../store/musicCacheStore';
import { useDownloadBackgroundNotification } from '../useDownloadBackgroundNotification';

beforeEach(() => {
  jest.clearAllMocks();
  appStateListener = null;
  musicCacheStore.setState({
    downloadQueue: [{ queueId: 'q', status: 'downloading' }],
  } as any);
});

describe('useDownloadBackgroundNotification', () => {
  it('warns on Android when backgrounded mid-download, and dismisses on return', async () => {
    (Platform as { OS: string }).OS = 'android';
    renderHook(() => useDownloadBackgroundNotification());
    await appStateListener!('background');
    expect(mockScheduleNotification).toHaveBeenCalled();
    await appStateListener!('active');
    expect(mockDismissNotification).toHaveBeenCalledWith('notif-1');
  });

  it('does nothing on iOS', () => {
    (Platform as { OS: string }).OS = 'ios';
    renderHook(() => useDownloadBackgroundNotification());
    expect(appStateListener).toBeNull();
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });
});
