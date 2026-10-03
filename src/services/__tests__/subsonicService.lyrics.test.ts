const mockGetLyricsBySongId = jest.fn();
const mockGetLyrics = jest.fn();

jest.mock('subsonic-api', () => ({
  __esModule: true,
  default: class MockSubsonicAPI {
    getLyricsBySongId = mockGetLyricsBySongId;
    getLyrics = mockGetLyrics;
  },
}));
jest.mock('expo-crypto', () => ({
  getRandomValues: jest.fn((arr: Uint8Array) => arr),
  getRandomBytesAsync: jest.fn().mockResolvedValue(new Uint8Array(16)),
  digestStringAsync: jest.fn().mockResolvedValue('mocktoken'),
  CryptoDigestAlgorithm: { MD5: 'MD5' },
  CryptoEncoding: { HEX: 'hex' },
}));
jest.mock('../../store/authStore', () => ({
  authStore: { getState: jest.fn() },
}));
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: jest.fn(() => ({ offlineMode: false })) },
}));
jest.mock('../../store/playbackSettingsStore', () => ({
  playbackSettingsStore: { getState: jest.fn() },
  FORMAT_PRESETS: [],
}));
jest.mock('../serverCapabilityService', () => ({
  supports: jest.fn(),
}));

import i18n from '../../i18n/i18n';
import { authStore } from '../../store/authStore';
import { supports } from '../serverCapabilityService';
import { clearApiCache, getLyricsForTrack } from '../subsonicService';

const mockAuthStore = authStore as jest.Mocked<typeof authStore>;
const mockSupports = supports as jest.MockedFunction<typeof supports>;

beforeEach(() => {
  clearApiCache();
  mockGetLyricsBySongId.mockReset();
  mockGetLyrics.mockReset();
  mockSupports.mockReset();
  mockAuthStore.getState.mockReturnValue({
    isLoggedIn: true,
    serverUrl: 'https://music.example.com',
    username: 'user',
    password: 'pass',
    legacyAuth: false,
  } as any);
  // Default device locale to English for deterministic language-matching.
  i18n.changeLanguage('en');
});

describe('lyric cancellation', () => {
  it('passes the signal and skips classic fallback when structured lookup is aborted', async () => {
    mockSupports.mockReturnValue(true);
    const controller = new AbortController();
    mockGetLyricsBySongId.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    expect(await getLyricsForTrack('cancelled', 'A', 'T', controller.signal)).toBeNull();
    expect(mockGetLyricsBySongId).toHaveBeenCalledWith({ id: 'cancelled' }, controller.signal);
    expect(mockGetLyrics).not.toHaveBeenCalled();
  });

  it('skips requests when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await getLyricsForTrack('cancelled', 'A', 'T', controller.signal)).toBeNull();
    expect(mockGetLyricsBySongId).not.toHaveBeenCalled();
    expect(mockGetLyrics).not.toHaveBeenCalled();
  });
});

