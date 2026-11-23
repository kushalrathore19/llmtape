import {
  handleTapeFetch,
  patchGlobalFetch,
  runWithTapeContext,
  setActiveTapeContext,
  tapeFetch,
  unpatchGlobalFetch,
} from './interceptor.js';
import { Tape } from './tape.js';
import type { TapeOptions } from './types.js';

export interface TapeSession {
  tape: Tape;
  stop: () => Promise<void>;
}

let activeManualSession: TapeSession | null = null;

/**
 * Execute an async function within a recorded/replayed tape session.
 *
 * @param name Name of the tape (saved to __tapes__/<name>.json)
 * @param fn Async function containing LLM calls
 * @param options Tape configuration options
 */
export async function withTape<T>(
  name: string,
  fn: () => Promise<T>,
  options?: TapeOptions
): Promise<T> {
  const tape = new Tape(name, options);
  patchGlobalFetch();

  try {
    return await runWithTapeContext({ tape, options: options || {} }, fn);
  } finally {
    await tape.save();
  }
}

/**
 * Imperatively start a tape session.
 */
export function startTape(name: string, options?: TapeOptions): TapeSession {
  if (activeManualSession) {
    throw new Error(`[llmtape] A tape session ("${activeManualSession.tape.tapeName}") is already active. Call session.stop() or stopTape() before starting a new one.`);
  }

  const tape = new Tape(name, options);
  patchGlobalFetch();
  setActiveTapeContext({ tape, options: options || {} });

  const session: TapeSession = {
    tape,
    stop: async () => {
      try {
        await tape.save();
      } finally {
        setActiveTapeContext(null);
        activeManualSession = null;
      }
    },
  };

  activeManualSession = session;
  return session;
}

/**
 * Imperatively stop the currently active tape session.
 */
export async function stopTape(): Promise<void> {
  if (activeManualSession) {
    await activeManualSession.stop();
  }
}

export { tapeFetch, patchGlobalFetch, unpatchGlobalFetch };
export { Tape } from './tape.js';
export { Redactor, scanForSecrets } from './redactor.js';
export { findClosestEntryDiff, requestsMatch } from './matcher.js';
export * from './types.js';
export * from './constants.js';
