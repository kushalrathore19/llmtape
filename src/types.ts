export type TapeMode = 'auto' | 'record' | 'replay' | 'off';

export interface TapeOptions {
  /**
   * Operation mode:
   * - "auto" (default): replay if matching entry exists, otherwise record
   * - "record": always hit real API and record
   * - "replay": never hit network; throw error if no match
   * - "off": passthrough to real fetch
   * Can also be set via process.env.LLMTAPE_MODE
   */
  mode?: TapeMode;

  /**
   * Directory where tape JSON files are stored.
   * Default: "__tapes__"
   */
  tapesDir?: string;

  /**
   * Additional or custom hosts to intercept.
   * Default includes: api.openai.com, api.anthropic.com, generativelanguage.googleapis.com, openrouter.ai
   * Set to ['*'] to intercept all hosts.
   */
  hosts?: (string | RegExp)[];

  /**
   * Hosts to explicitly ignore/passthrough.
   */
  ignoreHosts?: (string | RegExp)[];

  /**
   * Keys in JSON request body to ignore during matching.
   * Default: ["user", "metadata", "request_id"]
   */
  ignoreBodyKeys?: string[];

  /**
   * Matching strategy:
   * - "exact": matches normalized body except ignoreBodyKeys
   * - "loose": also ignores temperature, max_tokens, top_p, stream, etc.
   */
  match?: 'exact' | 'loose';

  /**
   * Speed for replaying streaming responses:
   * - "instant" (default): emit chunks as quickly as possible
   * - "realtime": preserve the delay between recorded chunks
   */
  replaySpeed?: 'instant' | 'realtime';

  /**
   * Header names to redact in recordings.
   * Default: authorization, x-api-key, api-key, x-goog-api-key, openai-organization, openai-project
   */
  redactHeaders?: string[];

  /**
   * Regex patterns to redact in headers, URLs, and bodies.
   */
  redactPatterns?: RegExp[];

  /**
   * Custom redaction callback.
   */
  customRedactor?: (content: string) => string;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

export interface StreamChunk {
  data: string;
  timestampOffsetMs: number;
}

export interface RecordedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: any;
  streaming?: boolean;
  chunks?: StreamChunk[];
}

export interface RecordedEntry {
  id: string;
  recordedAt: string;
  request: RecordedRequest;
  response: RecordedResponse;
}

export interface TapeFile {
  version: number;
  tapeName: string;
  createdAt: string;
  lastUsedAt: string;
  entries: RecordedEntry[];
}
