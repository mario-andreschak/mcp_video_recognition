/**
 * Service for interacting with Google's Gemini API
 * status: active
 * phase: checkpoint-4-gemini-adapter
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-21
 * agent_notes: "Throwing generation seam and owned video-timeout identity; legacy wrapper remains compatible. R3 added pre-cache FAILED rejection for every media kind."
 * insights: "processFileOrThrow preserves original throws; remove the omitted-model bridge at checkpoint 7. R3: FAILED-state is rejected before any checksum-cache insertion so a stale URI cannot survive settlement; the in-flight promise is evicted by the uploadFile finally so the next call retries."
 */

import { 
  GoogleGenAI,
  createUserContent,
  createPartFromUri
} from '@google/genai';
import { createLogger } from '../utils/logger.js';
import { DEFAULT_GEMINI_MODEL } from './provider-config.js';
import type { GeminiConfig, GeminiFile, GeminiResponse, CachedFile, ProcessedGeminiFile } from '../types/index.js';
import { FileState } from '../types/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { setTimeout } from 'timers/promises';

const log = createLogger('GeminiService');

export class GeminiVideoProcessingTimeoutError extends Error {}

export class GeminiService {
  private readonly client: GoogleGenAI;
  private fileCache = new Map<string, CachedFile>();
  private inFlightUploads = new Map<string, Promise<GeminiFile>>();
  private readonly cacheExpiration = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

  constructor(config: GeminiConfig) {
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
    log.info('Initialized Gemini service');
  }

