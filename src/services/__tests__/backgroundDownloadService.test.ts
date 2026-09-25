const mockNative = {
  supported: true,
  active: false,
  beginResult: true,
  begin: jest.fn(),
  setProgress: jest.fn(),
  end: jest.fn(),
  log: jest.fn(),
  diagnostics: false,
  expiredListener: null as null | (() => void),
};

jest.mock('expo-continued-processing', () => ({
  isContinuedProcessingSupported: () => mockNative.supported,
  isContinuedProcessingActive: () => mockNative.active,
  beginContinuedProcessing: (...args: unknown[]) => {
    mockNative.begin(...args);
    if (mockNative.beginResult) mockNative.active = true;
    return Promise.resolve(mockNative.beginResult);
  },
  setContinuedProcessingProgress: (...args: unknown[]) => mockNative.setProgress(...args),
  endContinuedProcessing: (...args: unknown[]) => {
    mockNative.active = false;
    mockNative.end(...args);
  },
  addContinuedProcessingExpiredListener: (fn: () => void) => {
    mockNative.expiredListener = fn;
    return { remove: () => { mockNative.expiredListener = null; } };
  },
  isDownloadDiagnosticsEnabled: () => mockNative.diagnostics,
  logDownloadDiagnostic: (...args: unknown[]) => mockNative.log(...args),
}));

const mockAppState = { currentState: 'active' };
jest.mock('react-native', () => ({
  get AppState() { return mockAppState; },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
}));

jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import { downloadResumePromptStore } from '../../store/downloadResumePromptStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { storageLimitStore } from '../../store/storageLimitStore';
import {
  beginBackgroundDownloads,
  canResumeInBackground,
  endBackgroundDownloads,
  logDownloadEvent,
  onBackgroundDownloadsExpired,
  remainingQueuedSongs,
  shouldOfferResume,
} from '../backgroundDownloadService';

const item = (queueId: string, status: string, totalSongs: number, completedSongs = 0) =>
  ({ queueId, itemId: queueId, type: 'album', name: queueId, status, totalSongs, completedSongs, addedAt: 0, queuePosition: 1 });

beforeEach(() => {
  endBackgroundDownloads(false);
  jest.clearAllMocks();
  Object.assign(mockNative, { supported: true, active: false, beginResult: true, diagnostics: false });
  mockAppState.currentState = 'active';
  musicCacheStore.setState({ downloadQueue: [item('a', 'queued', 3)], totalFiles: 10 } as any);
  offlineModeStore.setState({ offlineMode: false } as any);
  storageLimitStore.setState({ isStorageFull: false } as any);
  downloadResumePromptStore.setState({ dismissed: false, visible: false });
});

describe('remainingQueuedSongs', () => {
  it('counts unfinished songs of queued and downloading items only', () => {
    expect(remainingQueuedSongs([
      item('a', 'queued', 3),
      item('b', 'downloading', 5, 2),
      item('c', 'error', 4, 1),
    ] as any)).toBe(6);
  });
});

describe('beginBackgroundDownloads', () => {
  it('submits with the pending total and clears a previous "Not now"', async () => {
    downloadResumePromptStore.setState({ dismissed: true });
    await beginBackgroundDownloads();
    expect(mockNative.begin).toHaveBeenCalledWith('Downloading music', '0 of 3 songs', 3);
    expect(downloadResumePromptStore.getState().dismissed).toBe(false);
  });

  it('does nothing when unsupported, backgrounded, or nothing is pending', async () => {
    mockNative.supported = false;
    await beginBackgroundDownloads();
    mockNative.supported = true;
    mockAppState.currentState = 'background';
    await beginBackgroundDownloads();
    mockAppState.currentState = 'active';
    musicCacheStore.setState({ downloadQueue: [] } as any);
    await beginBackgroundDownloads();
    expect(mockNative.begin).not.toHaveBeenCalled();
  });

  it('keeps "Not now" when the system refuses the task', async () => {
    mockNative.beginResult = false;
    downloadResumePromptStore.setState({ dismissed: true });
    await beginBackgroundDownloads();
    expect(downloadResumePromptStore.getState().dismissed).toBe(true);
  });

  it('reports progress as songs finish and ends when the queue drains', async () => {
    await beginBackgroundDownloads();
    musicCacheStore.setState({ downloadQueue: [item('a', 'downloading', 3, 1)], totalFiles: 11 } as any);
    expect(mockNative.setProgress).toHaveBeenLastCalledWith(1, 3, '1 of 3 songs');
    musicCacheStore.setState({ downloadQueue: [], totalFiles: 13 } as any);
    expect(mockNative.end).toHaveBeenCalledWith(true);
  });

  it('raises the total when more is queued while running', async () => {
    await beginBackgroundDownloads();
    musicCacheStore.setState({ downloadQueue: [item('a', 'queued', 3), item('b', 'queued', 2)] } as any);
    await beginBackgroundDownloads();
    expect(mockNative.begin).toHaveBeenLastCalledWith('Downloading music', '0 of 5 songs', 5);
  });
});

describe('expiry', () => {
  it('stops progress reporting and calls the handler', async () => {
    const handler = jest.fn();
    const sub = onBackgroundDownloadsExpired(handler);
    await beginBackgroundDownloads();
    mockNative.active = false;
    mockNative.expiredListener!();
    expect(handler).toHaveBeenCalled();
    mockNative.setProgress.mockClear();
    musicCacheStore.setState({ downloadQueue: [item('a', 'downloading', 3, 1)], totalFiles: 11 } as any);
    expect(mockNative.setProgress).not.toHaveBeenCalled();
    sub.remove();
  });
});

describe('resume offer', () => {
  it('offers when work is pending and no task runs', () => {
    expect(canResumeInBackground()).toBe(true);
    expect(shouldOfferResume()).toBe(true);
  });

  it('does not offer while active, offline, storage-full, unsupported or after "Not now"', async () => {
    await beginBackgroundDownloads();
    expect(canResumeInBackground()).toBe(false);
    endBackgroundDownloads(false);

    offlineModeStore.setState({ offlineMode: true } as any);
    expect(canResumeInBackground()).toBe(false);
    offlineModeStore.setState({ offlineMode: false } as any);

    storageLimitStore.setState({ isStorageFull: true } as any);
    expect(canResumeInBackground()).toBe(false);
    storageLimitStore.setState({ isStorageFull: false } as any);

    mockNative.supported = false;
    expect(canResumeInBackground()).toBe(false);
    mockNative.supported = true;

    downloadResumePromptStore.setState({ dismissed: true });
    expect(canResumeInBackground()).toBe(true);
    expect(shouldOfferResume()).toBe(false);
  });
});

describe('diagnostics', () => {
  it('logs only in diagnostics builds, with a heartbeat while tracking', async () => {
    logDownloadEvent('x');
    expect(mockNative.log).not.toHaveBeenCalled();

    jest.useFakeTimers();
    try {
      mockNative.diagnostics = true;
      logDownloadEvent('x', { a: 1 });
      expect(mockNative.log).toHaveBeenCalledWith(expect.objectContaining({ src: 'js', event: 'x', a: 1 }));
      await beginBackgroundDownloads();
      jest.advanceTimersByTime(5000);
      expect(mockNative.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'heartbeat', remaining: 3 }));
    } finally {
      endBackgroundDownloads(false);
      jest.useRealTimers();
    }
  });
});
