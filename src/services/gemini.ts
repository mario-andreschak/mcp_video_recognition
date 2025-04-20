/**
 * Service for interacting with Google's Gemini API
 */

import { 
  GoogleGenAI,
  createUserContent,
  createPartFromUri
} from '@google/genai';
import { createLogger } from '../utils/logger.js';
import type { GeminiConfig, GeminiFile, GeminiResponse } from '../types/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const log = createLogger('GeminiService');

export class GeminiService {
  private readonly client: GoogleGenAI;

  constructor(config: GeminiConfig) {
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
    log.info('Initialized Gemini service');
  }

  /**
   * Upload a file to Gemini API
   */
  async uploadFile(filePath: string): Promise<GeminiFile> {
    try {
      log.debug(`Uploading file: ${filePath}`);
      
      // Determine MIME type based on file extension
      const ext = path.extname(filePath).toLowerCase();
      let mimeType: string;
      
      if (['.jpg', '.jpeg'].includes(ext)) {
        mimeType = 'image/jpeg';
      } else if (ext === '.png') {
        mimeType = 'image/png';
      } else if (ext === '.webp') {
        mimeType = 'image/webp';
      } else if (ext === '.mp4') {
        mimeType = 'video/mp4';
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
      
      if (!uploadedFile.uri) {
        throw new Error('File upload failed: No URI returned');
      }
      
      return {
        uri: uploadedFile.uri,
        mimeType
      };
    } catch (error) {
      log.error('Error uploading file', error);
      throw error;
    }
  }

  /**
   * Process a file with Gemini API
   */
  async processFile(file: GeminiFile, prompt: string, modelName: string): Promise<GeminiResponse> {
    try {
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
      
      const responseText = response.text || '';
      
      return {
        text: responseText
      };
    } catch (error) {
      log.error('Error processing file with Gemini API', error);
      return {
        text: `Error processing file: ${error instanceof Error ? error.message : String(error)}`,
        isError: true
      };
    }
  }
}
