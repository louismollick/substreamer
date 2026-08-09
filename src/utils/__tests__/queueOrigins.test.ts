import { isAutoplaySectionStart } from '../queueOrigins';

describe('isAutoplaySectionStart', () => {
  it('starts at the first upcoming autoplay track', () => {
    const origins = ['manual', 'autoplay', 'autoplay'] as const;

    expect(isAutoplaySectionStart([...origins], 0, 1)).toBe(true);
    expect(isAutoplaySectionStart([...origins], 0, 2)).toBe(false);
  });

  it('moves past an autoplay track once it becomes current', () => {
    const origins = ['manual', 'autoplay', 'autoplay'] as const;

    expect(isAutoplaySectionStart([...origins], 1, 1)).toBe(false);
    expect(isAutoplaySectionStart([...origins], 1, 2)).toBe(true);
  });

  it('starts a new section after a future manual track', () => {
    expect(isAutoplaySectionStart(['manual', 'manual', 'autoplay'], null, 2)).toBe(true);
    expect(isAutoplaySectionStart(['manual'], null, 0)).toBe(false);
  });
});
