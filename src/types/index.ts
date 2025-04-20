/**
 * Type definitions for the MCP server
 */

import { z } from 'zod';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Common parameters for all recognition tools
 */
export const RecognitionParamsSchema = z.object({
  filepath: z.string().describe('Path to the media file to analyze'),
  prompt: z.string().default('Describe this content').describe('Custom prompt for the recognition'),
  modelname: z.string().default('gemini-2.0-flash').describe('Gemini model to use for recognition')
});

export type RecognitionParams = z.infer<typeof RecognitionParamsSchema>;

/**
 * Video recognition specific types
 */
export const VideoRecognitionParamsSchema = RecognitionParamsSchema.extend({});
export type VideoRecognitionParams = z.infer<typeof VideoRecognitionParamsSchema>;

/**
 * Image recognition specific types
 */
export const ImageRecognitionParamsSchema = RecognitionParamsSchema.extend({});
export type ImageRecognitionParams = z.infer<typeof ImageRecognitionParamsSchema>;

/**
 * Audio recognition specific types
 */
export const AudioRecognitionParamsSchema = RecognitionParamsSchema.extend({});
export type AudioRecognitionParams = z.infer<typeof AudioRecognitionParamsSchema>;

/**
 * Tool definitions
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  callback: (args: any) => Promise<CallToolResult>;
}

/**
 * Gemini API types
 */
export interface GeminiConfig {
  apiKey: string;
}

export interface GeminiFile {
  uri: string;
  mimeType: string;
}

export interface GeminiResponse {
  text: string;
  isError?: boolean;
}
