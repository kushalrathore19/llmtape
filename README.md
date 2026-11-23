# llm-tape

> Zero-dependency record/replay for LLM API calls. Make your AI app tests deterministic, free, and fast.

Think **VCR / Polly.js, but purpose-built for LLM APIs — including streaming.**

## The problem

```
❌ Without llm-tape:
  - Tests hit real LLM APIs → slow (2-30s per call)
  - Non-deterministic outputs → flaky assertions
  - Burns tokens/money on every CI run
  - Needs API keys in CI environment
```

```
✅ With llm-tape:
  - Record once, replay instantly → <1ms per call
  - Deterministic responses → stable tests
  - Zero API cost after first recording
  - No secrets needed in CI (LLMTAPE_MODE=replay)
```

## Install

```bash
npm install llm-tape
```

## Quick Start

### Basic usage with `withTape`

```typescript
import { withTape } from 'llm-tape';

// First run: records the real API call to __tapes__/greeting.json
// Subsequent runs: replays from tape — no network, instant, deterministic
await withTape('greeting', async () => {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Say hello' }],
    }),
  });
  const data = await response.json();
  console.log(data.choices[0].message.content);
});
```

### With the OpenAI SDK

The OpenAI SDK uses `fetch` internally — llm-tape intercepts it automatically:

```typescript
import { withTape } from 'llm-tape';
import OpenAI from 'openai';

const openai = new OpenAI();

await withTape('openai-test', async () => {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Write a haiku about testing' }],
  });
  console.log(completion.choices[0].message.content);
});
```

Or pass `tapeFetch` directly to the SDK:

```typescript
import { tapeFetch, startTape } from 'llm-tape';
import OpenAI from 'openai';

const session = startTape('my-test');
const openai = new OpenAI({ fetch: tapeFetch });

// ... use openai as normal ...

await session.stop(); // saves the tape
```

### With the Anthropic SDK

```typescript
import { withTape } from 'llm-tape';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

await withTape('anthropic-test', async () => {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello, Claude' }],
  });
  console.log(message.content);
});
```

### Vitest integration

```typescript
import { describe, it, expect } from 'vitest';
import { useTape } from 'llm-tape/vitest';

describe('My AI Feature', () => {
  useTape(); // auto-names tapes from test names, handles setup/teardown

  it('generates a summary', async () => {
    const result = await myAIFunction();
    expect(result).toMatchSnapshot();
  });
});
```

### Jest integration

```typescript
import { useTape } from 'llm-tape/jest';

describe('My AI Feature', () => {
  useTape();

  it('generates a summary', async () => {
    const result = await myAIFunction();
    expect(result).toMatchSnapshot();
  });
});
```

## Streaming

llm-tape records SSE (`text/event-stream`) responses chunk-by-chunk and replays them as a real `ReadableStream` with the same chunk boundaries:

```typescript
await withTape('streaming-test', async () => {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Count to 5' }],
      stream: true,
    }),
  });

  const reader = response.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stdout.write(new TextDecoder().decode(value));
  }
});
```

Use `replaySpeed: 'realtime'` to preserve original timing between chunks (useful for UI testing):

```typescript
await withTape('streaming-ui', fn, { replaySpeed: 'realtime' });
```

## Modes

| Mode | Behavior |
|------|----------|
| `auto` (default) | Replay if tape entry exists, otherwise record |
| `record` | Always hit real API, overwrite tape |
| `replay` | Never hit network; throw if no match |
| `off` | Passthrough, no recording |

Set via options or environment variable:

```bash
# In CI — guaranteed no network calls
LLMTAPE_MODE=replay npm test

# Re-record all tapes
LLMTAPE_MODE=record npm test
```

## Request Matching

Requests are matched by method + URL + normalized JSON body. By default, volatile fields like `user`, `metadata`, and `request_id` are ignored.

**Loose matching** additionally ignores sampling parameters (`temperature`, `max_tokens`, `top_p`, etc.):

```typescript
await withTape('test', fn, { match: 'loose' });
```

**Custom ignore keys:**

```typescript
await withTape('test', fn, {
  ignoreBodyKeys: ['user', 'metadata', 'session_id', 'trace_id'],
});
```

