import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DEFAULT_LLM_HOSTS,
  DEFAULT_TAPES_DIR,
} from './constants.js';
import { findClosestEntryDiff } from './matcher.js';
import { Redactor } from './redactor.js';
import {
  createReplayStream,
  isEventStream,
  recordReadableStream,
} from './stream.js';
import { Tape } from './tape.js';
import type {
  RecordedEntry,
  RecordedRequest,
  RecordedResponse,
  TapeMode,
  TapeOptions,
} from './types.js';

export interface TapeContext {
  tape: Tape;
  options: TapeOptions;
}

const tapeStorage = new AsyncLocalStorage<TapeContext>();
let globalActiveContext: TapeContext | null = null;
let originalFetch: typeof globalThis.fetch | null = null;

export function getActiveTapeContext(): TapeContext | null {
  return tapeStorage.getStore() ?? globalActiveContext;
}

export function setActiveTapeContext(ctx: TapeContext | null): void {
  globalActiveContext = ctx;
}

export function runWithTapeContext<T>(ctx: TapeContext, fn: () => Promise<T>): Promise<T> {
  return tapeStorage.run(ctx, fn);
}

export function resolveMode(options?: TapeOptions): TapeMode {
  if (options?.mode) return options.mode;
  const envMode = process.env.LLMTAPE_MODE?.toLowerCase();
  if (envMode === 'auto' || envMode === 'record' || envMode === 'replay' || envMode === 'off') {
    return envMode;
  }
  return 'auto';
}

export function isHostIntercepted(urlStr: string, options?: TapeOptions): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();

    // Check ignoreHosts first
    if (options?.ignoreHosts) {
      for (const pattern of options.ignoreHosts) {
        if (typeof pattern === 'string' && (pattern === hostname || pattern === '*')) {
          return false;
        }
        if (pattern instanceof RegExp && pattern.test(hostname)) {
          return false;
        }
      }
    }

    // Check custom hosts
    if (options?.hosts) {
      for (const pattern of options.hosts) {
        if (typeof pattern === 'string') {
          if (pattern === '*' || pattern === hostname) return true;
        }
        if (pattern instanceof RegExp && pattern.test(hostname)) {
          return true;
        }
      }
    }

    // Default LLM hosts
    return DEFAULT_LLM_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

async function extractRequestData(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  rawBodyText?: string;
}> {
  let url: string;
  let method = 'GET';
  const headers: Record<string, string> = {};

  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else {
    // Request instance
    url = input.url;
    method = input.method || 'GET';
    input.headers.forEach((val: string, key: string) => {
      headers[key.toLowerCase()] = val;
    });
  }

  if (init?.method) {
    method = init.method.toUpperCase();
  }

  if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((val, key) => {
      headers[key.toLowerCase()] = val;
    });
  }

  let body: any = null;
  let rawBodyText: string | undefined;

  let bodySource: any = init?.body;
  if (!bodySource && typeof input !== 'string' && !(input instanceof URL) && input.body) {
    // Clone request to read body without consuming original
    const cloned = input.clone();
    try {
      rawBodyText = await cloned.text();
    } catch {
      // Body could not be read as text
    }
  } else if (bodySource) {
    if (typeof bodySource === 'string') {
      rawBodyText = bodySource;
    } else if (bodySource instanceof Uint8Array || Buffer.isBuffer(bodySource)) {
      rawBodyText = new TextDecoder().decode(bodySource);
    } else if (typeof bodySource.text === 'function') {
      try {
        rawBodyText = await bodySource.text();
      } catch {
        // ignore
      }
    }
  }

  if (rawBodyText) {
    try {
      body = JSON.parse(rawBodyText);
    } catch {
      body = rawBodyText;
    }
  }

  return { url, method, headers, body, rawBodyText };
}