describe('getLyricsForTrack — structured (OpenSubsonic)', () => {
  beforeEach(() => {
    mockSupports.mockImplementation((cap) => cap === 'structuredLyrics');
  });

  it('returns synced lines from spec-compliant array shape', async () => {
    mockGetLyricsBySongId.mockResolvedValue({
      lyricsList: {
        structuredLyrics: [
          {
            lang: 'en',
            synced: true,
            offset: 250,
            line: [
              { start: 2000, value: 'second line' },
              { start: 0, value: 'first line' },
            ],
          },
        ],
      },
    });

    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data).toEqual({
      synced: true,
      lang: 'en',
      offsetMs: 250,
      source: 'structured',
      lines: [
        { startMs: 0, text: 'first line' },
        { startMs: 2000, text: 'second line' },
      ],
    });
  });

  it('forces startMs to 0 on unsynced lines even if server includes start', async () => {
    mockGetLyricsBySongId.mockResolvedValue({
      lyricsList: {
        structuredLyrics: [
          {
            lang: 'en',
            synced: false,
            line: [
              { start: 999, value: 'line a' },
              { value: 'line b' },
            ],
          },
        ],
      },
    });

    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data).not.toBeNull();
    expect(data!.synced).toBe(false);
    expect(data!.lines).toEqual([
      { startMs: 0, text: 'line a' },
      { startMs: 0, text: 'line b' },
    ]);
  });

  it('normalises Ampache single-object deviation to array', async () => {
    mockGetLyricsBySongId.mockResolvedValue({
      lyricsList: {
        structuredLyrics: {
          lang: 'xxx',
          synced: false,
          line: [{ value: 'one' }, { value: 'two' }],
        },
      },
    });

    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data).not.toBeNull();
    expect(data!.synced).toBe(false);
    expect(data!.lang).toBeUndefined();
    expect(data!.lines).toHaveLength(2);
    expect(data!.source).toBe('structured');
  });

  it('falls through to classic when Ampache returns lyricsList: {}', async () => {
    mockGetLyricsBySongId.mockResolvedValue({ lyricsList: {} });
    mockGetLyrics.mockResolvedValue({
      lyrics: { value: 'one\ntwo' },
    });

    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data).not.toBeNull();
    expect(data!.source).toBe('classic');
    expect(data!.lines).toEqual([
      { startMs: 0, text: 'one' },
      { startMs: 0, text: 'two' },
    ]);
  });

  it('falls through to classic when Navidrome omits lyricsList entirely', async () => {
    mockGetLyricsBySongId.mockResolvedValue({});
    mockGetLyrics.mockResolvedValue({
      lyrics: { value: 'x' },
    });

    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data?.source).toBe('classic');
    expect(data?.lines).toEqual([{ startMs: 0, text: 'x' }]);
  });

  it('picks entry matching device locale over first entry', async () => {
    i18n.changeLanguage('fr');
    mockGetLyricsBySongId.mockResolvedValue({
      lyricsList: {
        structuredLyrics: [
          {
            lang: 'en',
            synced: false,
            line: [{ value: 'english' }],
          },
          {
            lang: 'fr',
            synced: false,
            line: [{ value: 'french' }],
          },
        ],
      },
    });

    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data?.lines[0].text).toBe('french');
    expect(data?.lang).toBe('fr');
  });

  it('treats xxx/und lang as unspecified for matching and output', async () => {
    i18n.changeLanguage('xx');
    mockGetLyricsBySongId.mockResolvedValue({
      lyricsList: {
        structuredLyrics: [
          {
            lang: 'xxx',
            synced: false,
            line: [{ value: 'one' }],
          },
          {
            lang: 'und',
            synced: false,
            line: [{ value: 'two' }],
          },
        ],
      },
    });

    const data = await getLyricsForTrack('t1', 'A', 'B');
    // Neither xxx nor und matches anything; falls to [0].
    expect(data?.lines[0].text).toBe('one');
    expect(data?.lang).toBeUndefined();
  });

  it('defaults offsetMs to 0 when offset absent', async () => {
    mockGetLyricsBySongId.mockResolvedValue({
      lyricsList: {
        structuredLyrics: [
          { lang: 'en', synced: true, line: [{ start: 0, value: 'a' }] },
        ],
      },
    });

    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data?.offsetMs).toBe(0);
  });

  it('returns null when structured entries have empty line array and no classic match', async () => {
    mockGetLyricsBySongId.mockResolvedValue({
      lyricsList: {
        structuredLyrics: [{ lang: 'en', synced: false, line: [] }],
      },
    });
    mockGetLyrics.mockResolvedValue({ lyrics: {} });

    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data).toBeNull();
  });

  it('falls through to classic when getLyricsBySongId throws', async () => {
    mockGetLyricsBySongId.mockRejectedValue(new Error('boom'));
    mockGetLyrics.mockResolvedValue({ lyrics: { value: 'x' } });

    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data?.source).toBe('classic');
  });
});

describe('getLyricsForTrack — classic fallback only', () => {
  beforeEach(() => {
    mockSupports.mockReturnValue(false);
  });

  it('splits multi-line value on \\n, trims trailing whitespace, drops edge empties', async () => {
    mockGetLyrics.mockResolvedValue({
      lyrics: { value: '\n\nfirst  \nsecond\n\nthird\n\n' },
    });

    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data).not.toBeNull();
    expect(data!.source).toBe('classic');
    expect(data!.synced).toBe(false);
    expect(data!.lines.map((l) => l.text)).toEqual([
      'first',
      'second',
      '',
      'third',
    ]);
    expect(mockGetLyricsBySongId).not.toHaveBeenCalled();
  });

  it('returns null when classic returns lyrics: {}', async () => {
    mockGetLyrics.mockResolvedValue({ lyrics: {} });
    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data).toBeNull();
  });

  it('returns null when classic value is whitespace-only', async () => {
    mockGetLyrics.mockResolvedValue({ lyrics: { value: '   \n \n  ' } });
    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data).toBeNull();
  });

  it('skips classic call when artist or title is missing', async () => {
    const data = await getLyricsForTrack('t1');
    expect(mockGetLyrics).not.toHaveBeenCalled();
    expect(data).toBeNull();
  });

  it('returns null when classic throws', async () => {
    mockGetLyrics.mockRejectedValue(new Error('nope'));
    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data).toBeNull();
  });
});

describe('getLyricsForTrack — not logged in / offline', () => {
  it('returns null when no API is available', async () => {
    mockAuthStore.getState.mockReturnValue({
      isLoggedIn: false,
    } as any);
    mockSupports.mockReturnValue(true);

    const data = await getLyricsForTrack('t1', 'A', 'B');
    expect(data).toBeNull();
    expect(mockGetLyricsBySongId).not.toHaveBeenCalled();
    expect(mockGetLyrics).not.toHaveBeenCalled();
  });
});