When the same request is made N times, responses replay in the order they were originally recorded.

## Secret Redaction

llm-tape **never writes secrets to disk**. These are redacted automatically:

- **Headers**: `Authorization`, `x-api-key`, `api-key`, `x-goog-api-key`
- **Patterns**: `sk-...`, `sk-ant-...`, `AIza...`, `Bearer ...`

Add custom redaction:

```typescript
await withTape('test', fn, {
  redactPatterns: [/my-custom-secret-\w+/g],
  customRedactor: (content) => content.replace(/internal-token-\w+/g, '[REDACTED]'),
});
```

## Host Filtering

Only known LLM hosts are intercepted by default:
- `api.openai.com`
- `api.anthropic.com`
- `generativelanguage.googleapis.com`
- `openrouter.ai`

Everything else passes through untouched. Add custom hosts:

```typescript
await withTape('test', fn, {
  hosts: ['my-llm-proxy.internal.com', /.*\.azure\.com/],
});
```

## CLI

```bash
# List all recorded tapes
npx llm-tape ls

# Show token and cost savings
npx llm-tape stats

# Remove tapes unused for 30+ days
npx llm-tape prune --days 30

# CI/pre-commit: fail if any tape contains leaked secrets
npx llm-tape redact-check
```

## Replay Miss Errors

When in `replay` mode and no matching entry is found, llm-tape prints a detailed diagnostic:

```
[llmtape] Replay miss: No matching recorded entry found in tape "my-test".

Incoming request:
  Method: POST
  URL:    https://api.openai.com/v1/chat/completions

Closest recorded entry (#0):
  Body diff:
    field "model":
      - recorded: "gpt-4-turbo"
      + incoming: "gpt-4o"

Tip: To record this call, run with LLMTAPE_MODE=record or LLMTAPE_MODE=auto.
```

## CI Setup

```yaml
# .github/workflows/test.yml
- name: Run tests (replay only, no API keys needed)
  run: npm test
  env:
    LLMTAPE_MODE: replay
```

## API Reference

### `withTape(name, fn, options?)`
Execute `fn` within a tape session. Records or replays based on mode.

### `startTape(name, options?)` / `stopTape()`
Imperative session management for more control.

### `tapeFetch`
Drop-in `fetch` replacement. Pass to SDKs that accept a custom `fetch` option.

### `useTape(options?)` (from `llm-tape/vitest` or `llm-tape/jest`)
Test framework hook — auto-names tapes from test names, manages lifecycle.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `'auto'\|'record'\|'replay'\|'off'` | `'auto'` | Operation mode |
| `tapesDir` | `string` | `'__tapes__'` | Directory for tape files |
| `hosts` | `(string\|RegExp)[]` | LLM defaults | Hosts to intercept |
| `ignoreBodyKeys` | `string[]` | `['user','metadata','request_id']` | Body keys to ignore in matching |
| `match` | `'exact'\|'loose'` | `'exact'` | Matching strategy |
| `replaySpeed` | `'instant'\|'realtime'` | `'instant'` | Streaming replay speed |
| `redactHeaders` | `string[]` | auth headers | Headers to redact |
| `redactPatterns` | `RegExp[]` | key patterns | Patterns to redact |

## Comparison

| Feature | llm-tape | msw | nock | Polly.js |
|---------|----------|-----|------|----------|
| Zero dependencies | ✅ | ❌ | ❌ | ❌ |
| LLM-aware matching | ✅ | ❌ | ❌ | ❌ |
| Streaming record/replay | ✅ | ❌ | ❌ | Partial |
| Auto secret redaction | ✅ | ❌ | ❌ | ❌ |
| Loose matching (ignore temperature, etc.) | ✅ | ❌ | ❌ | ❌ |
| Replay miss diagnostics | ✅ | ❌ | ❌ | ❌ |
| Node 18+ fetch interception | ✅ | ✅ | ✅ | ✅ |
| Framework adapters (Vitest/Jest) | ✅ | ✅ | ❌ | ✅ |
| Human-readable tape files | ✅ | N/A | ❌ | ✅ |

## Requirements

- Node.js >= 18
- Zero runtime dependencies

## License

MIT
