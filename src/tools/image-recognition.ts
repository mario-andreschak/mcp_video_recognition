/**
 * Image recognition tool for MCP server
 * status: active
 * phase: change-b-group-6-observability
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-08
 * agent_notes: "Tool logs fixed actions and uses the shared secure failure mapper."
 * insights: "Request paths/prompts/results and caught errors never reach Logger or terminal MCP content."
 */

import { createLogger } from '../utils/logger.js';
import { mapRecognitionToolFailure } from './recognition-tool-failure.js';
import { ImageRecognitionParamsSchema } from '../types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ImageRecognitionParams } from '../types/index.js';
import type { RecognitionProvider, RecognitionRequest } from '../types/provider.js';

const log = createLogger('ImageRecognitionTool');

export const createImageRecognitionTool = (provider: RecognitionProvider) => {
  return {
    name: 'image_recognition',
    description: 'Analyze and describe images using the configured recognition provider',
    inputSchema: ImageRecognitionParamsSchema,
    callback: async (args: ImageRecognitionParams, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
      try {
        log.info('Processing image recognition request');

        const request: RecognitionRequest = {
          filepath: args.filepath,
          prompt: args.prompt,
          mediaKind: 'image',
          model: args.modelname
        };

        log.info('Generating content from image...');
        const result = await provider.recognize(request, { signal: extra.signal });

        log.info('Image recognition completed successfully');

        return {
          content: [
            {
              type: 'text',
              text: result.text
            }
          ]
        };
      } catch (error) {
        const failure = mapRecognitionToolFailure(error, 'image');
        log.error(failure.operatorMessage);

        return {
          content: [
            {
              type: 'text',
              text: `Error processing image: ${failure.terminalMessage}`
            }
          ],
          isError: true
        };
      }
    }
  };
};
