import { useCallback } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { setInfinitePlayEnabled } from '../../services/playerService';
import { playbackSettingsStore } from '../../store/playbackSettingsStore';
import { settingsStyles } from '../../styles/settingsStyles';
import { SettingsSectionTitle } from './SettingsSectionTitle';

export function InfinitePlayCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const enabled = playbackSettingsStore((state) => state.infinitePlayEnabled);
  const handleToggle = useCallback((value: boolean) => {
    void setInfinitePlayEnabled(value);
  }, []);

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('infinitePlay')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, styles.row, { backgroundColor: colors.card }]}>
        <View style={styles.text}>
          <Text style={[styles.label, { color: colors.textPrimary }]}>{t('infinitePlay')}</Text>
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('infinitePlayHint')}</Text>
        </View>
        <Switch
          testID="infinite-play-toggle"
          value={enabled}
          onValueChange={handleToggle}
          trackColor={{ false: colors.border, true: colors.primary }}
          accessibilityLabel={t('infinitePlay')}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  text: { flex: 1, gap: 4 },
  label: { fontSize: 16, fontWeight: '500' },
  hint: { fontSize: 13, lineHeight: 18 },
});
