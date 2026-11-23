import {
  DEFAULT_IGNORE_BODY_KEYS,
  LOOSE_IGNORE_BODY_KEYS,
} from './constants.js';
import type { RecordedEntry, RecordedRequest, TapeOptions } from './types.js';

export function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    // Sort query parameters
    const params = Array.from(parsed.searchParams.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    parsed.search = '';
    for (const [k, v] of params) {
      parsed.searchParams.append(k, v);
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function sortKeys(obj: any): any {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);

  const sorted: Record<string, any> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

export function normalizeBody(
  body: any,
  options?: Pick<TapeOptions, 'ignoreBodyKeys' | 'match'>
): any {
  if (body === null || body === undefined) return null;

  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return body;
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return parsed;
  }

  const ignoreKeys = new Set(options?.ignoreBodyKeys ?? DEFAULT_IGNORE_BODY_KEYS);
  if (options?.match === 'loose') {
    for (const key of LOOSE_IGNORE_BODY_KEYS) {
      ignoreKeys.add(key);
    }
  }

  function filterObj(item: any): any {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(filterObj);

    const filtered: Record<string, any> = {};
    for (const [k, v] of Object.entries(item)) {
      if (!ignoreKeys.has(k)) {
        filtered[k] = filterObj(v);
      }
    }
    return filtered;
  }

  return sortKeys(filterObj(parsed));
}

export function requestsMatch(
  reqA: RecordedRequest,
  reqB: RecordedRequest,
  options?: Pick<TapeOptions, 'ignoreBodyKeys' | 'match'>
): boolean {
  if (reqA.method.toUpperCase() !== reqB.method.toUpperCase()) {
    return false;
  }

  const urlA = normalizeUrl(reqA.url);
  const urlB = normalizeUrl(reqB.url);
  if (urlA !== urlB) {
    return false;
  }

  const bodyA = normalizeBody(reqA.body, options);
  const bodyB = normalizeBody(reqB.body, options);

  return JSON.stringify(bodyA) === JSON.stringify(bodyB);
}

export interface DiffResult {
  closestEntry: RecordedEntry | null;
  closestIndex: number;
  diffSummary: string;
}

export function findClosestEntryDiff(
  target: RecordedRequest,
  entries: RecordedEntry[],
  options?: Pick<TapeOptions, 'ignoreBodyKeys' | 'match'>
): DiffResult {
  if (entries.length === 0) {
    return {
      closestEntry: null,
      closestIndex: -1,
      diffSummary: 'No entries recorded in tape.',
    };
  }

  const targetUrl = normalizeUrl(target.url);
  const targetBodyNorm = normalizeBody(target.body, options);
  const targetBodyStr = JSON.stringify(targetBodyNorm);

  let bestScore = -1;
  let bestIndex = 0;

  entries.forEach((entry, idx) => {
    let score = 0;
    const entryReq = entry.request;
    if (entryReq.method.toUpperCase() === target.method.toUpperCase()) {
      score += 2;
    }
    const entryUrl = normalizeUrl(entryReq.url);
    if (entryUrl === targetUrl) {
      score += 10;
    } else {
      try {
        const u1 = new URL(entryUrl);
        const u2 = new URL(targetUrl);
        if (u1.pathname === u2.pathname) score += 5;
        if (u1.host === u2.host) score += 3;
      } catch {
        // ignore url parsing error
      }
    }

    const entryBodyNorm = normalizeBody(entryReq.body, options);
    const entryBodyStr = JSON.stringify(entryBodyNorm);
    if (entryBodyStr === targetBodyStr) {
      score += 15;
    } else if (targetBodyNorm && entryBodyNorm && typeof targetBodyNorm === 'object' && typeof entryBodyNorm === 'object') {
      const keysA = Object.keys(targetBodyNorm);
      const keysB = Object.keys(entryBodyNorm);
      const commonKeys = keysA.filter((k) => keysB.includes(k));
      score += commonKeys.length;
      for (const k of commonKeys) {
        if (JSON.stringify(targetBodyNorm[k]) === JSON.stringify(entryBodyNorm[k])) {
          score += 3;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = idx;
    }
  });

  const closest = entries[bestIndex];
  const closestReq = closest.request;

  const diffLines: string[] = [];

  if (target.method.toUpperCase() !== closestReq.method.toUpperCase()) {
    diffLines.push(`Method diff: incoming "${target.method}" != recorded "${closestReq.method}"`);
  }
  if (targetUrl !== normalizeUrl(closestReq.url)) {
    diffLines.push(`URL diff:`);
    diffLines.push(`  - recorded: ${closestReq.url}`);
    diffLines.push(`  + incoming: ${target.url}`);
  }

  const normTarget = normalizeBody(target.body, options);
  const normClosest = normalizeBody(closestReq.body, options);

  if (JSON.stringify(normTarget) !== JSON.stringify(normClosest)) {
    diffLines.push(`Body diff:`);
    if (typeof normTarget === 'object' && typeof normClosest === 'object' && normTarget && normClosest) {
      const allKeys = Array.from(new Set([...Object.keys(normClosest), ...Object.keys(normTarget)])).sort();
      for (const k of allKeys) {
        const valC = normClosest[k];
        const valT = normTarget[k];
        if (JSON.stringify(valC) !== JSON.stringify(valT)) {
          diffLines.push(`  field "${k}":`);
          diffLines.push(`    - recorded: ${JSON.stringify(valC)}`);
          diffLines.push(`    + incoming: ${JSON.stringify(valT)}`);
        }
      }
    } else {
      diffLines.push(`  - recorded: ${JSON.stringify(normClosest)}`);
      diffLines.push(`  + incoming: ${JSON.stringify(normTarget)}`);
    }
  }

  return {
    closestEntry: closest,
    closestIndex: bestIndex,
    diffSummary: diffLines.length > 0 ? diffLines.join('\n') : 'Body or query parameters differ slightly.',
  };
}
