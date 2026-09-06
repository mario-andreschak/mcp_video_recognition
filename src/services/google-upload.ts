import { ApiError, type File as GoogleFile } from '@google/genai';
import { abortable } from './operation.js';

const ORIGIN = 'https://generativelanguage.googleapis.com';
async function textBounded(response: Response, signal: AbortSignal, maxBytes = 1048576): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Google upload response exceeds limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    void reader.cancel().catch(() => { /* Connection may already be closed. */ });
    reader.releaseLock();
  }
}
async function checked(response: Response, signal: AbortSignal) {
  const text = await textBounded(response, signal);
  if (!response.ok) throw new ApiError({ status: response.status, message: text });
  return text;
}
/** Documented resumable Files REST binding.
 * SDK 2.21.0 files.upload does not forward abortSignal and replaces its required
 * upload headers when httpOptions is supplied. Keep this small public HTTP adapter
 * until an installed-SDK regression test proves those defects fixed.
 */
export async function uploadGoogleFile(file: Blob, mimeType: string, apiKey: string, signal: AbortSignal): Promise<GoogleFile> {
  const started = await abortable(fetch(ORIGIN + '/upload/v1beta/files', {
    method: 'POST', redirect: 'error', signal,
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json',
      'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(file.size), 'x-goog-upload-header-content-type': mimeType },
    body: JSON.stringify({ file: { display_name: 'mcp-media' } })
  }), signal);
  await checked(started, signal);
  const location = started.headers.get('x-goog-upload-url');
  if (!location) throw new Error('Google upload endpoint was not provided');
  const url = new URL(location);
  if (url.origin !== ORIGIN || url.username || url.password || url.hash)
    throw new Error('Google upload endpoint is not trusted');
  const completed = await abortable(fetch(url, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'x-goog-api-key': apiKey, 'content-type': mimeType,
      'x-goog-upload-command': 'upload, finalize', 'x-goog-upload-offset': '0' }, body: file
  }), signal);
  const body: unknown = JSON.parse(await checked(completed, signal));
  if (!body || typeof body !== 'object' || !('file' in body) || !body.file || typeof body.file !== 'object')
    throw new Error('Invalid Google upload response');
  return body.file as GoogleFile;
}
