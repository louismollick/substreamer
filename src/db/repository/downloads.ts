/**
 * Downloads repository — the ONE place the download tables are read for filtering.
 *
 * These reads answer "what is on disk", and they read `cached_items` / `cached_albums` /
 * `cached_playlists` ONLY. They are deliberately never joined to `albums`/`songs`: the
 * download tables have no FK to the library, a downloaded item need not be in the (paged,
 * reapable) library at all, and an offline list that drops rows the user has on disk — or
 * shows rows they don't — is the one thing offline must not do.
 *
 * Two predicates live here and they are NOT the same thing:
 *
 *  - **Membership** — "is this id downloaded" (`downloadedClause`, `listDownloadedAlbumIds`).
 *    Reads `cached_items` alone. Used to filter a list that came from somewhere else (search
 *    results, the home album lists), where the caller already holds the metadata.
 *  - **Visibility** — "which downloaded albums can we RENDER" (`listDownloadedAlbums`).
 *    INNER JOINs `cached_albums`, because a row with no component metadata cannot be drawn.
 *    That join is what keeps derived partial-album rows (which carry no metadata) out of the
 *    list. Never fall back to `cached_items.name`/`artist` — those are always populated and
 *    would surface rows that are hidden today.
 *
 * Conflating the two would either hide downloaded albums from search or surface metadata-less
 * rows in the library browser.
 */
import type { AlbumID3, ArtistID3, Child } from 'subsonic-api';

import type { InternalDb } from '../client';
import { albumListRowToAlbumID3, type AlbumListRow, type AlbumSortOrder } from './albums';
import {
  ARTIST_LIST_COLS,
  artistListRowToArtistID3,
  hydrateArtistRows,
  type ArtistListRow,
} from './artists';
import { colsOf } from './core';
import { type PlaylistListRow } from './playlists';
import { type SongSortOrder } from './songs';

/** The three library tables that carry a `starred` mark, minus the ones that cannot be
 *  downloaded. Artists are excluded by construction — see `favorites.ts`. */
export type DownloadableEntity = 'songs' | 'albums';

/**
 * SQL form of `isPartialAlbum` — a complete download has at least as many
 * `cached_item_songs` edges as the item's `expected_song_count`.
 *
 * Assumes the enclosing query aliases `cached_items` as `ci`.
 */
export const partialGate = (includePartial: boolean): string =>
  includePartial
    ? ''
    : ' AND (SELECT COUNT(*) FROM cached_item_songs e WHERE e.item_id = ci.item_id)' +
      ' >= ci.expected_song_count';

/**
 * "This id is downloaded." Positive `IN` probes over the DOWNLOAD tables, which are bounded
 * by what is on disk — so unlike a disjointness clause there is no ephemeral-b-tree build to
 * avoid. Both PKs are `id`, so the identical string serves a library row and its remainder
 * counterpart.
 */
export function downloadedClause(entity: DownloadableEntity, includePartial: boolean): string {
  switch (entity) {
    case 'songs':
      return 'id IN (SELECT song_id FROM cached_songs)';
    case 'albums':
      return `id IN (SELECT ci.item_id FROM cached_items ci WHERE ci.type='album'${partialGate(includePartial)})`;
  }
}

/* ------------------------------------------------------------------ */
/*  Projections                                                        */
/* ------------------------------------------------------------------ */

/**
 * `cached_albums` carries every `AlbumListRow` column, sort keys included: they are
 * written from the same metadata through the same `db/sortKeys` derivation the `albums`
 * table uses, so the Downloaded filter can `ORDER BY` them and land on exactly the order
 * the unfiltered browse list shows.
 *
 * Typed against `AlbumListRow` so a stale or misspelled column is a compile error.
 */
type CachedAlbumField = Exclude<
  keyof AlbumListRow,
  'id' | 'artists' | 'genres' | 'discTitles' | 'moods' | 'recordLabels' | 'releaseTypes'
>;

