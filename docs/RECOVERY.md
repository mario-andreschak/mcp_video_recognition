# Provider Recovery Reference

This is the operator guide for Gemini model recovery and the optional OpenAI-compatible backup. Provider selection, credentials, endpoint safety, media containment, and the base provider variables live in the [main README](../README.md#configuration).

Recovery is off by default. Only configuration turns it on; it's never inferred from credentials. Any fallback you enable can add latency, provider calls, and cost. It can also widen who your data is shared with.

## Route and Configuration Semantics

There's no default fallback route and no hard-coded model chain.

- With no `GEMINI_MODELS`, an unpinned call invokes the configured `GEMINI_MODEL` or the default model exactly once.
- One unique candidate in `GEMINI_MODELS` is still a one-candidate route and gets invoked at most once. Multiple candidates are trimmed, deduplicated, and tried in declared order.
- A tool call with an explicit `modelname` is pinned to that model for one attempt. The pin skips route position and cooldown for the current call, never falls through to another Gemini model or provider, and doesn't change the configured route. A transient pinned failure can still cool that model for later unpinned calls.
- Structured HTTP 403 evidence and billing failures always fail fast. Billing, quota, exhausted, rate, retry, or allowlisted-looking body prose never permits a later candidate or backup.
- Backup credentials alone don't enable backup. You need `GEMINI_BACKUP_ENABLED=true`, and the canonical OpenAI-compatible settings must all be complete: `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL`, and `ALLOWED_MEDIA_ROOTS`. Any other switch value fails startup. Leaving it out or setting `false` keeps backup disabled. Unused backup settings are ignored.

The recovery controls:

| Variable | Default | Allowed values and behavior |
|---|---:|---|
| `GEMINI_MODELS` | No list | Comma-separated ordered Gemini candidates. Can't be supplied with `GEMINI_MODEL`. |
| `GEMINI_MAX_ATTEMPTS` | `4` | Integer from `1` through `8`; shared by started Gemini and backup invocations. |
| `GEMINI_RECOVERY_DEADLINE_SECONDS` | `30` | Integer from `1` through `120`; soft deadline for starting recovery work after preparation. |
| `GEMINI_BASE_BACKOFF_MS` | `250` | Integer from `0` through `5000`. |
| `GEMINI_MAX_BACKOFF_MS` | `2000` | Integer from `0` through `10000`, not less than the base backoff. |
| `GEMINI_COOLDOWN_SECONDS` | `60` | Integer from `0` through `600`. |
| `GEMINI_BACKUP_ENABLED` | `false` | Exact `true` enables a completely configured final backup; exact `false` disables it. |

Bad recovery values stop startup. Nothing is clamped, rounded, coerced, or swapped for a default.

## Attempts, Deadlines, and Backoff

Media validation, preparation, upload, and Gemini video processing all happen before recovery starts, and they keep their independent 300-second timeout.

Only started provider invocations count as attempts, and total Gemini request invocations can't exceed `GEMINI_MAX_ATTEMPTS`.

The 60-second default request timeout applies only to the OpenAI-compatible adapter, where it's capped at 120 seconds. Gemini has no adapter-wide timeout.

The recovery deadline only gates when a new candidate can start. An in-flight Gemini request isn't cancelled when the deadline passes, and its late success still counts as the tool result.

Eligible transitions use capped exponential backoff. A valid adapter-normalized `retryAfterMs` replaces the normal backoff but is still capped by `GEMINI_MAX_BACKOFF_MS`.

## Conservative HTTP 429 Policy

Every exact structured HTTP 429 is treated as transient under the unchanged allowlist. Routing does not guess a quota subtype (RPM, TPM, daily/RPD, spend, project/shared, or any other) from provider prose, uncharacterized SDK fields, or arbitrary JSON.

Gemini candidates can share project quota, so daily, spend, project/shared, or other long-window exhaustion can burn through later configured Gemini attempts without recovering. The wasted cost stays bounded by the attempt cap and the recovery start deadline. That trade is deliberate: bounded attempts beat routing decisions inferred from provider prose.

Re-run the SDK characterization and request-count gate whenever the resolved `@google/genai` version changes, including a later resolution inside the declared version range. One router attempt must stay one upstream request. If a later SDK silently retries, turn those retries off - or count every underlying request against the same `GEMINI_MAX_ATTEMPTS` cap before the change can pass verification.

## Process-Local Cooldown

Transient Gemini and transient backup failures share one in-memory cooldown, keyed by provider and model and shared across requests and callers in a single process. One caller's transient failure can make a later unpinned call skip that candidate. Pins bypass cooldown for their own attempt but can still create or refresh cooldown for later unpinned calls.

The cooldown holds at most 64 entries, expires lazily, never polls, and dies with the process. When full, the earliest-expiring entry is evicted; insertion order breaks equal-expiry ties. Separate processes or instances share nothing. An all-cooling route stops immediately, or considers the explicitly enabled backup within the remaining budget - it never waits for capacity.

## Optional Final Backup

The OpenAI-compatible backup is an explicitly enabled, optional, last-resort path. It is not a recovery guarantee. It runs at most once: when every Gemini candidate transiently failed or was skipped for an active cooldown, no fail-fast condition occurred, and no `modelname` pin was supplied. Attempt and deadline budget must also remain.

Picking a backup model is on you: it must support the requested image, audio, or video kind. The server has no capability registry, runs no capability probe, silently substitutes no model, and never forwards or translates a Gemini pin to backup. Unsupported media fails fast under the backup adapter's normalized category.

Backup can be unavailable, reject the modality, share exhausted project or long-window limits, or fail under its own quota or timeout. It adds latency and cost. It may also send your prompt and media to a different endpoint with different privacy, retention, residency, and billing terms. Read those terms, and check your configured `ALLOWED_MEDIA_ROOTS`, before you turn it on.

Backup is always the final attempt. Authentication, permission, HTTP 403, billing, unsupported-media, safety, invalid-request, malformed-response, and unknown backup failures are all final: no second backup, provider, or delay follows. A transient backup failure also creates process-local cooldown, which can suppress backup on later requests in that process.

## Rollback

For an immediate operational rollback, set `GEMINI_BACKUP_ENABLED=false`, remove `GEMINI_MODELS` and the other recovery settings, and restart every instance. That puts unpinned Gemini calls back to the canonical one-model, one-attempt behavior. Disabling recovery does not revoke any credential.

Rolling back code has a mandatory order:

1. Disable backup and all recovery configuration in every deployment.
2. Remove the Gemini recovery implementation.
3. Rerun the provider abstraction feature's provider, configuration, tool, transport, and compatibility tests.
4. Only after those tests pass, restore direct Gemini injection if that's the earlier architecture you want.

The Gemini recovery feature must not be rolled back while the provider abstraction feature is still installed.

## Backup Credential Incident Response

If backup credentials may be exposed or a backup endpoint may be misrouted, do these in order:

1. **Disable backup** in every affected deployment so no further backup egress starts.
2. **Revoke** each affected credential at the provider.
3. **Rotate** replacement credentials through your approved secret-management process.
4. **Remove stale secrets** from MCP client configuration, deployment configuration, environment sources, and secret stores.
5. **Restart every affected instance** to load the replacements and drop process-local cooldown and in-memory configuration state.
6. **Inspect only sanitized diagnostics** for attempt categories, models, timing, and routing outcomes. Never copy credentials, authorization values, prompts, paths, media, encoded content, provider bodies, or unsanitized messages into incident records.

Disabling backup is containment, not revocation. Finish all the steps even when backup is already off.