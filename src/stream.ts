import type { StreamChunk } from './types.js';

export function isEventStream(headers: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') {
      const val = v.toLowerCase();
      return val.includes('text/event-stream') || val.includes('application/x-ndjson');
    }
  }
  return false;
}

export interface StreamRecorder {
  teeStream: ReadableStream<Uint8Array>;
  getChunks(): StreamChunk[];
  done: Promise<void>;
}

export function recordReadableStream(originalStream: ReadableStream<Uint8Array>): StreamRecorder {
  const [streamA, streamB] = originalStream.tee();
  const chunks: StreamChunk[] = [];
  const startTime = Date.now();
  const decoder = new TextDecoder();

  const reader = streamB.getReader();
  const done = (async () => {
    try {
      while (true) {
        const { done: isDone, value } = await reader.read();
        if (isDone) break;
        if (value) {
          const text = decoder.decode(value, { stream: true });
          chunks.push({
            data: text,
            timestampOffsetMs: Date.now() - startTime,
          });
        }
      }
      const remainder = decoder.decode();
      if (remainder) {
        chunks.push({
          data: remainder,
          timestampOffsetMs: Date.now() - startTime,
        });
      }
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    teeStream: streamA,
    getChunks: () => chunks,
    done,
  };
}

export function createReplayStream(
  chunks: StreamChunk[],
  speed: 'instant' | 'realtime' = 'instant'
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (chunks.length === 0) {
        controller.close();
        return;
      }

      if (speed === 'instant') {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk.data));
        }
        controller.close();
        return;
      }

      // Realtime playback
      let lastOffset = 0;
      for (const chunk of chunks) {
        const delay = Math.max(0, chunk.timestampOffsetMs - lastOffset);
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        controller.enqueue(encoder.encode(chunk.data));
        lastOffset = chunk.timestampOffsetMs;
      }
      controller.close();
    },
  });
}
