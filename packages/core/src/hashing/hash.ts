/**
 * Hashing for the duplicate entity-resolution pipeline.
 * Partial hash = sha256 over first + last 64KB (cheap discriminator);
 * full hash = streaming sha256, run inside the bounded-concurrency limiter.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

export const PARTIAL_CHUNK = 64 * 1024;

/** sha256 of the first and last PARTIAL_CHUNK bytes (whole file if smaller). */
export async function partialHash(path: string, sizeBytes: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const hash = createHash('sha256');
    const headLen = Math.min(PARTIAL_CHUNK, sizeBytes);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    hash.update(head);
    if (sizeBytes > PARTIAL_CHUNK) {
      const tailStart = Math.max(sizeBytes - PARTIAL_CHUNK, PARTIAL_CHUNK);
      const tailLen = sizeBytes - tailStart;
      if (tailLen > 0) {
        const tail = Buffer.alloc(tailLen);
        await fh.read(tail, 0, tailLen, tailStart);
        hash.update(tail);
      }
    }
    return hash.digest('hex');
  } finally {
    await fh.close();
  }
}

/** Streaming sha256 of the whole file. */
export function fullHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
