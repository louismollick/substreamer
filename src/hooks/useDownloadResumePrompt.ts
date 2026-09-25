import { useEffect } from 'react';

import { shouldOfferResume } from '../services/backgroundDownloadService';
import { downloadResumePromptStore } from '../store/downloadResumePromptStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { onAppForeground } from '../utils/onAppForeground';

function offerIfNeeded(): void {
  if (!musicCacheStore.getState().hasHydrated) return;
  if (shouldOfferResume()) downloadResumePromptStore.getState().show();
}

/**
 * Show the "Resume downloads?" prompt on launch and whenever the app returns
 * to the foreground with downloads pending and no background task running.
 */
export function useDownloadResumePrompt(): void {
  useEffect(() => {
    offerIfNeeded();
    const unsubscribeHydration = musicCacheStore.subscribe((state, prev) => {
      if (state.hasHydrated && !prev.hasHydrated) offerIfNeeded();
    });
    const foreground = onAppForeground(offerIfNeeded);
    return () => {
      unsubscribeHydration();
      foreground.remove();
    };
  }, []);
}
