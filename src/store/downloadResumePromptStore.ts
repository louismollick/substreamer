import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { kvStorage } from './persistence';

interface DownloadResumePromptState {
  /** Persisted: "Not now" was chosen; cleared when a background task begins. */
  dismissed: boolean;
  /** Transient: the prompt is on screen. */
  visible: boolean;
  show: () => void;
  /** Hide the prompt; `notNow` suppresses it until the next task begins. */
  hide: (notNow: boolean) => void;
  clearDismissed: () => void;
}

export const downloadResumePromptStore = create<DownloadResumePromptState>()(
  persist(
    (set) => ({
      dismissed: false,
      visible: false,
      show: () => set({ visible: true }),
      hide: (notNow) => set((s) => ({ visible: false, dismissed: notNow ? true : s.dismissed })),
      clearDismissed: () => set({ dismissed: false }),
    }),
    {
      name: 'substreamer-download-resume-prompt',
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({ dismissed: state.dismissed }),
    },
  ),
);
