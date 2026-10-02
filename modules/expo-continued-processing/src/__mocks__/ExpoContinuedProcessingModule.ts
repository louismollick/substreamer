export default {
  isSupported: jest.fn().mockReturnValue(false),
  isActive: jest.fn().mockReturnValue(false),
  begin: jest.fn().mockResolvedValue(false),
  setProgress: jest.fn(),
  end: jest.fn(),
  isDiagnosticsEnabled: jest.fn().mockReturnValue(false),
  logDiagnostic: jest.fn(),
  addListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
};
