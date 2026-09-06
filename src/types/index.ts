/**
 * Type definitions for the MCP server
 * status: active
 * phase: checkpoint-3-schema-default-ownership
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-02
 * agent_notes: "RecognitionParamsSchema is the sole omitted-prompt default owner."
 * insights: "modelname remains optional and is forwarded as undefined when omitted."
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Common parameters for all recognition tools
 */
export const RecognitionParamsSchema = z.object({
  filepath: z.string().min(1).max(4096).describe('Path to the media file to analyze'),
  prompt: z.string().max(65536).default('Describe this content').describe('Custom prompt for the recognition'),
  modelname: z.string().min(1).max(200).optional().describe('Model override to use for recognition')
});

export type {
  MediaKind,
  ProviderCallOptions,
  ProviderFailure,
  ProviderFailureCategory,
  RecognitionProvider,
  RecognitionRequest,
  RecognitionResult
} from './provider.js';

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
  inputSchema: z.ZodObject<z.ZodRawShape>;
  callback: (args: unknown) => Promise<CallToolResult>;
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
  name?: string;
  state?: string;
}

export interface ProcessedGeminiFile {
  uri: string;
  mimeType: string;
  name: string;
  state: string;
}

export interface CachedFile {
  fileId: string;
  checksum: string;
  uri: string;
  mimeType: string;
  name: string;
  state: string;
  timestamp: number;
}

// File states from Gemini API
export enum FileState {
  UNSPECIFIED = 'STATE_UNSPECIFIED',
  PROCESSING = 'PROCESSING',
  ACTIVE = 'ACTIVE',
  FAILED = 'FAILED'
}

export interface GeminiResponse {
  text: string;
  isError?: boolean;
}