  /**
   * Calculate checksum for a file
   */
  private async calculateChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath);
      
      stream.on('error', err => reject(err));
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  /**
   * Check if a file exists in cache and is still valid
   */
  private isCacheValid(checksum: string): boolean {
    const cachedFile = this.fileCache.get(checksum);
    if (!cachedFile) return false;
    
    const now = Date.now();
    const isExpired = now - cachedFile.timestamp > this.cacheExpiration;
    
    return !isExpired;
  }

  /**
   * Get file from Gemini API by name
   */
  async getFile(name: string): Promise<GeminiFile> {
    try {
      const file = await this.client.files.get({ name });
      log.debug(`Retrieved file details for ${name}`);
      log.verbose('File details', JSON.stringify(file));
      
      if (!file.uri || !file.mimeType) {
        throw new Error(`Invalid file data returned for ${name}`);
      }
      
      return {
        uri: file.uri,
        mimeType: file.mimeType,
        name: file.name,
        state: file.state?.toString()
      };
    } catch (error) {
      log.error(`Error retrieving file ${name}`, error);
      throw error;
    }
  }

  /**
   * Wait for a video file to be processed
   */
  async waitForVideoProcessing(file: GeminiFile, maxWaitTimeMs = 300000): Promise<ProcessedGeminiFile> {
    if (!file.name) {
      throw new Error('File name is required to check processing status');
    }

    log.info(`Waiting for video processing: ${file.name}`);
    
    const startTime = Date.now();
    let currentFile = file;
    
    while (currentFile.state !== FileState.ACTIVE) {
      // Check if we've exceeded the maximum wait time
      if (Date.now() - startTime > maxWaitTimeMs) {
        throw new GeminiVideoProcessingTimeoutError(
          `Timeout waiting for video processing: ${file.name}`
        );
      }
      
      // Wait 2 seconds before checking again
      await setTimeout(2000);
      
      // Get updated file status
      currentFile = await this.getFile(file.name);
      log.debug(`Video processing status: ${currentFile.state}`);
      
      if (currentFile.state === FileState.FAILED) {
        throw new Error(`Video processing failed: ${file.name}`);
      }
    }
    
    log.info(`Video processing completed: ${file.name}`);
    
    // Ensure all required fields are present
    if (!currentFile.name || !currentFile.state) {
      throw new Error('Missing required file information after processing');
    }
    
    return {
      uri: currentFile.uri,
      mimeType: currentFile.mimeType,
      name: currentFile.name,
      state: currentFile.state
    };
  }

  /**
   * Upload a file to Gemini API with caching
   */
  async uploadFile(filePath: string): Promise<GeminiFile> {
    const existingPromise = this.inFlightUploads.get(filePath);
    if (existingPromise) {
      log.info(`Coalescing with in-flight upload for: ${filePath}`);
      return existingPromise;
    }

    const uploadPromise = this._doUploadFile(filePath);
    this.inFlightUploads.set(filePath, uploadPromise);

    try {
      return await uploadPromise;
    } finally {
      this.inFlightUploads.delete(filePath);
    }
  }

  private async _doUploadFile(filePath: string): Promise<GeminiFile> {
    try {
      log.debug(`Processing file upload request: ${filePath}`);
      
      // Calculate checksum for caching
      const checksum = await this.calculateChecksum(filePath);
      log.debug(`File checksum: ${checksum}`);
      
      // Check if file is in cache and still valid
      const cachedFile = this.fileCache.get(checksum);
      if (cachedFile && this.isCacheValid(checksum)) {
        log.info(`Using cached file: ${cachedFile.name}`);
        
        // Return cached file info
        return {
          uri: cachedFile.uri,
          mimeType: cachedFile.mimeType,
          name: cachedFile.name,
          state: cachedFile.state
        };
      }
      
      // Determine MIME type based on file extension
      const ext = path.extname(filePath).toLowerCase();
      let mimeType: string;
      let isVideo = false;
      
      if (['.jpg', '.jpeg'].includes(ext)) {
        mimeType = 'image/jpeg';
      } else if (ext === '.png') {
        mimeType = 'image/png';
      } else if (ext === '.webp') {
        mimeType = 'image/webp';
      } else if (ext === '.mp4') {
        mimeType = 'video/mp4';
        isVideo = true;
      } else if (ext === '.mp3') {
        mimeType = 'audio/mp3';
      } else if (ext === '.wav') {
        mimeType = 'audio/wav';
      } else if (ext === '.ogg') {
        mimeType = 'audio/ogg';
      } else {
        throw new Error(`Unsupported file extension: ${ext}`);
      }
      
      // Upload file to Google's servers
      const uploadedFile = await this.client.files.upload({
        file: filePath,
        config: { mimeType }
      });
      
      log.info(`File uploaded successfully: ${filePath}`);
      log.verbose('Uploaded file details', JSON.stringify(uploadedFile));
      
      if (!uploadedFile.uri || !uploadedFile.name) {
        throw new Error('File upload failed: Missing URI or name');
      }
      
      // Create file object
      const file: GeminiFile = {
        uri: uploadedFile.uri,
        mimeType,
        name: uploadedFile.name,
        state: uploadedFile.state?.toString()
      };

      // R3: Reject every supported media kind whose immediate upload state is FAILED
      // BEFORE any checksum-based completed-cache insertion. The polling loop already
      // throws on FAILED for videos; this guarantees image/audio/poll-already-ACTIVE
      // paths do not cache a dead URI. The in-flight promise is evicted by the caller's
      // `finally` so a subsequent call re-attempts the upload afresh.
      if (file.state === FileState.FAILED) {
        throw new Error(`Gemini file upload failed: ${file.name ?? filePath}`);
      }

      // For videos, wait for processing to complete
      if (isVideo && file.state === FileState.PROCESSING) {
        const processedFile = await this.waitForVideoProcessing(file);

        // Update cache with processed file
        this.fileCache.set(checksum, {
          fileId: processedFile.name,
          checksum,
          uri: processedFile.uri,
          mimeType: processedFile.mimeType,
          name: processedFile.name,
          state: processedFile.state,
          timestamp: Date.now()
        });

        return processedFile;
      }
      
      // Add to cache
      if (!file.name) {
        throw new Error('File name is required for caching');
      }
      
      this.fileCache.set(checksum, {
        fileId: file.name,
        checksum,
        uri: file.uri,
        mimeType: file.mimeType,
        name: file.name,
        state: file.state || FileState.ACTIVE,
        timestamp: Date.now()
      });
      
      return file;
    } catch (error) {
      log.error('Error uploading file', error);
      throw error;
    }
  }

  /**
   * Process a file with Gemini API and preserve generation failures
   */
  async processFileOrThrow(
    file: GeminiFile,
    prompt: string,
    modelName: string
  ): Promise<GeminiResponse> {
    log.debug(`Processing file with model ${modelName}`);
    log.verbose('Processing with parameters', JSON.stringify({ file, prompt, modelName }));

    const response = await this.client.models.generateContent({
      model: modelName,
      contents: createUserContent([
        createPartFromUri(file.uri, file.mimeType),
        prompt
      ])
    });

    log.debug('Received response from Gemini API');
    log.verbose('Gemini API response', JSON.stringify(response));

    return {
      text: response.text || ''
    };
  }

  /**
   * Compatibility wrapper for direct service callers
   */
  async processFile(file: GeminiFile, prompt: string, modelName?: string): Promise<GeminiResponse> {
    try {
      return await this.processFileOrThrow(file, prompt, modelName ?? DEFAULT_GEMINI_MODEL);
    } catch (error) {
      log.error('Error processing file with Gemini API', error);
      return {
        text: `Error processing file: ${error instanceof Error ? error.message : String(error)}`,
        isError: true
      };
    }
  }
}
