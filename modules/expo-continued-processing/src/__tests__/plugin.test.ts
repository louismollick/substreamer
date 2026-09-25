import withContinuedProcessing from '../../plugin';

jest.mock('expo/config-plugins', () => ({
  withInfoPlist: (config: any, mod: (cfg: any) => any) => mod(config),
}));


describe('expo-continued-processing plugin', () => {
  const original = process.env.SUBSTREAMER_DOWNLOAD_DIAGNOSTICS;
  afterEach(() => {
    if (original === undefined) delete process.env.SUBSTREAMER_DOWNLOAD_DIAGNOSTICS;
    else process.env.SUBSTREAMER_DOWNLOAD_DIAGNOSTICS = original;
  });

  it('adds the permitted identifier once and no diagnostics key by default', () => {
    delete process.env.SUBSTREAMER_DOWNLOAD_DIAGNOSTICS;
    const cfg = { modResults: { BGTaskSchedulerPermittedIdentifiers: ['other'], SubstreamerDownloadDiagnostics: true } };
    withContinuedProcessing(cfg);
    withContinuedProcessing(cfg);
    expect(cfg.modResults.BGTaskSchedulerPermittedIdentifiers).toEqual([
      'other',
      '$(PRODUCT_BUNDLE_IDENTIFIER).downloads.*',
    ]);
    expect(cfg.modResults.SubstreamerDownloadDiagnostics).toBeUndefined();
  });

  it('enables diagnostics from the environment', () => {
    process.env.SUBSTREAMER_DOWNLOAD_DIAGNOSTICS = '1';
    const cfg: any = { modResults: {} };
    withContinuedProcessing(cfg);
    expect(cfg.modResults.SubstreamerDownloadDiagnostics).toBe(true);
  });
});
