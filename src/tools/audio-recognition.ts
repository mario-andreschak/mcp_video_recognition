/**
 * Audio recognition tool for MCP server
 * status: active
 * phase: change-b-group-6-observability
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-08
 * agent_notes: "Tool logs fixed actions and uses the shared secure failure mapper."
 * insights: "Request paths/prompts/results and caught errors never reach Logger or terminal MCP content."
 */

import { createLogger } from '../utils/logger.js';
import { mapRecognitionToolFailure } from './recognition-tool-failure.js';
import { AudioRecognitionParamsSchema } from '../types/index.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AudioRecognitionParams } from '../types/index.js';
import type { RecognitionProvider, RecognitionRequest } from '../types/provider.js';

const log = createLogger('AudioRecognitionTool');

export const createAudioRecognitionTool = (provider: RecognitionProvider) => {
  return {
    name: 'audio_recognition',
    description: 'Analyze and transcribe audio using the configured recognition provider',
    inputSchema: AudioRecognitionParamsSchema,
    callback: async (args: AudioRecognitionParams, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
      try {
        log.info('Processing audio recognition request');

        const request: RecognitionRequest = {
          filepath: args.filepath,
          prompt: args.prompt,
          mediaKind: 'audio',
          model: args.modelname
        };

        log.info('Generating content from audio...');
        const result = await provider.recognize(request, { signal: extra.signal });

        log.info('Audio recognition completed successfully');

        return {
          content: [
            {
              type: 'text',
              text: result.text
            }
          ]
        };
      } catch (error) {
        const failure = mapRecognitionToolFailure(error, 'audio');
        log.error(failure.operatorMessage);

        return {
          content: [
            {
              type: 'text',
              text: `Error processing audio: ${failure.terminalMessage}`
            }
          ],
          isError: true
        };
      }
    }
  };
};
