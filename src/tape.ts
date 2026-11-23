import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_TAPES_DIR, TAPE_VERSION } from './constants.js';
import { requestsMatch } from './matcher.js';
import type { RecordedEntry, RecordedRequest, TapeFile, TapeOptions } from './types.js';

export function sanitizeTapeName(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9_\-\.]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'tape';
}

export class Tape {
  public tapeName: string;
  public filePath: string;
  public options: TapeOptions;
  public tapeData: TapeFile;
  public usedIndices = new Set<number>();
  private dirty = false;
  private pendingStreams: Promise<void>[] = [];

  constructor(tapeName: string, options: TapeOptions = {}) {
    this.tapeName = tapeName;
    this.options = options;
    const dir = options.tapesDir || DEFAULT_TAPES_DIR;
    const fileName = `${sanitizeTapeName(tapeName)}.json`;
    this.filePath = path.resolve(process.cwd(), dir, fileName);

    this.tapeData = this.loadOrCreate();
  }

  private loadOrCreate(): TapeFile {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as TapeFile;
        parsed.lastUsedAt = new Date().toISOString();
        return parsed;
      } catch (err) {
        console.warn(`[llmtape] Failed to read tape file at ${this.filePath}:`, err);
      }
    }

    const now = new Date().toISOString();
    return {
      version: TAPE_VERSION,
      tapeName: this.tapeName,
      createdAt: now,
      lastUsedAt: now,
      entries: [],
    };
  }

  public get entries(): RecordedEntry[] {
    return this.tapeData.entries;
  }

  public matchEntry(req: RecordedRequest): { entry: RecordedEntry; index: number } | null {
    for (let i = 0; i < this.tapeData.entries.length; i++) {
      if (this.usedIndices.has(i)) continue;
      const candidate = this.tapeData.entries[i];
      if (requestsMatch(req, candidate.request, this.options)) {
        this.usedIndices.add(i);
        return { entry: candidate, index: i };
      }
    }
    return null;
  }

  public addEntry(entry: RecordedEntry): void {
    this.tapeData.entries.push(entry);
    this.usedIndices.add(this.tapeData.entries.length - 1);
    this.dirty = true;
  }

  public trackStream(donePromise: Promise<void>): void {
    this.pendingStreams.push(donePromise);
  }

  public async save(): Promise<void> {
    if (this.pendingStreams.length > 0) {
      await Promise.allSettled(this.pendingStreams);
      this.pendingStreams = [];
    }

    // Only write if dirty or file already exists (to update lastUsedAt)
    if (!this.dirty && !fs.existsSync(this.filePath)) {
      return;
    }

    this.tapeData.lastUsedAt = new Date().toISOString();
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = JSON.stringify(this.tapeData, null, 2);
    fs.writeFileSync(this.filePath, content, 'utf-8');
    this.dirty = false;
  }
}
