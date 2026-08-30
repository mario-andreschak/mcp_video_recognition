/**
 * status: active
 * phase: change-b-group-6-observability
 * sprint: gemini-model-recovery
 * last_modified: 2026-08-08
 * agent_notes: "Validates runtime media kind before I/O and separates recovery terminal diagnostics from operator safeMessage."
 * insights: "One store is shared by each provider instance. Recovery terminal provenance is private WeakMap state owned by recovery-diagnostics."
 */

import path from 'node:path';
import type { RecognitionProvider, RecognitionRequest, ProviderCallOptions } from '../types/provider.js';
import {
  GeminiService,
  GeminiVideoProcessingTimeoutError
} from './gemini.js';
import {
  isValidProviderIdentifier,
  type GeminiProviderConfig
} from './provider-config.js';
import { createProviderFailure } from './provider-failure.js';
import { normalizeGeminiGenerationFailure } from './gemini-error-classifier.js';
import {
  createProviderModelCooldownStore,
  type ProviderModelCooldownStore
} from './provider-cooldown-store.js';
import { runPreparedGeminiRoute } from './gemini-recovery-router.js';
import {
  createRecoveryTerminalFailure,
  isMediaKind,
  type RecoveryDiagnosticSink
} from './recovery-diagnostics.js';
import { canonicalizeContainedFile } from './openai-compatible-recognition-provider.js';

const supportedExtensions = {
  image: new Set(['.jpg', '.jpeg', '.png', '.webp']),
  audio: new Set(['.wav', '.mp3', '.ogg']),
  video: new Set(['.mp4'])
} as const;

const mapGeminiPreparationFailure = (cause: unknown): Error => {
  if (cause instanceof GeminiVideoProcessingTimeoutError) {
    return createProviderFailure({
      provider: 'gemini',
      category: 'timeout',
      safeMessage: 'Gemini video processing timed out.',
      code: 'GEMINI_VIDEO_PROCESSING_TIMEOUT',
      cause
    });
  }

  return createProviderFailure({
    provider: 'gemini',
    category: 'unknown',
    safeMessage: 'Gemini request failed.',
    cause
  });
};

export class GeminiRecognitionProvider implements RecognitionProvider {
  private readonly cooldowns: ProviderModelCooldownStore;

  constructor(
    private readonly service: GeminiService,
    private readonly config: GeminiProviderConfig,
    private readonly runtime: {
      readonly now?: () => number;
      readonly sleep?: (ms: number) => Promise<void>;
      readonly cooldowns?: ProviderModelCooldownStore;
      readonly backupProvider?: RecognitionProvider;
      readonly diagnosticSink?: RecoveryDiagnosticSink;
    } = {}
  ) {
    this.cooldowns = runtime.cooldowns ?? createProviderModelCooldownStore();
  }

  async recognize(request: RecognitionRequest, options?: ProviderCallOptions) {
    if (options?.signal?.aborted === true) {
      throw createProviderFailure({
        provider: 'gemini',
        category: 'cancelled',
        safeMessage: 'Gemini request was cancelled.',
        code: 'CALLER_CANCELLED'
      });
    }

    const pin = request.model;
    const requestedModel = pin ?? this.config.model;
    if (!isValidProviderIdentifier(requestedModel, 200)) {
      throw createProviderFailure({
        provider: 'gemini',
        category: 'invalid-request',
        safeMessage: 'Requested model is invalid.'
      });
    }
    if (this.config.modelAllowlist !== undefined && !this.config.modelAllowlist.includes(requestedModel)) {
      throw createProviderFailure({
        provider: 'gemini',
        category: 'invalid-request',
        safeMessage: 'Requested model is not allowed.'
      });
    }

    if (!isMediaKind(request.mediaKind)) {
      throw createProviderFailure({
        provider: 'gemini',
        category: 'invalid-request',
        safeMessage: 'Requested media kind is invalid.'
      });
    }
    const mediaKind = request.mediaKind;

    const extension = path.extname(request.filepath).toLowerCase();
    if (!supportedExtensions[mediaKind].has(extension)) {
      throw createProviderFailure({
        provider: 'gemini',
        category: 'unsupported-media',
        safeMessage: 'Gemini does not support this media format.'
      });
    }

    let canonicalFilepath = request.filepath;
    if (this.config.recovery.backup.enabled) {
      canonicalFilepath = await canonicalizeContainedFile(
        request.filepath,
        this.config.recovery.backup.providerConfig.allowedMediaRoots
      );
    }

    let file;
    try {
      file = await this.service.uploadFile(canonicalFilepath);
    } catch (cause) {
      throw mapGeminiPreparationFailure(cause);
    }
    const now = this.runtime.now ?? Date.now;
    const sleep = this.runtime.sleep ?? (async (ms: number) => {
      await new Promise<void>(resolve => setTimeout(resolve, ms));
    });
    const backupProvider = this.runtime.backupProvider;
    const outcome = await runPreparedGeminiRoute({
      mediaKind,
      candidates: pin === undefined ? this.config.recovery.modelRoute : [requestedModel],
      pinned: pin !== undefined,
      maxAttempts: this.config.recovery.maxAttempts,
      deadlineSeconds: this.config.recovery.deadlineSeconds,
      deadlineStartedAt: now(),
      baseBackoffMs: this.config.recovery.baseBackoffMs,
      maxBackoffMs: this.config.recovery.maxBackoffMs,
      cooldownSeconds: this.config.recovery.cooldownSeconds
    }, {
      now,
      sleep,
      cooldowns: this.cooldowns,
      diagnosticSink: this.runtime.diagnosticSink,
      ...(this.config.recovery.backup.enabled && backupProvider !== undefined
        ? {
            backup: {
              provider: this.config.recovery.backup.providerConfig.providerLabel,
              model: this.config.recovery.backup.providerConfig.model,
              invoke: () => backupProvider.recognize({
                filepath: canonicalFilepath,
                prompt: request.prompt,
                mediaKind
              }, options)
            }
          }
        : {}),
      invokePreparedModel: async model => {
        try {
          const response = await this.service.processFileOrThrow(file, request.prompt, model);
          return { text: response.text };
        } catch (cause) {
          throw normalizeGeminiGenerationFailure(cause);
        }
      }
    });
    if (outcome.kind === 'success') return outcome.result;
    if (outcome.kind === 'fail-fast') throw outcome.failure;
    throw createRecoveryTerminalFailure({
      provider: 'gemini',
      category: outcome.reason === 'envelope-unusable' ? 'malformed-response' : 'temporary-service',
      mediaKind,
      reason: outcome.reason,
      attempts: outcome.attempts
    });
  }
}