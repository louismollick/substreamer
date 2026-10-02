const { withInfoPlist } = require('expo/config-plugins');

// Wildcard: each task submits `<bundle id>.downloads.<uuid>`.
const IDENTIFIER = '$(PRODUCT_BUNDLE_IDENTIFIER).downloads.*';

/**
 * Permits the continued-processing identifier and, when
 * `SUBSTREAMER_DOWNLOAD_DIAGNOSTICS=1` at prebuild, enables the JSONL download
 * diagnostics log read by scripts/device/.
 */
function withContinuedProcessing(config) {
  return withInfoPlist(config, (cfg) => {
    const permitted = cfg.modResults.BGTaskSchedulerPermittedIdentifiers ?? [];
    if (!permitted.includes(IDENTIFIER)) permitted.push(IDENTIFIER);
    cfg.modResults.BGTaskSchedulerPermittedIdentifiers = permitted;
    if (process.env.SUBSTREAMER_DOWNLOAD_DIAGNOSTICS === '1') {
      cfg.modResults.SubstreamerDownloadDiagnostics = true;
    } else {
      delete cfg.modResults.SubstreamerDownloadDiagnostics;
    }
    return cfg;
  });
}

module.exports = withContinuedProcessing;
module.exports.IDENTIFIER = IDENTIFIER;
