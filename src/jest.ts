import { startTape, type TapeSession, withTape } from './index.js';
import { sanitizeTapeName } from './tape.js';
import type { TapeOptions } from './types.js';

export interface UseTapeOptions extends TapeOptions {
  nameGenerator?: (testName: string) => string;
}

/**
 * Jest hook that automatically records/replays LLM calls for each test in a suite.
 * Automatically hooks into beforeEach/afterEach and derives tape names from the test name.
 *
 * Example:
 * ```ts
 * import { useTape } from 'llmtape/jest';
 *
 * describe('OpenAI Agent', () => {
 *   useTape();
 *
 *   it('generates a greeting', async () => {
 *     const res = await callAgent();
 *     expect(res).toBe('Hello!');
 *   });
 * });
 * ```
 */
export function useTape(options: UseTapeOptions = {}): void {
  const g = globalThis as any;
  const beforeEachFn = g.beforeEach;
  const afterEachFn = g.afterEach;

  if (typeof beforeEachFn !== 'function' || typeof afterEachFn !== 'function') {
    throw new Error(
      '[llmtape/jest] useTape() must be called inside a Jest test file where beforeEach and afterEach are defined.'
    );
  }

  let session: TapeSession | null = null;

  beforeEachFn(async () => {
    const testName: string = g.expect?.getState?.()?.currentTestName || 'test';
    const tapeName = options.nameGenerator
      ? options.nameGenerator(testName)
      : sanitizeTapeName(testName);

    session = startTape(tapeName, options);
  });

  afterEachFn(async () => {
    if (session) {
      await session.stop();
      session = null;
    }
  });
}

export { withTape };
