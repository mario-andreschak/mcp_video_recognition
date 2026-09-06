import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_GEMINI_MODEL } from './provider-config.js';
import type { GeminiConfig, GeminiFile, GeminiResponse, CachedFile, ProcessedGeminiFile } from '../types/index.js';
import { FileState } from '../types/index.js';
import { abortable, pause, readBoundedFile } from './operation.js';
import { uploadGoogleFile } from './google-upload.js';

export class GeminiVideoProcessingTimeoutError extends Error {}
interface Upload { promise: Promise<GeminiFile>; controller: AbortController; waiters: number }
export interface GeminiLimits {
  maxUploadBytes?: number;
  requestTimeoutMs?: number;
  processingTimeoutMs?: number;
  maxResponseBytes?: number;
  maxCachedFiles?: number;
  cacheTtlMs?: number;
  pollIntervalMs?: number;
}
/** One instance owns one Google account. No uploaded file identifiers cross instances. */
export class GeminiService {
  private readonly client: GoogleGenAI;
  private readonly upload: (file: Blob, mimeType: string, signal: AbortSignal) => ReturnType<GoogleGenAI['files']['upload']>;
  private fileCache = new Map<string, CachedFile>();
  private inFlightUploads = new Map<string, Upload>();
  private ownedFiles = new Set<string>();
  private leases = new Map<string, number>();
  private stopped = false;
  private readonly expiryTimer: ReturnType<typeof setInterval>;
  private readonly limits: Required<GeminiLimits>;
  constructor(config: GeminiConfig, limits: GeminiLimits = {}, client?: GoogleGenAI) {
    this.limits = { maxUploadBytes: 32 * 1024 * 1024, requestTimeoutMs: 120000,
      processingTimeoutMs: 300000, maxResponseBytes: 1048576, maxCachedFiles: 16,
      cacheTtlMs: 3600000, pollIntervalMs: 2000, ...limits };
    this.expiryTimer = setInterval(() => { void this.prune(); }, Math.max(1000, Math.min(60000, this.limits.cacheTtlMs)));
    this.expiryTimer.unref();
    this.upload = client ? (file, mimeType, signal) => client.files.upload({ file, config: { mimeType, abortSignal: signal } })
      : (file, mimeType, signal) => uploadGoogleFile(file, mimeType, config.apiKey, signal);
    this.client = client ?? new GoogleGenAI({ apiKey: config.apiKey,
      httpOptions: { timeout: this.limits.requestTimeoutMs, retryOptions: { attempts: 1 } } });
  }
  private signal(caller?: AbortSignal, timeout = this.limits.requestTimeoutMs) {
    const deadline = AbortSignal.timeout(Math.max(1, timeout));
    return caller ? AbortSignal.any([caller, deadline]) : deadline;
  }
  private async removeOwned(name: string): Promise<void> {
    if (!this.ownedFiles.delete(name)) return;
    this.leases.delete(name);
    try {
      const signal = AbortSignal.timeout(3000);
      await abortable(this.client.files.delete({ name, config: { abortSignal: signal, httpOptions: { timeout: 3000, retryOptions: { attempts: 1 } } } }), signal);
    } catch { /* Best effort: Google also expires Files API uploads; never log media identifiers. */ }
  }
  private async prune(): Promise<void> {
    for (const [key, value] of this.fileCache) {
      if (Date.now() - value.timestamp >= this.limits.cacheTtlMs && !this.leases.get(value.name)) {
        this.fileCache.delete(key);
        await this.removeOwned(value.name);
      }
    }
  }
  async getFile(name: string, caller?: AbortSignal): Promise<GeminiFile> {
    const signal = this.signal(caller);
    const file = await abortable(this.client.files.get({ name, config: { abortSignal: signal } }), signal);
    if (!file.uri || !file.mimeType) throw new Error('Invalid uploaded media state');
    return { uri: file.uri, mimeType: file.mimeType, name: file.name, state: file.state };
  }
  async waitForVideoProcessing(file: GeminiFile, maxWaitTimeMs = 300000, caller?: AbortSignal): Promise<ProcessedGeminiFile> {
    if (!file.name) throw new Error('File name is required to check processing status');
    if (maxWaitTimeMs < 0) throw new GeminiVideoProcessingTimeoutError('Media processing timed out');
    const signal = this.signal(caller, maxWaitTimeMs);
    let current = file;
    try {
      while (current.state !== FileState.ACTIVE) {
        if (current.state === FileState.FAILED) throw new Error('Gemini file upload failed');
        await pause(this.limits.pollIntervalMs, signal);
        current = await this.getFile(file.name, signal);
      }
    } catch (error) {
      if (signal.aborted && !caller?.aborted) throw new GeminiVideoProcessingTimeoutError('Media processing timed out');
      throw error;
    }
    return { ...current, name: file.name, state: FileState.ACTIVE };
  }
  async uploadFile(filePath: string, caller?: AbortSignal): Promise<GeminiFile> {
    if (this.stopped) throw new Error('Gemini service is closed');
    caller?.throwIfAborted();
    let upload = this.inFlightUploads.get(filePath);
    if (!upload) {
      if (this.inFlightUploads.size >= 8) throw new Error('Concurrent media upload limit reached');
      const controller = new AbortController();
      upload = { controller, waiters: 0, promise: this._doUploadFile(filePath, controller.signal) };
      const owned = upload;
      this.inFlightUploads.set(filePath, upload);
      void upload.promise.finally(() => {
        if (this.inFlightUploads.get(filePath) === owned) this.inFlightUploads.delete(filePath);
      }).catch(() => { /* Settled or intentionally pending fixture. */ });
    }
    upload.waiters++;
    try {
      const file = await abortable(upload.promise, caller);
      if (file.name) this.leases.set(file.name, (this.leases.get(file.name) ?? 0) + 1);
      return file;
    } finally {
      upload.waiters--;
      if (!upload.waiters && this.inFlightUploads.get(filePath) === upload) upload.controller.abort();
    }
  }
  private async _doUploadFile(filePath: string, caller: AbortSignal): Promise<GeminiFile> {
    const mimeTypes: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.webp': 'image/webp', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
    const mimeType = mimeTypes[path.extname(filePath).toLowerCase()];
    if (!mimeType) throw new Error('Unsupported media format');
    const signal = this.signal(caller, this.limits.processingTimeoutMs + this.limits.requestTimeoutMs);
    const bytes = await readBoundedFile(filePath, this.limits.maxUploadBytes, signal);
    const checksum = createHash('sha256').update(mimeType).update(bytes).digest('hex');
    await this.prune();
    const cached = this.fileCache.get(checksum);
    if (cached) return { uri: cached.uri, mimeType: cached.mimeType, name: cached.name, state: cached.state };
    if (this.fileCache.size + this.inFlightUploads.size > this.limits.maxCachedFiles) throw new Error('Media cache capacity reached');
    let name: string | undefined;
    try {
      // A bounded snapshot prevents a changing source file from bypassing the upload cap.
      const uploadSignal = this.signal(signal);
      const upload = this.upload(new Blob([new Uint8Array(bytes)], { type: mimeType }), mimeType, uploadSignal);
      // Capture late successful uploads after cancellation so they can still be deleted.
      void upload.then(async value => {
        if (value.name && (uploadSignal.aborted || this.stopped)) {
          this.ownedFiles.add(value.name);
          await this.removeOwned(value.name);
        }
      }, () => { /* Settled or intentionally pending fixture. */ });
      const value = await abortable(upload, uploadSignal);
      name = value.name;
      if (name) this.ownedFiles.add(name);
      if (!value.uri || !name) throw new Error('File upload failed: Missing URI or name');
      let file: GeminiFile = { uri: value.uri, mimeType, name, state: value.state };
      if (file.state === FileState.FAILED) throw new Error('Gemini file upload failed');
      if (file.state === FileState.PROCESSING) file = await this.waitForVideoProcessing(file, this.limits.processingTimeoutMs, signal);
      if (uploadSignal.aborted || this.stopped) { signal.throwIfAborted(); throw new Error('Gemini service is closed'); }
      this.fileCache.set(checksum, { ...file, name, state: file.state ?? FileState.ACTIVE,
        fileId: name, checksum, timestamp: Date.now() });
      return file;
    } catch (error) {
      if (name) await this.removeOwned(name);
      throw error;
    }
  }
  async releaseFile(file: GeminiFile): Promise<void> {
    if (file.name) this.leases.set(file.name, Math.max(0, (this.leases.get(file.name) ?? 0) - 1));
    await this.prune();
  }
  async processFileOrThrow(file: GeminiFile, prompt: string, modelName: string, caller?: AbortSignal): Promise<GeminiResponse> {
    const signal = this.signal(caller);
    const response = await abortable(this.client.models.generateContent({
      model: modelName, contents: createUserContent([createPartFromUri(file.uri, file.mimeType), prompt]),
      config: { abortSignal: signal, maxOutputTokens: 8192,
        httpOptions: { timeout: this.limits.requestTimeoutMs, retryOptions: { attempts: 1 } } }
    }), signal);
    const text = response.text ?? '';
    if (Buffer.byteLength(text, 'utf8') > this.limits.maxResponseBytes) throw new Error('Provider response exceeds limit');
    return { text };
  }
  async processFile(file: GeminiFile, prompt: string, modelName = DEFAULT_GEMINI_MODEL): Promise<GeminiResponse> {
    try { return await this.processFileOrThrow(file, prompt, modelName); }
    catch { return { text: 'Error processing file: Gemini request failed.', isError: true }; }
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.expiryTimer);
    for (const upload of this.inFlightUploads.values()) upload.controller.abort();
    await Promise.allSettled([...this.inFlightUploads.values()].map(value => value.promise));
    this.inFlightUploads.clear();
    this.fileCache.clear();
    this.leases.clear();
    await Promise.all([...this.ownedFiles].map(name => this.removeOwned(name)));
  }
}