const CACHED_ALBUM_FIELDS: readonly CachedAlbumField[] = [
  'artist_id', 'name', 'artist', 'display_artist', 'cover_art', 'song_count', 'duration',
  'play_count', 'created', 'starred', 'year', 'genre', 'played', 'user_rating', 'version',
  'music_brainz_id', 'sort_name', 'sort_title', 'sort_artist', 'is_compilation',
  'explicit_status', 'original_release_year', 'original_release_month',
  'original_release_day', 'release_year', 'release_month', 'release_day',
];

const CACHED_ALBUM_COLS = [
  'ca."item_id" AS "id"',
  colsOf(CACHED_ALBUM_FIELDS, 'ca'),
].join(', ');

type CachedPlaylistField = Exclude<keyof PlaylistListRow, 'id'>;

const CACHED_PLAYLIST_FIELDS: readonly CachedPlaylistField[] = [
  'name', 'comment', 'cover_art', 'created', 'changed', 'duration', 'owner', 'public',
  'song_count', 'sort_title',
];

const CACHED_PLAYLIST_COLS = [
  'cp."item_id" AS "id"',
  colsOf(CACHED_PLAYLIST_FIELDS, 'cp'),
].join(', ');

/**
 * The ORDER BY for a downloaded album list. `sort_artist` first groups an artist's
 * albums and alphabetises within them; `item_id` last makes the order total, matching
 * `albums`' `(sort_artist, sort_title, id)` / `(sort_title, id)` keyset exactly.
 */
const albumOrderBy = (sortOrder?: AlbumSortOrder): string =>
  sortOrder === 'artist'
    ? 'ca."sort_artist", ca."sort_title", ca."item_id"'
    : 'ca."sort_title", ca."item_id"';

/**
 * The key a returned row was ORDERED BY — the leading column of the tuple above, read
 * back off the row. The A–Z scroller derives its letter from this and nothing else, so
 * it lives beside the `ORDER BY` it has to agree with rather than at the consumer.
 */
export const downloadedAlbumSortKey = (
  r: { sort_title: string | null; sort_artist: string | null },
  sortOrder?: AlbumSortOrder,
): string => (sortOrder === 'artist' ? r.sort_artist : r.sort_title) ?? '';

/** The playlist counterpart — `listDownloadedPlaylists` has one order, on `sort_title`. */
export const downloadedPlaylistSortKey = (r: { sort_title: string | null }): string =>
  r.sort_title ?? '';

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

export interface DownloadedFilter {
  includePartial?: boolean;
}

export interface DownloadedAlbumFilter extends DownloadedFilter {
  /** The user's album-list preference. Defaults to title order, as `listAlbums` does. */
  sortOrder?: AlbumSortOrder;
}

/**
 * The DOWNLOADED albums, rebuilt from their `cached_albums` component rows — the
 * never-reaped source of truth for downloaded metadata, independent of the (paged) library.
 *
 * Bounded by what is on disk, so this is a whole-set read by design; there is no cursor.
 * Children (`artists`/`genres`/…) are deliberately NOT hydrated — the downloaded album
 * list does not render them.
 */
export async function listDownloadedAlbums(
  db: InternalDb,
  f: DownloadedAlbumFilter = {},
): Promise<AlbumListRow[]> {
  return db.getAllAsync<AlbumListRow>(
    `SELECT ${CACHED_ALBUM_COLS} FROM cached_albums ca ` +
      'JOIN cached_items ci ON ci.item_id = ca.item_id ' +
      `WHERE ci.type='album'${partialGate(f.includePartial === true)} ` +
      `ORDER BY ${albumOrderBy(f.sortOrder)}`,
  );
}

/**
 * The DOWNLOADED playlists, in the same `sort_title` A–Z the playlist browse uses. No
 * partial gate: playlists download atomically, so there is no partial state to include
 * or exclude.
 */
export async function listDownloadedPlaylists(db: InternalDb): Promise<PlaylistListRow[]> {
  return db.getAllAsync<PlaylistListRow>(
    `SELECT ${CACHED_PLAYLIST_COLS} FROM cached_playlists cp ` +
      'JOIN cached_items ci ON ci.item_id = cp.item_id ' +
      "WHERE ci.type='playlist' " +
      'ORDER BY cp."sort_title", cp."item_id"',
  );
}

