import { describe, it, expect } from 'vitest';
import { useTape } from 'llm-tape/vitest';
import { askAssistant } from './agent.js';

describe('AI Assistant with llmtape', () => {
  // Automatically records to __tapes__/AI-Assistant-with-llmtape__<test-name>.json
  useTape();

  it('answers simple queries deterministically', async () => {
    const result = await askAssistant('What is the capital of France?');
    expect(result.answer).toBeDefined();
  });
});
