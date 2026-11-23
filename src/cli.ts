import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_TAPES_DIR } from './constants.js';
import { scanForSecrets } from './redactor.js';
import type { TapeFile } from './types.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getTapeFiles(tapesDir: string): string[] {
  const resolved = path.resolve(process.cwd(), tapesDir);
  if (!fs.existsSync(resolved)) {
    return [];
  }
  return fs
    .readdirSync(resolved)
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.join(resolved, file));
}

function readTapeFile(filePath: string): TapeFile | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as TapeFile;
  } catch {
    return null;
  }
}

export function cmdLs(tapesDir: string = DEFAULT_TAPES_DIR): void {
  const files = getTapeFiles(tapesDir);
  if (files.length === 0) {
    console.log(`[llmtape] No tapes found in ${tapesDir}`);
    return;
  }

  console.log(`\nTapes in ${tapesDir} (${files.length} found):\n`);
  console.log(
    'NAME'.padEnd(35) +
      'ENTRIES'.padEnd(10) +
      'SIZE'.padEnd(12) +
      'LAST USED'.padEnd(24)
  );
  console.log('-'.repeat(81));

  let totalEntries = 0;
  let totalBytes = 0;

  for (const file of files) {
    const stats = fs.statSync(file);
    const data = readTapeFile(file);
    const name = path.basename(file, '.json');
    const entriesCount = data?.entries?.length ?? 0;
    const lastUsed = data?.lastUsedAt
      ? new Date(data.lastUsedAt).toLocaleString()
      : stats.mtime.toLocaleString();

    totalEntries += entriesCount;
    totalBytes += stats.size;

    console.log(
      name.slice(0, 33).padEnd(35) +
        String(entriesCount).padEnd(10) +
        formatBytes(stats.size).padEnd(12) +
        lastUsed.padEnd(24)
    );
  }

  console.log('-'.repeat(81));
  console.log(
    `Total: ${files.length} tapes, ${totalEntries} entries, ${formatBytes(totalBytes)}\n`
  );
}

