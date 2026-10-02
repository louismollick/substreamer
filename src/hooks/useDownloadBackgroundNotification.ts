import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';

import { musicCacheStore } from '../store/musicCacheStore';

const CHANNEL_ID = 'downloads';

if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Downloads',
    importance: Notifications.AndroidImportance.LOW,
    sound: null,
  });
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export function useDownloadBackgroundNotification() {
  const { t } = useTranslation();
  const notificationId = useRef<string | null>(null);

  useEffect(() => {
    // iOS: downloads continue under the continued-processing task (iOS 26+),
    // whose Live Activity shows progress; the "return to the app" warning is
    // Android-only.
    if (Platform.OS === 'ios') return;
    const sub = AppState.addEventListener('change', async (next) => {
      const hasActive = musicCacheStore.getState().downloadQueue
        .some((q) => q.status === 'queued' || q.status === 'downloading');

      if (next === 'background' && hasActive) {
        const { granted } = await Notifications.requestPermissionsAsync();
        if (!granted) return;

        notificationId.current = await Notifications.scheduleNotificationAsync({
          content: {
            title: t('downloadsInProgress'),
            body: t('downloadsInProgressBody'),
            ...(Platform.OS === 'android' && { channelId: CHANNEL_ID }),
          },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 1 },
        });
      } else if (next === 'active' && notificationId.current) {
        await Notifications.dismissNotificationAsync(notificationId.current);
        notificationId.current = null;
      }
    });

    return () => sub.remove();
  }, [t]);
}