/**
 * The set of downloaded ALBUM ids — the MEMBERSHIP predicate, for filtering a list that came
 * from elsewhere. Reads `cached_items` only, with no join to `cached_albums`, exactly
 * matching `albumPassesDownloadedFilter`: an album the caller already holds metadata for is
 * downloaded iff it has an item row, whether or not its component row is populated.
 */
export async function listDownloadedAlbumIds(
  db: InternalDb,
  f: DownloadedFilter = {},
): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ item_id: string }>(
    'SELECT ci.item_id FROM cached_items ci ' +
      `WHERE ci.type='album'${partialGate(f.includePartial === true)}`,
  );
  return new Set(rows.map((r) => r.item_id));
}

/** A downloaded album and only the tracks attached to its durable cache item. */
export async function getDownloadedAlbumProjection(
  db: InternalDb,
  albumId: string,
): Promise<{ album: AlbumID3; songs: Child[] } | null> {
  const albumRow = await db.getFirstAsync<AlbumListRow>(
    `SELECT ${CACHED_ALBUM_COLS} FROM cached_albums ca
      JOIN cached_items ci ON ci.item_id = ca.item_id
     WHERE ci.type = 'album' AND ca.item_id = ?`,
    [albumId],
  );
  if (!albumRow) return null;

  const songRows = await db.getAllAsync<DownloadedSongRow & { src_suffix: string | null }>(
    `SELECT cs.song_id AS id, cs.title, cs.artist, cs.sort_name, cs.sort_title,
            cs.sort_artist, COALESCE(cs.src_album_id, cs.album_id) AS album_id,
            cs.duration, cs.cover_art, cs.user_rating, cs.artist_id, cs.album,
            cs.track, cs.disc_number, cs.year, cs.suffix, cs.src_suffix, cs.content_type
       FROM cached_item_songs cis
       JOIN cached_songs cs ON cs.song_id = cis.song_id
      WHERE cis.item_id = ?
      ORDER BY cis.position`,
    [albumId],
  );
  if (songRows.length === 0) return null;

  return {
    album: albumListRowToAlbumID3(albumRow),
    songs: songRows.map((row) => downloadedSongRowToChild({
      ...row,
      suffix: row.src_suffix ?? row.suffix,
    })),
  };
}

/**
 * A downloaded song, at the projection the Songs tab's downloaded filter renders — nine
 * columns of the ~58 `cached_songs` holds. Widening it changes what those rows render, so
 * it needs its own verification pass.
 */
export interface DownloadedSongRow {
  id: string;
  title: string;
  artist: string | null;
  /** Part of the `Child` these rows rebuild: the library's `songListRowToChild` carries
   *  `sortName`, and a downloaded song's envelope must not differ from it. */
  sort_name: string | null;
  /** The keys this list is ORDERED BY. Projected, not discarded, because the A–Z
   *  scroller's letter is derived from the key the row actually sorted on — recomputing
   *  it from the title would be a second, divergent derivation. */
  sort_title: string | null;
  sort_artist: string | null;
  /**
   * The SERVER's album — `src_album_id`, NOT `cached_songs.album_id`.
   *
   * `album_id` is the file's DIRECTORY (`_unknown` when the server gave none), so it must
   * never reach `Child.albumId`, which "go to album", album-mode cover art and navigation
   * all read.
   *
   * Falls back to `album_id` when `src_album_id` is NULL: that column post-dates some
   * rows, and for those the directory is still the only answer there is.
   */
  album_id: string;
  duration: number;
  cover_art: string | null;
  /** The row's own star rating. Projected because the rows RENDER it — without it a
   *  rated song shows no stars under the Downloaded filter while showing them in the
   *  unfiltered list, which reads the same rating from `songs`. */
  user_rating: number | null;
  artist_id?: string | null;
  album?: string | null;
  track?: number | null;
  disc_number?: number | null;
  year?: number | null;
  suffix?: string | null;
  content_type?: string | null;
}

