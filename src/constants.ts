export const DEFAULT_LLM_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
];

export const DEFAULT_REDACT_HEADERS = [
  'authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'openai-organization',
  'openai-project',
];

export const DEFAULT_REDACT_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_\-]{20,}/g,
  /sk-ant-[a-zA-Z0-9_\-]{20,}/g,
  /AIza[0-9A-Za-z\-_]{30,}/g,
  /Bearer\s+[a-zA-Z0-9_\-\.]+/gi,
];

export const DEFAULT_IGNORE_BODY_KEYS = [
  'user',
  'metadata',
  'request_id',
];

export const LOOSE_IGNORE_BODY_KEYS = [
  'temperature',
  'max_tokens',
  'max_completion_tokens',
  'top_p',
  'top_k',
  'stream',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'n',
  'stop',
];

export const TAPE_VERSION = 1;
export const DEFAULT_TAPES_DIR = '__tapes__';
