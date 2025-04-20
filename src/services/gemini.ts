/**
 * Service for interacting with Google's Gemini API
 */

import { 
  GoogleGenerativeAI,
  GenerativeModel,
  Part,
  FileData
} from '@google/generative-ai';
import { createLogger } from '../utils/logger.js';
import type { GeminiConfig, GeminiFile, GeminiResponse } from '../types/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const log = createLogger('GeminiService');

export class GeminiService {
  private readonly client: GoogleGenerativeAI;
  private readonly models: Map<string, GenerativeModel> = new Map();

  constructor(config: GeminiConfig) {
    this.client = new GoogleGenerativeAI(config.apiKey);
    log.info('Initialized Gemini service');
  }

  /**
   * Get or create a model instance
   */
  private getModel(modelName: string): GenerativeModel {
    if (!this.models.has(modelName)) {
      log.debug(`Creating new model instance for ${modelName}`);
      const model = this.client.getGenerativeModel({ model: modelName });
      this.models.set(modelName, model);
      return model;
    }
    return this.models.get(modelName)!;
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
      
      // Read file as binary data
      const fileData = await fs.promises.readFile(filePath);
      
      // For now, we'll simulate the file upload since the SDK doesn't support it directly
      // In a real implementation, you would use a proper file upload mechanism
      log.info(`File read successfully: ${filePath}`);
      
      return {
        uri: `file://${filePath}`,
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
      log.verbose('Processing with parameters', { file, prompt, modelName });
      
      const model = this.getModel(modelName);
      
      // Create parts for the content
      const parts: Part[] = [
        { text: prompt },
        { fileData: { mimeType: file.mimeType, fileUri: file.uri } as FileData }
      ];
      
      const response = await model.generateContent(parts);
      
      log.debug('Received response from Gemini API');
      log.verbose('Gemini API response', JSON.stringify(response));
      
      return {
        text: response.response.text()
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
