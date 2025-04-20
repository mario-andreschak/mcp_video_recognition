/**
 * Audio recognition tool for MCP server
 */

import { z } from 'zod';
import { createLogger } from '../utils/logger.js';
import { GeminiService } from '../services/gemini.js';
import { AudioRecognitionParamsSchema } from '../types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AudioRecognitionParams } from '../types/index.js';

const log = createLogger('AudioRecognitionTool');

export const createAudioRecognitionTool = (geminiService: GeminiService) => {
  return {
    name: 'audio_recognition',
    description: 'Analyze and transcribe audio using Google Gemini AI',
    inputSchema: AudioRecognitionParamsSchema,
    callback: async (args: AudioRecognitionParams): Promise<CallToolResult> => {
      try {
        log.info(`Processing audio recognition request for file: ${args.filepath}`);
        log.verbose('Audio recognition request', JSON.stringify(args));
        
        // Default prompt if not provided
        const prompt = args.prompt || 'Describe this audio';
        const modelName = args.modelname || 'gemini-2.0-flash';
        
        // Upload the file
        const file = await geminiService.uploadFile(args.filepath);
        
        // Process with Gemini
        const result = await geminiService.processFile(file, prompt, modelName);
        
        if (result.isError) {
          log.error(`Error in audio recognition: ${result.text}`);
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
        
        log.info('Audio recognition completed successfully');
        log.verbose('Audio recognition result', JSON.stringify(result));
        
        return {
          content: [
            {
              type: 'text',
              text: result.text
            }
          ]
        };
      } catch (error) {
        log.error('Error in audio recognition tool', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        return {
          content: [
            {
              type: 'text',
              text: `Error processing audio: ${errorMessage}`
            }
          ],
          isError: true
        };
      }
    }
  };
};
