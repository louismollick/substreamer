import { memo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/hooks/useTheme';
import { playerStore } from '@/store/playerStore';
import { isAutoplaySectionStart } from '@/utils/queueOrigins';

export const AutoplayQueueFooter = memo(function AutoplayQueueFooter() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const autoplayLoading = playerStore((state) => state.autoplayLoading);
  const currentTrackIndex = playerStore((state) => state.currentTrackIndex);
  const queueOrigins = playerStore((state) => state.queueOrigins);
  const hasAutoplayHeading = queueOrigins.some((_, index) =>
    isAutoplaySectionStart(queueOrigins, currentTrackIndex, index),
  );

  if (!autoplayLoading) return null;

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="progressbar"
      accessibilityLabel={t('buildingAutoplayQueue')}
    >
      {!hasAutoplayHeading && (
        <View style={styles.sectionHeader}>
          <Text
            accessibilityRole="header"
            style={[styles.sectionHeaderText, { color: colors.textPrimary }]}
          >
            {t('autoplay')}
          </Text>
        </View>
      )}
      <View style={styles.loadingRow}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
          {t('buildingAutoplayQueue')}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  sectionHeader: {
    paddingTop: 18,
    paddingBottom: 4,
    paddingHorizontal: 16,
  },
  sectionHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  loadingText: {
    fontSize: 14,
  },
});
