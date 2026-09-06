/**
 * Video recognition tool for MCP server
 * status: active
 * phase: change-b-group-6-observability
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-08
 * agent_notes: "Tool logs fixed actions and uses the shared secure failure mapper."
 * insights: "Request paths/prompts/results and caught errors never reach Logger or terminal MCP content."
 */

import { createLogger } from '../utils/logger.js';
import { mapRecognitionToolFailure } from './recognition-tool-failure.js';
import { VideoRecognitionParamsSchema } from '../types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { VideoRecognitionParams } from '../types/index.js';
import type { RecognitionProvider, RecognitionRequest } from '../types/provider.js';

const log = createLogger('VideoRecognitionTool');

export const createVideoRecognitionTool = (provider: RecognitionProvider) => {
  return {
    name: 'video_recognition',
    description: 'Analyze and describe videos using the configured recognition provider',
    inputSchema: VideoRecognitionParamsSchema,
    callback: async (args: VideoRecognitionParams, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
      try {
        log.info('Processing video recognition request');

        const request: RecognitionRequest = {
          filepath: args.filepath,
          prompt: args.prompt,
          mediaKind: 'video',
          model: args.modelname
        };

        log.info('Generating content from video...');
        const result = await provider.recognize(request, { signal: extra.signal });

        log.info('Video recognition completed successfully');

        return {
          content: [
            {
              type: 'text',
              text: result.text
            }
          ]
        };
      } catch (error) {
        const failure = mapRecognitionToolFailure(error, 'video');
        log.error(failure.operatorMessage);

        return {
          content: [
            {
              type: 'text',
              text: `Error processing video: ${failure.terminalMessage}`
            }
          ],
          isError: true
        };
      }
    }
  };
};