export interface DownloadedSongFilter {
  /** The user's song-list preference. Defaults to title order, as `listSongs` does. */
  sortOrder?: SongSortOrder;
}

/**
 * The ORDER BY for a downloaded song list — the same tuples `songSortCols` gives the
 * browse keyset, on the same stored keys, so the Downloaded filter cannot reorder the
 * list. `song_id` last makes the order total.
 */
const songOrderBy = (sortOrder?: SongSortOrder): string =>
  sortOrder === 'artist'
    ? '"sort_artist", "sort_title", "song_id"'
    : '"sort_title", "song_id"';

/** The key a returned row was ORDERED BY — see {@link downloadedAlbumSortKey}. */
export const downloadedSongSortKey = (r: DownloadedSongRow, sortOrder?: SongSortOrder): string =>
  (sortOrder === 'artist' ? r.sort_artist : r.sort_title) ?? '';

/**
 * The DOWNLOADED songs. Bounded by what is on disk, so this is a whole-set read by design;
 * there is no cursor. `song_id` is the primary key, so ids are unique structurally.
 */
export async function listDownloadedSongs(
  db: InternalDb,
  f: DownloadedSongFilter = {},
): Promise<DownloadedSongRow[]> {
  return db.getAllAsync<DownloadedSongRow>(
    'SELECT "song_id" AS "id", "title", "artist", "sort_name", "sort_title", "sort_artist", ' +
      'COALESCE("src_album_id", "album_id") AS "album_id", "duration", "cover_art", "user_rating" ' +
      `FROM cached_songs ORDER BY ${songOrderBy(f.sortOrder)}`,
  );
}

/** Adapt a downloaded song row to the `Child` the song rows render. */
export function downloadedSongRowToChild(r: DownloadedSongRow): Child {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist ?? undefined,
    albumId: r.album_id,
    duration: r.duration,
    coverArt: r.cover_art ?? undefined,
    sortName: r.sort_name ?? undefined,
    userRating: r.user_rating ?? undefined,
    ...(r.artist_id != null ? { artistId: r.artist_id } : {}),
    ...(r.album != null ? { album: r.album } : {}),
    ...(r.track != null ? { track: r.track } : {}),
    ...(r.disc_number != null ? { discNumber: r.disc_number } : {}),
    ...(r.year != null ? { year: r.year } : {}),
    ...(r.suffix != null ? { suffix: r.suffix } : {}),
    ...(r.content_type != null ? { contentType: r.content_type } : {}),
    isDir: false,
  };
}

export interface DownloadedArtistAlbum extends AlbumID3 {
  downloadedSongCount: number;
}

export interface DownloadedArtistProjection {
  artist: ArtistID3;
  songs: Child[];
  albums: DownloadedArtistAlbum[];
  biography: string | null;
  songCount: number;
  albumCount: number;
}

interface DownloadedArtistSongRow extends DownloadedSongRow {
  src_suffix: string | null;
}

