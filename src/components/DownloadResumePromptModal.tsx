import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { ThemedAlert } from './ThemedAlert';
import { useTheme } from '../hooks/useTheme';
import { beginBackgroundDownloads, remainingQueuedSongs } from '../services/backgroundDownloadService';
import { downloadResumePromptStore } from '../store/downloadResumePromptStore';

/**
 * Offers to resume background downloading when songs are queued but no
 * background task is running (after it expired, the app was force-quit, or a
 * relaunch). The Resume tap is the user action iOS requires to start the task.
 */
export function DownloadResumePromptModal() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const visible = downloadResumePromptStore((s) => s.visible);

  // ThemedAlert calls onDismiss before every button's onPress, so dismissal
  // alone only hides; "Not now" is what suppresses the prompt.
  const hide = useCallback(() => {
    downloadResumePromptStore.getState().hide(false);
  }, []);

  const notNow = useCallback(() => {
    downloadResumePromptStore.getState().hide(true);
  }, []);

  const resume = useCallback(() => {
    void beginBackgroundDownloads();
  }, []);

  return (
    <ThemedAlert
      visible={visible}
      title={t('resumeDownloadsTitle')}
      message={t('resumeDownloadsBody', { count: visible ? remainingQueuedSongs() : 0 })}
      buttons={[
        { text: t('resumeDownloadsNotNow'), style: 'cancel', onPress: notNow },
        { text: t('resume'), style: 'default', onPress: resume },
      ]}
      onDismiss={hide}
      colors={colors}
    />
  );
}
