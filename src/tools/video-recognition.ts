/**
 * Video recognition tool for MCP server
 */

import { z } from 'zod';
import { createLogger } from '../utils/logger.js';
import { GeminiService } from '../services/gemini.js';
import { VideoRecognitionParamsSchema, FileState } from '../types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VideoRecognitionParams } from '../types/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const log = createLogger('VideoRecognitionTool');

export const createVideoRecognitionTool = (geminiService: GeminiService) => {
  return {
    name: 'video_recognition',
    description: 'Analyze and describe videos using Google Gemini AI',
    inputSchema: VideoRecognitionParamsSchema,
    callback: async (args: VideoRecognitionParams): Promise<CallToolResult> => {
      try {
        log.info(`Processing video recognition request for file: ${args.filepath}`);
        log.verbose('Video recognition request', JSON.stringify(args));
        
        // Verify file exists
        if (!fs.existsSync(args.filepath)) {
          throw new Error(`Video file not found: ${args.filepath}`);
        }
        
        // Verify file is a video
        const ext = path.extname(args.filepath).toLowerCase();
        if (ext !== '.mp4' && ext !== '.mpeg' && ext !== '.mov' && ext !== '.avi' && ext !== '.webm') {
          throw new Error(`Unsupported video format: ${ext}. Supported formats are: .mp4, .mpeg, .mov, .avi, .webm`);
        }
        
        // Default prompt if not provided
        const prompt = args.prompt || 'Describe this video';
        const modelName = args.modelname || 'gemini-2.0-flash';
        
        // Upload the file - this will handle waiting for video processing
        log.info('Uploading and processing video file...');
        const file = await geminiService.uploadFile(args.filepath);
        
        // Process with Gemini
        log.info('Video processing complete, generating content...');
        const result = await geminiService.processFile(file, prompt, modelName);
        
        if (result.isError) {
          log.error(`Error in video recognition: ${result.text}`);
          return {
            content: [
              {
                type: 'text',
                text: result.text
              }
            ],
            isError: true
          };
        }
        
        log.info('Video recognition completed successfully');
        log.verbose('Video recognition result', JSON.stringify(result));
        
        return {
          content: [
            {
              type: 'text',
              text: result.text
            }
          ]
        };
      } catch (error) {
        log.error('Error in video recognition tool', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        return {
          content: [
            {
              type: 'text',
              text: `Error processing video: ${errorMessage}`
            }
          ],
          isError: true
        };
      }
    }
  };
};
