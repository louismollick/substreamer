import ExpoContinuedProcessingModule from './ExpoContinuedProcessingModule';

import { type EventSubscription } from 'expo-modules-core';

export { type ExpiredEvent } from './ExpoContinuedProcessingModule';

/** True on iOS 26+, where a user-started task can keep running in the background. */
export function isContinuedProcessingSupported(): boolean {
  return ExpoContinuedProcessingModule.isSupported();
}

/** True while a task is submitted or running. */
export function isContinuedProcessingActive(): boolean {
  return ExpoContinuedProcessingModule.isActive();
}

/**
 * Start the task, or raise the running task's total. Call only from the
 * foreground in direct response to a user action. Resolves false when
 * unsupported or refused by the system.
 */
export function beginContinuedProcessing(
  title: string,
  subtitle: string,
  total: number,
): Promise<boolean> {
  return ExpoContinuedProcessingModule.begin(title, subtitle, total);
}

/** Report progress; the system may terminate a task that reports none. */
export function setContinuedProcessingProgress(
  completed: number,
  total: number,
  subtitle?: string,
): void {
  ExpoContinuedProcessingModule.setProgress(completed, total, subtitle ?? null);
}

/** Complete the running task, if any. */
export function endContinuedProcessing(success: boolean): void {
  ExpoContinuedProcessingModule.end(success);
}

/**
 * Fires after the system expired the task or the person cancelled it. Native
 * has already cancelled in-flight expo-async-fs transfers and completed the task.
 */
export function addContinuedProcessingExpiredListener(
  listener: (event: { reason: string }) => void,
): EventSubscription {
  return ExpoContinuedProcessingModule.addListener('onExpired', listener);
}

/** True in builds prebuilt with `SUBSTREAMER_DOWNLOAD_DIAGNOSTICS=1`. */
export function isDownloadDiagnosticsEnabled(): boolean {
  return ExpoContinuedProcessingModule.isDiagnosticsEnabled();
}

/** Append one JSON line to the on-device download diagnostics log. */
export function logDownloadDiagnostic(line: Record<string, unknown>): void {
  ExpoContinuedProcessingModule.logDiagnostic(line);
}
