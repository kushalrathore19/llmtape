import { startTape, type TapeSession, withTape } from './index.js';
import { sanitizeTapeName } from './tape.js';
import type { TapeOptions } from './types.js';

export interface UseTapeOptions extends TapeOptions {
  /**
   * Optional custom tape name generator.
   */
  nameGenerator?: (testName: string) => string;
}

/**
 * Vitest hook that automatically records/replays LLM calls for each test in a suite.
 * Automatically hooks into beforeEach/afterEach and derives tape names from the test name.
 *
 * Example:
 * ```ts
 * import { describe, it } from 'vitest';
 * import { useTape } from 'llmtape/vitest';
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
      '[llmtape/vitest] useTape() must be called inside a Vitest test file where beforeEach and afterEach are defined.'
    );
  }

  let session: TapeSession | null = null;

  beforeEachFn(async (context: any) => {
    let testName: string =
      context?.task?.name ||
      context?.meta?.name ||
      g.expect?.getState?.()?.currentTestName ||
      'test';

    if (context?.task?.suite?.name) {
      testName = `${context.task.suite.name}__${testName}`;
    }

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