/** The locally playable primary-artist view used by every offline artist entry point. */
export async function getDownloadedArtistProjection(
  db: InternalDb,
  artistId: string,
): Promise<DownloadedArtistProjection | null> {
  const artistRow = await db.getFirstAsync<ArtistListRow>(
    `SELECT ${ARTIST_LIST_COLS} FROM artists WHERE id = ?`,
    [artistId],
  );
  if (!artistRow) return null;

  const songRows = await db.getAllAsync<DownloadedArtistSongRow>(
    `SELECT song_id AS id, title, artist, sort_name, sort_title, sort_artist,
            COALESCE(src_album_id, album_id) AS album_id, duration, cover_art, user_rating,
            artist_id, album, track, disc_number, year, suffix, src_suffix, content_type
       FROM cached_songs
      WHERE artist_id = ?
      ORDER BY year, disc_number, track, sort_title, song_id`,
    [artistId],
  );
  if (songRows.length === 0) return null;

  await hydrateArtistRows(db, [artistRow]);
  const albumCounts = new Map<string, number>();
  for (const song of songRows) {
    if (song.album_id) albumCounts.set(song.album_id, (albumCounts.get(song.album_id) ?? 0) + 1);
  }
  const albumRows = albumCounts.size === 0
    ? []
    : await db.getAllAsync<AlbumListRow>(
        `SELECT ${CACHED_ALBUM_COLS} FROM cached_albums ca
          JOIN cached_items ci ON ci.item_id = ca.item_id
         WHERE ca.item_id IN (SELECT value FROM json_each(?))
         ORDER BY ca.year, ca.sort_title, ca.item_id`,
        [JSON.stringify([...albumCounts.keys()])],
      );
  const bio = await db.getFirstAsync<{ biography: string | null }>(
    'SELECT biography FROM artist_bio WHERE artist_id = ?',
    [artistId],
  );
  const albums = albumRows.map((row) => ({
    ...albumListRowToAlbumID3(row),
    downloadedSongCount: albumCounts.get(row.id) ?? 0,
  }));
  return {
    artist: artistListRowToArtistID3(artistRow),
    songs: songRows.map((row) => downloadedSongRowToChild({
      ...row,
      suffix: row.src_suffix ?? row.suffix,
    })),
    albums,
    biography: bio?.biography ?? null,
    songCount: songRows.length,
    albumCount: albums.length,
  };
}

/** All locally navigable artists, with counts from downloaded songs rather than the server. */
export async function listDownloadedArtists(
  db: InternalDb,
): Promise<DownloadedArtistProjection[]> {
  const rows = await db.getAllAsync<{ artist_id: string }>(
    `SELECT DISTINCT artist_id FROM cached_songs
      WHERE artist_id IS NOT NULL AND artist_id <> ''`,
  );
  const projections = await Promise.all(
    rows.map((row) => getDownloadedArtistProjection(db, row.artist_id)),
  );
  return projections
    .filter((row): row is DownloadedArtistProjection => row !== null)
    .sort((a, b) => (a.artist.name < b.artist.name ? -1 : a.artist.name > b.artist.name ? 1 : 0));
}

/** Artist cover-art IDs required by downloaded primary-artist projections. */
export async function listDownloadedArtistCoverArtIds(db: InternalDb): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ cover_art: string }>(
    `SELECT DISTINCT a.cover_art
       FROM cached_songs cs
       JOIN artists a ON a.id = cs.artist_id
      WHERE cs.artist_id IS NOT NULL AND cs.artist_id <> ''
        AND a.cover_art IS NOT NULL AND a.cover_art <> ''`,
  );
  return new Set(rows.map((row) => row.cover_art));
}

/**
 * The set of downloaded PLAYLIST ids — the MEMBERSHIP predicate's playlist twin, for
 * filtering a list that came from elsewhere (the CarPlay playlist node, whose rows come
 * from the `playlists` table and already carry their metadata). `cached_items` ALONE, with
 * no join to `cached_playlists`: requiring a component row here would hide a downloaded
 * playlist whose metadata is not populated, which is the visibility question, not this one.
 *
 * No partial gate, for the same reason `listDownloadedPlaylists` has none — playlists
 * download atomically, so there is no partial state to include or exclude.
 */
export async function listDownloadedPlaylistIds(db: InternalDb): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ item_id: string }>(
    "SELECT ci.item_id FROM cached_items ci WHERE ci.type='playlist'",
  );
  return new Set(rows.map((r) => r.item_id));
}

/**
 * "Is this exact item id downloaded" — MEMBERSHIP for a single id, as a one-row probe
 * rather than a set read.
 *
 * Type-agnostic on purpose: its caller asks about the `__starred__` favourites aggregate,
 * which is neither an album nor a playlist. No partial gate either — this is bare
 * membership.
 */
export async function isItemDownloaded(db: InternalDb, itemId: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ one: number }>(
    'SELECT 1 AS one FROM cached_items WHERE item_id = ? LIMIT 1',
    [itemId],
  );
  return row !== null;
}