export async function handleTapeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  contextOverride?: TapeContext | null
): Promise<Response> {
  const ctx = contextOverride ?? getActiveTapeContext();
  const fetchFn = originalFetch ?? globalThis.fetch;

  if (!ctx) {
    return fetchFn(input, init);
  }

  const { tape, options } = ctx;
  const mode = resolveMode(options);

  if (mode === 'off') {
    return fetchFn(input, init);
  }

  const reqData = await extractRequestData(input, init);

  // Check host filtering
  if (!isHostIntercepted(reqData.url, options)) {
    return fetchFn(input, init);
  }

  const redactor = new Redactor(options);

  // Prepare normalized request for matching/recording
  const targetReq: RecordedRequest = {
    url: redactor.redactString(reqData.url),
    method: reqData.method,
    headers: redactor.redactHeaders(reqData.headers),
    body: redactor.redactValue(reqData.body),
  };

  // Replay logic
  if (mode === 'replay' || mode === 'auto') {
    const matched = tape.matchEntry(targetReq);
    if (matched) {
      const { entry } = matched;
      const respHeaders = new Headers(entry.response.headers);

      if (entry.response.streaming && entry.response.chunks) {
        const stream = createReplayStream(entry.response.chunks, options.replaySpeed);
        return new Response(stream, {
          status: entry.response.status,
          statusText: entry.response.statusText,
          headers: respHeaders,
        });
      }

      let respBody: string;
      if (entry.response.body === null || entry.response.body === undefined) {
        respBody = '';
      } else if (typeof entry.response.body === 'string') {
        respBody = entry.response.body;
      } else {
        respBody = JSON.stringify(entry.response.body);
      }

      return new Response(respBody, {
        status: entry.response.status,
        statusText: entry.response.statusText,
        headers: respHeaders,
      });
    }

    if (mode === 'replay') {
      const diffResult = findClosestEntryDiff(targetReq, tape.entries, options);
      const errMessage = [
        `\n[llmtape] Replay miss: No matching recorded entry found in tape "${tape.tapeName}".`,
        `\nIncoming request:`,
        `  Method: ${targetReq.method}`,
        `  URL:    ${targetReq.url}`,
        `  Body:   ${JSON.stringify(targetReq.body, null, 2)}`,
        `\nClosest recorded entry (#${diffResult.closestIndex}):`,
        diffResult.diffSummary ? `  ${diffResult.diffSummary.replace(/\n/g, '\n  ')}` : '  (identical structure but mismatch)',
        `\nTip: To record this call, run with LLMTAPE_MODE=record or LLMTAPE_MODE=auto.\n`,
      ].join('\n');

      throw new Error(errMessage);
    }
  }

  // Record logic (record mode or auto mode with miss)
  const realResponse = await fetchFn(input, init);

  const responseHeaders: Record<string, string> = {};
  realResponse.headers.forEach((val, key) => {
    responseHeaders[key.toLowerCase()] = val;
  });

  const isStream = isEventStream(responseHeaders);
  const recordedRespHeaders = redactor.redactHeaders(responseHeaders);

  if (isStream && realResponse.body) {
    const streamRecorder = recordReadableStream(realResponse.body);

    const recordedEntry: RecordedEntry = {
      id: `entry-${tape.entries.length}`,
      recordedAt: new Date().toISOString(),
      request: targetReq,
      response: {
        status: realResponse.status,
        statusText: realResponse.statusText,
        headers: recordedRespHeaders,
        streaming: true,
        chunks: [],
      },
    };

    tape.addEntry(recordedEntry);

    const streamFinishPromise = streamRecorder.done.then(() => {
      const chunks = streamRecorder.getChunks().map((c) => ({
        data: redactor.redactString(c.data),
        timestampOffsetMs: c.timestampOffsetMs,
      }));
      recordedEntry.response.chunks = chunks;
    });

    tape.trackStream(streamFinishPromise);

    return new Response(streamRecorder.teeStream, {
      status: realResponse.status,
      statusText: realResponse.statusText,
      headers: new Headers(responseHeaders),
    });
  }

  // Non-streaming response
  const rawText = await realResponse.text();
  let parsedBody: any = rawText;
  try {
    parsedBody = JSON.parse(rawText);
  } catch {
    // keep as text
  }

  const redactedBody = redactor.redactValue(parsedBody);

  const recordedEntry: RecordedEntry = {
    id: `entry-${tape.entries.length}`,
    recordedAt: new Date().toISOString(),
    request: targetReq,
    response: {
      status: realResponse.status,
      statusText: realResponse.statusText,
      headers: recordedRespHeaders,
      streaming: false,
      body: redactedBody,
    },
  };

  tape.addEntry(recordedEntry);

  return new Response(rawText, {
    status: realResponse.status,
    statusText: realResponse.statusText,
    headers: new Headers(responseHeaders),
  });
}

/**
 * Custom fetch wrapper to pass to SDKs that accept a `fetch` option:
 * e.g. new OpenAI({ fetch: tapeFetch })
 */
export const tapeFetch: typeof globalThis.fetch = function (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  return handleTapeFetch(input, init);
};

export function patchGlobalFetch(): void {
  if (!originalFetch) {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      return handleTapeFetch(input, init);
    };
  }
}

export function unpatchGlobalFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}
