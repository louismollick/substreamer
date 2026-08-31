import { HeaderHeightContext } from "expo-router/react-navigation";
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AlbumListView, albumIdentity } from '../components/AlbumListView';
import { GradientBackground } from '../components/GradientBackground';
import { BottomChrome } from '../components/BottomChrome';
import {
  albumListsStore,
  type AlbumListType,
} from '../store/albumListsStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { listDownloadedAlbumIds } from '../db/repository/downloads';
import { getDb } from '../store/persistence/db';
import { minDelay } from '../utils/stringHelpers';

const TYPE_TO_TITLE_KEY: Record<AlbumListType, string> = {
  recentlyAdded: 'recentlyAdded',
  recentlyPlayed: 'recentlyPlayed',
  frequentlyPlayed: 'frequentlyPlayed',
  randomSelection: 'randomSelection',
};

const TYPE_TO_REFRESH: Record<AlbumListType, () => Promise<void>> = {
  recentlyAdded: () => albumListsStore.getState().refreshRecentlyAdded(),
  recentlyPlayed: () => albumListsStore.getState().refreshRecentlyPlayed(),
  frequentlyPlayed: () => albumListsStore.getState().refreshFrequentlyPlayed(),
  randomSelection: () => albumListsStore.getState().refreshRandomSelection(),
};

const VALID_TYPES: AlbumListType[] = [
  'recentlyAdded',
  'recentlyPlayed',
  'frequentlyPlayed',
  'randomSelection',
];

export function AlbumListScreen() {
  const { t } = useTranslation();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ type?: string; downloadedOnly?: string }>();
  const type = (VALID_TYPES.includes(params.type as AlbumListType)
    ? params.type
    : 'recentlyAdded') as AlbumListType;

  const albums = albumListsStore((s) => s[type]);
  const downloadedOnly = params.downloadedOnly === 'true';
  const includePartial = layoutPreferencesStore((s) => s.includePartialInDownloadedFilter);
  const revision = musicCacheStore((s) => s.revision);
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [downloadedLoaded, setDownloadedLoaded] = useState(!downloadedOnly);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!downloadedOnly) {
      setDownloadedLoaded(true);
      return;
    }
    setDownloadedLoaded(false);
    let alive = true;
    const db = getDb();
    void (db
      ? listDownloadedAlbumIds(db, { includePartial })
      : Promise.resolve(new Set<string>())
    ).then((ids) => {
      if (alive) {
        setDownloadedIds(ids);
        setDownloadedLoaded(true);
      }
    });
    return () => { alive = false; };
  }, [downloadedOnly, includePartial, revision]);

  const visibleAlbums = useMemo(
    () => downloadedOnly ? albums.filter((album) => downloadedIds.has(album.id)) : albums,
    [albums, downloadedIds, downloadedOnly],
  );

  useEffect(() => {
    navigation.setOptions({ title: t(TYPE_TO_TITLE_KEY[type]) });
  }, [type, navigation, t]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    const delay = minDelay();
    await TYPE_TO_REFRESH[type]();
    await delay;
    setRefreshing(false);
  }, [type]);

  return (
    <GradientBackground style={styles.container} scrollable>
      <AlbumListView
        items={visibleAlbums}
        toAlbum={albumIdentity}
        loading={!downloadedLoaded}
        error={null}
        onRefresh={offlineMode || downloadedOnly ? undefined : handleRefresh}
        refreshing={refreshing}
        emptyMessage={downloadedOnly ? t('noDownloadedAlbums') : undefined}
        emptySubtitle={downloadedOnly ? t('noDownloadedAlbumsSubtitle') : undefined}
        contentInsetTop={headerHeight}
      />
      <BottomChrome withSafeAreaPadding />
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
