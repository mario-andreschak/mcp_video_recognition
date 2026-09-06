import { setTimeout as delay } from 'node:timers/promises';
import { open } from 'node:fs/promises';
import { createProviderFailure } from './provider-failure.js';

export function abortFailure(signal: AbortSignal) {
  return createProviderFailure({ provider: 'gemini',
    category: signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled',
    safeMessage: signal.reason?.name === 'TimeoutError' ? 'Gemini request timed out.' : 'Gemini request was cancelled.',
    code: signal.reason?.name === 'TimeoutError' ? 'ADAPTER_TIMEOUT' : 'CALLER_CANCELLED' });
}
export async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { void work.catch(() => { /* Settled or intentionally pending fixture. */ }); throw abortFailure(signal); }
  let listener: () => void = () => { /* Settled or intentionally pending fixture. */ };
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      listener = () => reject(abortFailure(signal));
      signal.addEventListener('abort', listener, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', listener); }
}
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  await abortable(delay(ms, undefined, { signal }), signal);
}
/** Read a regular file from one descriptor, stopping at maxBytes+1 even if it grows. */
export async function readBoundedFile(filepath: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await open(filepath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Media exceeds size limit or is not a regular file');
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(65536, maxBytes + 1 - size));
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error('Media exceeds size limit');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally { await file.close(); }
}
