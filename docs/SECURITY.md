# Security Reference

The [README](../README.md) has the short version. This file holds the full endpoint, transport, resource, and credential rules.

## Endpoint and Transport Rules

- HTTPS is required by default.
- Plain HTTP works only at exact loopback, and only when `ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE` trims to exact `true`. The URL host must be exactly `localhost`, `127.0.0.1`, or `[::1]` (parsed as `::1`). For example, `" true "` works after trimming. `localhost.`, `127/8`, IPv4-mapped IPv6, other IPv6 addresses, and DNS names don't qualify.
- Loopback HTTP sends credentials and media in cleartext on the local network stack. Turn it on only for a local endpoint you trust, and turn it off when you're done.
- The base URL may use HTTPS, or the explicitly enabled loopback HTTP exception. Nothing else. After trimming, it must not contain control characters, whitespace, URL user-info, query, or fragment.
- Trailing path slashes are stripped, and one `/chat/completions` suffix is appended. A configured path that already ends in the case-sensitive suffix `/chat/completions` fails startup.
- The endpoint origin is operator configuration. Tool callers can't override it.
- Requests run with `redirect: 'manual'`. Every 3xx response is rejected, never followed, so credentials and media don't get forwarded elsewhere.

## Resource and Diagnostic Bounds

- The OpenAI-compatible HTTP timer covers fetch, response headers, and bounded response-body reading. Local path validation, file reading, and base64 encoding sit outside it.
- Responses are read incrementally up to `OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES`. Going over the cap stops the read and returns a bounded `malformed-response` failure.
- Inline media is bounded by `MAX_INLINE_MEDIA_BYTES` before read/base64 allocation.
- Model names are limited to 200 Unicode characters; provider labels to 64. Both reject C0 controls, DEL, U+2028, and U+2029.
- Provider `safeMessage` strings are fixed, free of line separators, and under 4 KiB.
- That limit is not a general escaping or 4 KiB cap on logger output or non-provider errors. `LOG_LEVEL` defaults to `fatal`; use higher log levels only in a controlled environment. Raw credentials, authorization headers, response bodies, prompts, paths, data URLs, and encoded media never appear in `ProviderFailure` safe messages.

## Credentials and Incident Response

Keep provider credentials in the MCP process environment or a secret manager. Never put real keys in source control. If a credential or endpoint may be compromised:

1. Disable the affected provider or stop the affected server instances.
2. Revoke the exposed key at the provider.
3. Rotate in replacement credentials.
4. Remove stale secrets from MCP client configuration, deployment configuration, and secret stores.
5. Restart every affected server instance with the replacement configuration.
6. Check the server's bounded diagnostics for failure categories and timing. Don't copy secrets or media into incident records.

You own the `ALLOWED_MEDIA_ROOTS` boundary. It applies to the OpenAI-compatible provider and to the Gemini backup path; Gemini-only operation without backup doesn't enforce it. Configure only narrow, operator-controlled directories. Broad user, temporary, filesystem-root, or attacker-writable directories are off the table.

## Attempt and Cancellation Semantics

Without opt-in Gemini recovery configuration, each tool call keeps the one-model, one-attempt behavior. Recovery stays sequential and bounded, and there's no silent model or provider substitution.

Parallel inference is opt-in via `PARALLEL_PROMPTS` (see the [Configuration Reference](CONFIGURATION.md#parallel-prompts)). A value above 1 runs fixed prompt perspectives against the same media, bounded to at most two variants at a time.

That means multiple provider calls per tool call, so expect more cost, latency, and quota use.

The [Provider Recovery Reference](RECOVERY.md) has the exact opt-in attempt, timing, cooldown, and final-backup semantics.

For OpenAI-compatible calls, a caller abort maps to `cancelled` / `CALLER_CANCELLED`, and expiration of the adapter's private timer maps to `timeout` / `ADAPTER_TIMEOUT`. Gemini keeps its 300000 ms video-processing wait, which maps to `timeout` / `GEMINI_VIDEO_PROCESSING_TIMEOUT`. Gemini has no adapter-wide deadline.
