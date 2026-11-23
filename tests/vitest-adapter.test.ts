import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { useTape } from '../src/vitest.js';

const VITEST_TAPES_DIR = '__vitest_tapes__';

describe('llmtape/vitest useTape adapter', () => {
  let server: http.Server;
  let serverUrl: string;
  let serverHits = 0;

  beforeAll(async () => {
    const dir = path.resolve(process.cwd(), VITEST_TAPES_DIR);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    server = http.createServer((req, res) => {
      serverHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply: `server hit #${serverHits}` }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        serverUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const dir = path.resolve(process.cwd(), VITEST_TAPES_DIR);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Automatically record / replay each test in this suite
  useTape({
    tapesDir: VITEST_TAPES_DIR,
    hosts: ['127.0.0.1'],
  });

  it('automatically manages tape per test case - pass 1', async () => {
    const resp = await fetch(`${serverUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'hello test 1' }),
    });
    const data = await resp.json();
    expect(data.reply).toBe('server hit #1');
    expect(serverHits).toBe(1);
  });

  it('automatically manages tape per test case - pass 2', async () => {
    const resp = await fetch(`${serverUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'hello test 2' }),
    });
    const data = await resp.json();
    expect(data.reply).toBe('server hit #2');
    expect(serverHits).toBe(2);
  });
});
