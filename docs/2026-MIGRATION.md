# Version 2 migration and operating limits

The three recognition tools, explicit model overrides, configured Gemini recovery/backup and parallel perspectives are retained. Dependencies move to split MCP SDK 2.0.0, Google GenAI 2.21.0, Zod 4.5.4 and Node 22+.

## Protocol and deployment

Stdio supports the actual 2026-07-28 protocol and deliberately accepts 2025 initialization. HTTP /mcp supports sessionless modern requests and stateless 2025 Streamable HTTP. TRANSPORT_TYPE=sse remains a Streamable HTTP alias; there is no /sse endpoint. Stateful legacy reconnect/resume is not advertised. Stateless legacy HTTP cancellation must close the active response; a separate cancellation notification cannot identify another request. Stdio handles cancellation ID zero explicitly because SDK 2.0.0 otherwise ignores it.

HTTP requires MCP_AUTH_TOKEN (32+ characters) and ALLOWED_MEDIA_ROOTS, including for Gemini. It binds 127.0.0.1 by default. All HTTP requests require the bearer token, exact Host validation and exact Origin validation when present. MCP_ALLOWED_HOSTS and MCP_ALLOWED_ORIGINS accept comma-separated exact values for a controlled reverse proxy. No wildcard CORS is enabled. Terminate TLS before exposing HTTP beyond loopback; never put a token in a URL.

This is a single-owner deployment. Clients with the same token intentionally share the configured provider account, upload cache and cooldowns. Unknown tokens are rejected before provider access. Separate owners require separate processes, credentials, tokens and media roots. Responses use Cache-Control: no-store. MCP lists receive zero-TTL/private defaults. There are no public media download/list routes, remote-URL tools, tasks, subscriptions, sampling or elicitation features.

Limits: 1 MiB HTTP request body, 64 HTTP connections, eight active tool calls, six-minute total call deadline. Media paths are resolved within configured roots; symlink escapes are rejected. ALLOWED_MEDIA_ROOTS also confines stdio when set. Local filesystem owners remain trusted: do not allow untrusted local users to mutate roots or their ancestors.

## Providers

The retained gemini-3.5-flash default is stable and supports text/image/audio/video input. GEMINI_MODEL, GEMINI_MODELS, GEMINI_MODEL_ALLOWLIST and explicit modelname remain configurable. OpenAI-compatible endpoint/model configuration is mandatory for that provider. Its video_url part is an endpoint extension: not every compatible endpoint accepts video.

References: [Gemini 3.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash), [Google SDKs](https://ai.google.dev/gemini-api/docs/libraries), [MCP SDK 2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2), [modern protocol migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).

## Media and cancellation

Uploads use a bounded file snapshot, so file growth after stat cannot bypass the byte cap. Upload preparation is shared between callers; one cancellation does not stop another caller's upload. Cancelling the final waiter aborts shared preparation. Generation leases prevent expiry from deleting a file still in use. Expiry, failed processing, late completion after cancellation and shutdown attempt deletion only of this instance's owned files. A full cache rejects new uploads instead of evicting active data.

| Variable | Default | Range |
|---|---:|---:|
| GEMINI_MAX_UPLOAD_BYTES | 33554432 | 1024–268435456 |
| GEMINI_REQUEST_TIMEOUT_MS | 120000 | 1000–120000 |
| GEMINI_PROCESSING_TIMEOUT_MS | 300000 | 1000–300000 |
| GEMINI_MAX_RESPONSE_BYTES | 1048576 | 1024–4194304 |
| GEMINI_MAX_CACHED_FILES | 16 | 1–64 |
| GEMINI_CACHE_TTL_MS | 3600000 | 0–86400000 |

The existing recovery deadline bounds generation/retry/backup after upload preparation. Generation sets maxOutputTokens=8192 and bounds returned text. Upload metadata and OpenAI-compatible response bodies have incremental byte caps. Google SDK generation/get/delete JSON parsing remains SDK-managed; GEMINI_MAX_RESPONSE_BYTES is not a cap on its intermediate JSON allocation. Calls and polling have deadlines and cancellation. Recovery owns retries instead of multiplying SDK retries.

Google SDK 2.21.0 files.upload does not forward abortSignal and replaces resumable-upload defaults when httpOptions are supplied. google-upload.ts therefore uses the documented Files REST upload endpoints, rejects redirects and foreign upload origins, and keeps credentials out of URLs. Generation, status and deletion use the current SDK. Wire-shaped mocks exercise the complete lifecycle.

Deletion is best effort with a three-second bound. A crash, or cancellation after provider acceptance before receipt of a file identifier, can prevent immediate deletion. [Google Files documentation](https://ai.google.dev/gemini-api/docs/files) specifies automatic deletion after 48 hours. [Google cancellation documentation](https://googleapis.github.io/js-genai/release_docs/interfaces/types.UploadFileConfig.html) states client cancellation does not stop service-side work or charges.

Verbose logging excludes media paths, checksums, remote URIs, prompts, bytes, results and upstream exception bodies. The compatibility processFile wrapper now returns a fixed safe error.

## Verification

npm run check covers types, lint and the original provider/recovery suite plus modern/legacy transport and media regressions. Three pre-existing external OpenSpec document tests remain explicitly skipped when their separate workspace is absent.

npm run test:package installs the actual tarball into a clean consumer and exercises all three tools with a local provider mock over real modern and legacy stdio, invalid inputs, ID-zero cancellation, stdout privacy and EOF. Docker acceptance runs the same installed artifact as an unprivileged user with external networking disabled. CI covers Node 22/24 Linux and Node 24 Windows.

No real provider keys or paid requests are used by CI. After reviewing a small non-sensitive file and configuring a key/model, an operator can run the standalone client with --tool and --args for a paid canary. Listing tools is free of provider requests. Mocked tests do not prove account access, quota or recognition quality.
