import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  withTape,
  tapeFetch,
  startTape,
  stopTape,
  scanForSecrets,
  unpatchGlobalFetch,
} from '../src/index.js';
import { cmdLs, cmdStats, cmdPrune, cmdRedactCheck } from '../src/cli.js';

const TEST_TAPES_DIR = '__test_tapes__';

describe('llmtape test suite', () => {
  let server: http.Server;
  let serverUrl: string;
  let requestCounter = 0;
  let lastServerRequestHeaders: http.IncomingHttpHeaders = {};
  let lastServerRequestBody: any = null;

  beforeEach(async () => {
    requestCounter = 0;
    lastServerRequestHeaders = {};
    lastServerRequestBody = null;

    // Clean test tapes directory
    const dir = path.resolve(process.cwd(), TEST_TAPES_DIR);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // Create local mock LLM server
    server = http.createServer(async (req, res) => {
      requestCounter++;
      lastServerRequestHeaders = req.headers;

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      try {
        lastServerRequestBody = JSON.parse(rawBody);
      } catch {
        lastServerRequestBody = rawBody;
      }

      if (req.url?.includes('/stream')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
        await new Promise((r) => setTimeout(r, 20));
        res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
        await new Promise((r) => setTimeout(r, 20));
        res.write('data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (req.url?.includes('/repeat')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            callNumber: requestCounter,
            message: `Response number ${requestCounter}`,
          })
        );
        return;
      }

      // Default mock completion
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          model: 'mock-llm',
          choices: [
            {
              message: {
                role: 'assistant',
                content: `Echo response ${requestCounter}`,
              },
            },
          ],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 25,
            total_tokens: 40,
          },
        })
      );
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        serverUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    unpatchGlobalFetch();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Clean test tapes directory
    const dir = path.resolve(process.cwd(), TEST_TAPES_DIR);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records real call on first run and replays deterministically without network on second run', async () => {
    const tapeOptions = {
      tapesDir: TEST_TAPES_DIR,
      hosts: ['127.0.0.1'],
    };

    // 1. Record call
    const result1 = await withTape('basic-record-replay', async () => {
      const resp = await fetch(`${serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
      });
      return resp.json();
    }, tapeOptions);

    expect(requestCounter).toBe(1);
    expect(result1.choices[0].message.content).toBe('Echo response 1');

    // Verify tape file exists
    const tapeFile = path.resolve(process.cwd(), TEST_TAPES_DIR, 'basic-record-replay.json');
    expect(fs.existsSync(tapeFile)).toBe(true);

    // 2. Replay call in 'replay' mode
    const result2 = await withTape('basic-record-replay', async () => {
      const resp = await fetch(`${serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
      });
      return resp.json();
    }, { ...tapeOptions, mode: 'replay' });

    // Server should not have been hit
    expect(requestCounter).toBe(1);
    expect(result2.choices[0].message.content).toBe('Echo response 1');
  });

  it('replays repeated identical calls in recorded order', async () => {
    const tapeOptions = {
      tapesDir: TEST_TAPES_DIR,
      hosts: ['127.0.0.1'],
    };

    // Record 3 identical calls
    await withTape('repeated-calls', async () => {
      for (let i = 0; i < 3; i++) {
        const resp = await fetch(`${serverUrl}/repeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ping: 'pong' }),
        });
        const data = await resp.json();
        expect(data.callNumber).toBe(i + 1);
      }
    }, tapeOptions);

    expect(requestCounter).toBe(3);

    // Replay in 'replay' mode
    await withTape('repeated-calls', async () => {
      for (let i = 0; i < 3; i++) {
        const resp = await fetch(`${serverUrl}/repeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ping: 'pong' }),
        });
        const data = await resp.json();
        expect(data.callNumber).toBe(i + 1);
        expect(data.message).toBe(`Response number ${i + 1}`);
      }
    }, { ...tapeOptions, mode: 'replay' });

    // No extra network hits
    expect(requestCounter).toBe(3);
  });

  it('records and replays streaming responses with chunk fidelity', async () => {
    const tapeOptions = {
      tapesDir: TEST_TAPES_DIR,
      hosts: ['127.0.0.1'],
    };

    async function streamAndCollect(): Promise<string[]> {
      const resp = await fetch(`${serverUrl}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stream: true }),
      });
      expect(resp.headers.get('content-type')).toContain('text/event-stream');

      const reader = resp.body!.getReader();
      const chunks: string[] = [];
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
      return chunks;
    }

    // 1. Record stream
    const recordedChunks = await withTape('stream-test', streamAndCollect, tapeOptions);
    expect(requestCounter).toBe(1);
    expect(recordedChunks.length).toBeGreaterThanOrEqual(2);
    expect(recordedChunks.join('')).toContain('Hello');
    expect(recordedChunks.join('')).toContain('world');

    // 2. Replay stream in 'replay' mode
    const replayedChunks = await withTape('stream-test', streamAndCollect, {
      ...tapeOptions,
      mode: 'replay',
      replaySpeed: 'instant',
    });

    // Zero additional server hits
    expect(requestCounter).toBe(1);
    expect(replayedChunks.join('')).toBe(recordedChunks.join(''));
  });

  it('redacts sensitive headers and API key patterns from disk recordings', async () => {
    const tapeOptions = {
      tapesDir: TEST_TAPES_DIR,
      hosts: ['127.0.0.1'],
    };

    const secretKey = 'sk-1234567890abcdef1234567890abcdef';
    const googleKey = 'AIzaSyA1234567890123456789012345678901';

    await withTape('redaction-test', async () => {
      await fetch(`${serverUrl}/v1/chat/completions?key=${googleKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secretKey}`,
          'x-api-key': 'ant-secret-123456',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: `Here is my key: ${secretKey}` }],
          api_key: secretKey,
        }),
      });
    }, tapeOptions);

    const tapePath = path.resolve(process.cwd(), TEST_TAPES_DIR, 'redaction-test.json');
    const tapeContent = fs.readFileSync(tapePath, 'utf-8');

    // Plain text keys must NOT exist in file
    expect(tapeContent.includes(secretKey)).toBe(false);
    expect(tapeContent.includes(googleKey)).toBe(false);
    expect(tapeContent.includes('ant-secret-123456')).toBe(false);

    // Redaction marker must be present
    expect(tapeContent.includes('[REDACTED]')).toBe(true);

    // scanForSecrets should find 0 leaked keys
    const findings = scanForSecrets(tapeContent);
    expect(findings.length).toBe(0);
  });

  it('supports loose matching to ignore volatile generation parameters', async () => {
    const tapeOptions = {
      tapesDir: TEST_TAPES_DIR,
      hosts: ['127.0.0.1'],
    };

    // Record with temperature 0.7 and max_tokens 200
    await withTape('loose-match-test', async () => {
      await fetch(`${serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Tell a joke' }],
          temperature: 0.7,
          max_tokens: 200,
        }),
      });
    }, tapeOptions);

    expect(requestCounter).toBe(1);

    // Replay with different temperature and max_tokens using match: 'loose'
    const result = await withTape('loose-match-test', async () => {
      const resp = await fetch(`${serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Tell a joke' }],
          temperature: 0.1,
          max_tokens: 800,
        }),
      });
      return resp.json();
    }, { ...tapeOptions, mode: 'replay', match: 'loose' });

    expect(requestCounter).toBe(1);
    expect(result.id).toBe('chatcmpl-test');
  });

  it('throws clear and helpful diff error when replay mode misses', async () => {
    const tapeOptions = {
      tapesDir: TEST_TAPES_DIR,
      hosts: ['127.0.0.1'],
    };

    // Record an initial request
    await withTape('replay-miss-test', async () => {
      await fetch(`${serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4-turbo',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });
    }, tapeOptions);

    // Attempt to replay with a changed model
    await expect(
      withTape('replay-miss-test', async () => {
        await fetch(`${serverUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello' }],
          }),
        });
      }, { ...tapeOptions, mode: 'replay' })
    ).rejects.toThrowError(/Replay miss: No matching recorded entry found/);
  });

  it('passes through non-intercepted hosts untouched', async () => {
    // hosts is not specifying 127.0.0.1, and 127.0.0.1 is not a default LLM host
    const tapeOptions = {
      tapesDir: TEST_TAPES_DIR,
      hosts: ['api.openai.com'], // only openai
    };

    await withTape('passthrough-test', async () => {
      const resp = await fetch(`${serverUrl}/repeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'passthrough' }),
      });
      const data = await resp.json();
      expect(data.callNumber).toBe(1);
    }, tapeOptions);

    // Tape file should NOT be created because request was not to an intercepted host
    const tapePath = path.resolve(process.cwd(), TEST_TAPES_DIR, 'passthrough-test.json');
    expect(fs.existsSync(tapePath)).toBe(false);
  });

  it('supports tapeFetch wrapper directly without global patch', async () => {
    const tapeOptions = {
      tapesDir: TEST_TAPES_DIR,
      hosts: ['127.0.0.1'],
    };

    const session = startTape('custom-fetch-test', tapeOptions);

    const resp1 = await tapeFetch(`${serverUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
    });
    const data1 = await resp1.json();
    expect(data1.choices[0].message.content).toBe('Echo response 1');
    expect(requestCounter).toBe(1);

    await session.stop();

    // Now test replay using tapeFetch
    const replaySession = startTape('custom-fetch-test', { ...tapeOptions, mode: 'replay' });
    const resp2 = await tapeFetch(`${serverUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
    });
    const data2 = await resp2.json();
    expect(data2.choices[0].message.content).toBe('Echo response 1');
    expect(requestCounter).toBe(1);

    await replaySession.stop();
  });

  it('CLI commands (ls, stats, prune, redact-check) function properly', async () => {
    const tapeOptions = {
      tapesDir: TEST_TAPES_DIR,
      hosts: ['127.0.0.1'],
    };

    // Create a tape
    await withTape('cli-test-tape', async () => {
      await fetch(`${serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }] }),
      });
    }, tapeOptions);

    // Test cmdLs
    expect(() => cmdLs(TEST_TAPES_DIR)).not.toThrow();

    // Test cmdStats
    expect(() => cmdStats(TEST_TAPES_DIR)).not.toThrow();

    // Test cmdRedactCheck
    expect(() => cmdRedactCheck(TEST_TAPES_DIR)).not.toThrow();

    // Test cmdPrune
    expect(() => cmdPrune(TEST_TAPES_DIR, 30, true)).not.toThrow();
  });
});
