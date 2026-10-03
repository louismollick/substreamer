import { type EventSubscription, requireNativeModule } from 'expo-modules-core';

export interface ExpiredEvent {
  reason: string;
}

interface ExpoContinuedProcessingNativeModule {
  isSupported(): boolean;
  isActive(): boolean;
  begin(title: string, subtitle: string, total: number): Promise<boolean>;
  setProgress(completed: number, total: number, subtitle: string | null): void;
  end(success: boolean): void;
  isDiagnosticsEnabled(): boolean;
  logDiagnostic(line: Record<string, unknown>): void;
  addListener(eventName: 'onExpired', listener: (event: ExpiredEvent) => void): EventSubscription;
}

let module: ExpoContinuedProcessingNativeModule;

try {
  module = requireNativeModule('ExpoContinuedProcessing');
} catch {
  // Android and builds without the module: every call is a no-op, so the
  // download queue simply runs in the foreground.
  module = {
    isSupported: () => false,
    isActive: () => false,
    begin: () => Promise.resolve(false),
    setProgress: () => {},
    end: () => {},
    isDiagnosticsEnabled: () => false,
    logDiagnostic: () => {},
    addListener: () => ({ remove: () => {} }),
  } as unknown as ExpoContinuedProcessingNativeModule;
}

export default module;
