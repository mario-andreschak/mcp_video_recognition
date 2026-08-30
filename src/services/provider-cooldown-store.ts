/**
 * status: active
 * phase: change-b-groups-4-5-recovery
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Bounded process-local provider/model cooldown state with caller-supplied time."
 * insights: "Nested maps keep tuple keys collision-safe; lazy cleanup and deterministic expiry/sequence eviction avoid timers, background loops, and persistent state."
 */

export interface ProviderModelCooldownStore {
  isCooling(provider: string, model: string, nowMs: number): boolean;
  recordTransientFailure(
    provider: string,
    model: string,
    nowMs: number,
    cooldownMs: number
  ): void;
}

interface CooldownEntry {
  readonly expiry: number;
  readonly sequence: number;
}

export const createProviderModelCooldownStore = (
  capacity = 64
): ProviderModelCooldownStore => {
  const maximumEntries = Number.isSafeInteger(capacity) && capacity > 0
    ? Math.min(capacity, 64)
    : 64;
  const entries = new Map<string, Map<string, CooldownEntry>>();
  let size = 0;
  let nextSequence = 0;

  const remove = (provider: string, model: string): void => {
    const models = entries.get(provider);
    if (models?.delete(model) !== true) return;
    size -= 1;
    if (models.size === 0) entries.delete(provider);
  };

  const removeExpired = (nowMs: number): void => {
    for (const [provider, models] of entries) {
      for (const [model, entry] of models) {
        if (nowMs >= entry.expiry) remove(provider, model);
      }
    }
  };

  const evictEarliest = (): void => {
    let selected: { provider: string; model: string; entry: CooldownEntry } | undefined;
    for (const [provider, models] of entries) {
      for (const [model, entry] of models) {
        if (selected === undefined
          || entry.expiry < selected.entry.expiry
          || (entry.expiry === selected.entry.expiry
            && entry.sequence < selected.entry.sequence)) {
          selected = { provider, model, entry };
        }
      }
    }
    if (selected !== undefined) remove(selected.provider, selected.model);
  };

  return {
    isCooling(provider, model, nowMs) {
      removeExpired(nowMs);
      return entries.get(provider)?.has(model) === true;
    },
    recordTransientFailure(provider, model, nowMs, cooldownMs) {
      removeExpired(nowMs);
      if (cooldownMs <= 0) {
        remove(provider, model);
        return;
      }
      const sum = nowMs + cooldownMs;
      const expiry = Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
      const existing = entries.get(provider)?.has(model) === true;
      if (existing) remove(provider, model);
      if (size >= maximumEntries) evictEarliest();
      let models = entries.get(provider);
      if (models === undefined) {
        models = new Map();
        entries.set(provider, models);
      }
      models.set(model, { expiry, sequence: nextSequence });
      nextSequence += 1;
      size += 1;
    }
  };
};
