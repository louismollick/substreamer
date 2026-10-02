import ExpoContinuedProcessingModule from '../ExpoContinuedProcessingModule';
import {
  addContinuedProcessingExpiredListener,
  beginContinuedProcessing,
  endContinuedProcessing,
  isContinuedProcessingActive,
  isContinuedProcessingSupported,
  isDownloadDiagnosticsEnabled,
  logDownloadDiagnostic,
  setContinuedProcessingProgress,
} from '../index';

jest.mock('../ExpoContinuedProcessingModule');

const mockModule = jest.mocked(ExpoContinuedProcessingModule);

beforeEach(() => jest.clearAllMocks());

describe('expo-continued-processing', () => {
  it('reports support and activity from native', () => {
    mockModule.isSupported.mockReturnValue(true);
    mockModule.isActive.mockReturnValue(true);
    expect(isContinuedProcessingSupported()).toBe(true);
    expect(isContinuedProcessingActive()).toBe(true);
  });

  it('forwards begin arguments and result', async () => {
    mockModule.begin.mockResolvedValue(true);
    await expect(beginContinuedProcessing('T', 'S', 12)).resolves.toBe(true);
    expect(mockModule.begin).toHaveBeenCalledWith('T', 'S', 12);
  });

  it('passes a null subtitle when none is given', () => {
    setContinuedProcessingProgress(1, 4);
    expect(mockModule.setProgress).toHaveBeenCalledWith(1, 4, null);
    setContinuedProcessingProgress(2, 4, 'x');
    expect(mockModule.setProgress).toHaveBeenLastCalledWith(2, 4, 'x');
  });

  it('ends and subscribes', () => {
    endContinuedProcessing(true);
    expect(mockModule.end).toHaveBeenCalledWith(true);
    const listener = jest.fn();
    addContinuedProcessingExpiredListener(listener);
    expect(mockModule.addListener).toHaveBeenCalledWith('onExpired', listener);
  });

  it('forwards diagnostics calls', () => {
    mockModule.isDiagnosticsEnabled.mockReturnValue(true);
    expect(isDownloadDiagnosticsEnabled()).toBe(true);
    logDownloadDiagnostic({ event: 'x' });
    expect(mockModule.logDiagnostic).toHaveBeenCalledWith({ event: 'x' });
  });
});
