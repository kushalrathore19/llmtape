import { DEFAULT_REDACT_HEADERS, DEFAULT_REDACT_PATTERNS } from './constants.js';
import type { TapeOptions } from './types.js';

export class Redactor {
  private headersToRedact: Set<string>;
  private patterns: RegExp[];
  private customRedactor?: (content: string) => string;

  constructor(options?: Pick<TapeOptions, 'redactHeaders' | 'redactPatterns' | 'customRedactor'>) {
    const headers = options?.redactHeaders ?? DEFAULT_REDACT_HEADERS;
    this.headersToRedact = new Set(headers.map((h) => h.toLowerCase()));
    this.patterns = options?.redactPatterns ?? DEFAULT_REDACT_PATTERNS;
    this.customRedactor = options?.customRedactor;
  }

  redactString(text: string): string {
    if (!text) return text;
    let result = text;
    for (const pattern of this.patterns) {
      // Create a new regex instance if needed to avoid lastIndex bugs with global regexes
      const re = new RegExp(pattern.source, pattern.flags);
      result = result.replace(re, '[REDACTED]');
    }
    if (this.customRedactor) {
      result = this.customRedactor(result);
    }
    return result;
  }

  redactHeaders(headers: Record<string, string>): Record<string, string> {
    const redacted: Record<string, string> = {};
    for (const [key, val] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (this.headersToRedact.has(lowerKey)) {
        redacted[lowerKey] = '[REDACTED]';
      } else {
        redacted[lowerKey] = this.redactString(val);
      }
    }
    return redacted;
  }

  redactValue(val: any): any {
    if (val === null || val === undefined) return val;
    if (typeof val === 'string') {
      return this.redactString(val);
    }
    if (Array.isArray(val)) {
      return val.map((item) => this.redactValue(item));
    }
    if (typeof val === 'object') {
      const result: Record<string, any> = {};
      for (const [key, v] of Object.entries(val)) {
        const lowerKey = key.toLowerCase();
        if (
          this.headersToRedact.has(lowerKey) ||
          lowerKey === 'api_key' ||
          lowerKey === 'apikey' ||
          lowerKey === 'secret_key'
        ) {
          result[key] = '[REDACTED]';
        } else {
          result[key] = this.redactValue(v);
        }
      }
      return result;
    }
    return val;
  }
}

export interface SecretFinding {
  pattern: string;
  match: string;
  line: number;
  snippet: string;
}

export function scanForSecrets(content: string, patterns: RegExp[] = DEFAULT_REDACT_PATTERNS): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    for (const pattern of patterns) {
      const re = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        // Exclude already redacted strings
        if (match[0].includes('[REDACTED]')) continue;

        findings.push({
          pattern: pattern.source,
          match: match[0],
          line: lineIdx + 1,
          snippet: line.trim(),
        });
      }
    }
  }

  return findings;
}