export function cmdStats(tapesDir: string = DEFAULT_TAPES_DIR): void {
  const files = getTapeFiles(tapesDir);
  if (files.length === 0) {
    console.log(`[llmtape] No tapes found in ${tapesDir}`);
    return;
  }

  let totalRequests = 0;
  let streamingRequests = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for (const file of files) {
    const data = readTapeFile(file);
    if (!data?.entries) continue;

    for (const entry of data.entries) {
      totalRequests++;
      if (entry.response.streaming) {
        streamingRequests++;
      }

      // 1. Check body usage
      const body = entry.response.body;
      if (body && typeof body === 'object') {
        // OpenAI format
        if (body.usage) {
          promptTokens += body.usage.prompt_tokens ?? body.usage.input_tokens ?? 0;
          completionTokens += body.usage.completion_tokens ?? body.usage.output_tokens ?? 0;
        }
        // Google Gemini format
        if (body.usageMetadata) {
          promptTokens += body.usageMetadata.promptTokenCount ?? 0;
          completionTokens += body.usageMetadata.candidatesTokenCount ?? 0;
        }
      }

      // 2. Check streaming chunks if usage was streamed
      if (entry.response.streaming && entry.response.chunks) {
        for (const chunk of entry.response.chunks) {
          if (chunk.data && chunk.data.includes('"usage"')) {
            try {
              const lines = chunk.data.split('\n');
              for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  const parsed = JSON.parse(line.slice(6));
                  if (parsed.usage) {
                    promptTokens += parsed.usage.prompt_tokens ?? parsed.usage.input_tokens ?? 0;
                    completionTokens += parsed.usage.completion_tokens ?? parsed.usage.output_tokens ?? 0;
                  }
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    }
  }

  const totalTokens = promptTokens + completionTokens;
  const estimatedSecondsSaved = totalRequests * 1.5; // ~1.5s per real LLM network roundtrip

  console.log(`\n================== llmtape stats ==================`);
  console.log(`Tape Directory:          ${tapesDir}`);
  console.log(`Recorded Tapes:          ${files.length}`);
  console.log(`Total Requests Recorded: ${totalRequests}`);
  console.log(`  - Standard:            ${totalRequests - streamingRequests}`);
  console.log(`  - Streaming:           ${streamingRequests}`);
  console.log(`\nToken Savings per test run (replays):`);
  console.log(`  - Prompt Tokens:       ${promptTokens.toLocaleString()}`);
  console.log(`  - Completion Tokens:   ${completionTokens.toLocaleString()}`);
  console.log(`  - Total Tokens Saved:  ${totalTokens.toLocaleString()}`);
  console.log(`\nEstimated Time Saved:    ~${estimatedSecondsSaved.toFixed(0)} seconds per test run`);
  console.log(`===================================================\n`);
}

export function cmdPrune(tapesDir: string = DEFAULT_TAPES_DIR, days: number = 30, dryRun = false): void {
  const files = getTapeFiles(tapesDir);
  if (files.length === 0) {
    console.log(`[llmtape] No tapes found in ${tapesDir}`);
    return;
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let prunedCount = 0;
  let reclaimedBytes = 0;

  console.log(`\nScanning tapes in ${tapesDir} older than ${days} days...`);

  for (const file of files) {
    const stats = fs.statSync(file);
    const data = readTapeFile(file);
    const lastUsedTime = data?.lastUsedAt ? new Date(data.lastUsedAt).getTime() : stats.mtimeMs;

    if (lastUsedTime < cutoff) {
      prunedCount++;
      reclaimedBytes += stats.size;
      const name = path.basename(file);
      if (dryRun) {
        console.log(`[dry-run] Would delete: ${name} (${formatBytes(stats.size)}, last used ${new Date(lastUsedTime).toISOString()})`);
      } else {
        fs.unlinkSync(file);
        console.log(`Deleted: ${name} (${formatBytes(stats.size)})`);
      }
    }
  }

  if (prunedCount === 0) {
    console.log(`No stale tapes older than ${days} days found.\n`);
  } else {
    console.log(
      `\n${dryRun ? 'Would prune' : 'Pruned'} ${prunedCount} tape(s), reclaimed ${formatBytes(reclaimedBytes)}.\n`
    );
  }
}

export function cmdRedactCheck(tapesDir: string = DEFAULT_TAPES_DIR): void {
  const files = getTapeFiles(tapesDir);
  if (files.length === 0) {
    console.log(`[llmtape] No tapes found to check in ${tapesDir}`);
    return;
  }

  console.log(`\nScanning ${files.length} tape(s) for leaked API keys or credentials...\n`);

  let totalFindings = 0;

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf-8');
    const findings = scanForSecrets(raw);

    if (findings.length > 0) {
      const relPath = path.relative(process.cwd(), file);
      console.error(`🚨 Potential secret(s) found in ${relPath}:`);
      for (const f of findings) {
        totalFindings++;
        const masked = f.match.slice(0, 4) + '...' + f.match.slice(-4);
        console.error(`   Line ${f.line}: Pattern "${f.pattern}" matched "${masked}"`);
        console.error(`     Snippet: ${f.snippet.slice(0, 100)}...`);
      }
      console.error('');
    }
  }

  if (totalFindings > 0) {
    console.error(`❌ FAILED: ${totalFindings} potential credential leak(s) found across tape files!`);
    console.error(`Run tests with proper redaction or clean your tapes before committing.\n`);
    process.exit(1);
  }

  console.log(`✓ All tapes are clean! No unredacted keys or secrets found.\n`);
}

export function runCli(args: string[] = process.argv.slice(2)): void {
  const command = args[0] || 'help';

  let dir = DEFAULT_TAPES_DIR;
  let days = 30;
  let dryRun = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--days' && args[i + 1]) {
      days = parseInt(args[++i], 10) || 30;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (!arg.startsWith('-')) {
      dir = arg;
    }
  }

  switch (command) {
    case 'ls':
    case 'list':
      cmdLs(dir);
      break;

    case 'stats':
      cmdStats(dir);
      break;

    case 'prune':
      cmdPrune(dir, days, dryRun);
      break;

    case 'redact-check':
    case 'check':
      cmdRedactCheck(dir);
      break;

    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(`
llmtape - Zero-dependency record & replay for LLM APIs

Usage:
  llmtape ls [dir]                List all recorded tapes with entry counts & size
  llmtape stats [dir]             Show token & time savings from replays
  llmtape prune [dir] [--days N]  Remove tapes unused for N days (default: 30)
  llmtape redact-check [dir]      Scan tapes for unredacted API keys/secrets (exits 1 if found)
  llmtape help                    Show this help message

Options:
  --days <number>   Age threshold for prune (default: 30)
  --dry-run         Simulate prune without deleting files
`);
      break;
  }
}

// Auto-run if executed as script
if (
  process.argv[1] &&
  (process.argv[1].endsWith('cli.js') ||
    process.argv[1].endsWith('cli.cjs') ||
    process.argv[1].endsWith('bin/llmtape.js'))
) {
  runCli();
}
