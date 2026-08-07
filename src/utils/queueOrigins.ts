import type { QueueTrackOrigin } from '../store/playerStore';

export function isInfinitePlaySectionStart(
  origins: QueueTrackOrigin[],
  currentTrackIndex: number | null,
  index: number,
): boolean {
  const firstUpcomingIndex = (currentTrackIndex ?? -1) + 1;
  return (
    index >= firstUpcomingIndex &&
    origins[index] === 'autoplay' &&
    (index === firstUpcomingIndex || origins[index - 1] !== 'autoplay')
  );
}
