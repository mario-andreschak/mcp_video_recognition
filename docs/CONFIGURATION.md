<!--
status: active
phase: docs-clarification
sprint: docs-realignment
last_modified: 2026-08-22
agent_notes: "Clarified recursive ALLOWED_MEDIA_ROOTS directory containment and parent folder usage."
insights: "ALLOWED_MEDIA_ROOTS containment is recursive; specifying a parent directory or workspace root allows all nested subdirectories and files. Multiple paths are delimited by path.delimiter."
-->

# Configuration Reference

Variable names and provider values are case-sensitive. Leading and trailing spaces get trimmed before values are read. Credentials never pick the provider for you.

## Provider Selection and Common Variables

| Variable | Required | Default | Rules |
|---|---:|---|---|
| `RECOGNITION_PROVIDER` | No | `gemini` | Must be `gemini` or `openai-compatible`. Leave it unset for Gemini. |
| `TRANSPORT_TYPE` | No | `stdio` | `sse` selects SSE; anything else uses stdio. |
| `PORT` | No | `3000` when SSE starts with no port set | Only used by the SSE transport. |
| `LOG_LEVEL` | No | `fatal` | One of `verbose`, `debug`, `info`, `warn`, `error`, or `fatal`. |

Only the selected provider's variables get checked. Bad values for the unselected one are ignored. Both credential sets can sit side by side; `RECOGNITION_PROVIDER` still decides which one runs.

## Gemini Variables

| Variable | Required | Default | Rules |
|---|---:|---|---|
| `GOOGLE_API_KEY` | When Gemini is selected | None | Must be non-empty after trimming. |
| `GEMINI_MODEL` | No | `gemini-3.5-flash` | One model name, up to 200 Unicode characters. |
| `GEMINI_MODEL_ALLOWLIST` | No | Unrestricted | Comma-separated exact model names. |

Gemini keeps its upload/cache processing path, and it keeps its video wait of up to 300 seconds. That wait can end in `GEMINI_VIDEO_PROCESSING_TIMEOUT`, so cut and chunk long videos to stay under it. `GEMINI_MODELS` is reserved for the opt-in recovery route and cannot be combined with `GEMINI_MODEL`.

## Gemini Recovery and Fallback

Gemini model recovery and the final OpenAI-compatible backup are opt-in. The [Provider Recovery Reference](RECOVERY.md) covers route setup, attempt and deadline behavior, backoff and process-local cooldown, cost and privacy notes, rollback order, and backup credential incidents.

### Gemini Recovery Example

Set `GEMINI_MODELS` to a comma-separated list of Gemini models, in the order you want them tried. The server starts with the first model and falls through to the next one on a retryable error (rate limit, server error, timeout). Leave `GEMINI_MODELS` unset and the server sticks to the single `GEMINI_MODEL` (or the default `gemini-3.5-flash`) with no fallback.

```json
{
  "mcpServers": {
    "video-recognition-gemini-recovery": {
      "command": "node",
      "args": [
        "/path/to/mcp-video-recognition/dist/index.js"
      ],
      "env": {
        "GOOGLE_API_KEY": "your_google_api_key",
        "GEMINI_MODELS": "gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash, gemini-3.5-flash-lite",
        "GEMINI_MAX_ATTEMPTS": "4",
        "GEMINI_COOLDOWN_SECONDS": "60",
        "LOG_LEVEL": "warn"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

The example above tries `gemini-3.7-flash`, then `gemini-3.6-flash`, then `gemini-3.5-flash`, then `gemini-3.5-flash-lite`. Each model gets at most one attempt, and the total across all models is capped by `GEMINI_MAX_ATTEMPTS`. A model that fails with a retryable error gets skipped for `GEMINI_COOLDOWN_SECONDS` (60 seconds here).

Want the optional OpenRouter backup too? Add `GEMINI_BACKUP_ENABLED=true` plus the full OpenAI-compatible config (see the OpenRouter example below). The backup runs at most once, after every Gemini model has failed or is in cooldown.

`docs/mcp-json-example/example-mcp.json` is a ready-to-use VS Code MCP config file.

## Full Example (All Variables)

This example shows every supported variable in one place. The Gemini and OpenAI-compatible sections are alternatives; `RECOGNITION_PROVIDER` picks between them. The values shown are defaults or placeholders, so adjust them to your setup.

`GEMINI_MODEL` and `GEMINI_MODELS` can't be combined - setting both fails startup. The two variants are shown separately below. Everything else is common to both.

Variant A - single Gemini model (`GEMINI_MODEL`), no recovery route:

```json
{
  "mcpServers": {
    "video-recognition-full": {
      "command": "node",
      "args": [
        "/path/to/mcp-video-recognition/dist/index.js"
      ],
      "env": {
        "RECOGNITION_PROVIDER": "gemini",
        "TRANSPORT_TYPE": "stdio",
        "PORT": "3000",
        "LOG_LEVEL": "fatal",

        "GOOGLE_API_KEY": "your_google_api_key",
        "GEMINI_MODEL": "gemini-3.5-flash",
        "GEMINI_MODEL_ALLOWLIST": "gemini-3.5-flash, gemini-3.7-flash",

        "GEMINI_BACKUP_ENABLED": "false",

        "OPENAI_COMPATIBLE_API_KEY": "your_openrouter_api_key",
        "OPENAI_COMPATIBLE_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_COMPATIBLE_MODEL": "your_openrouter_model_id",
        "OPENAI_COMPATIBLE_PROVIDER_LABEL": "OpenRouter",
        "OPENAI_COMPATIBLE_MODEL_ALLOWLIST": "",
        "OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS": "60",
        "OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES": "1048576",
        "MAX_INLINE_MEDIA_BYTES": "20971520",
        "ALLOWED_MEDIA_ROOTS": "/operator-controlled/media",
        "ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE": "false"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Variant B - Gemini recovery route (`GEMINI_MODELS`) with model fallback. Replace the `GEMINI_MODEL` line from Variant A with:

```json
        "GEMINI_MODELS": "gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash, gemini-3.5-flash-lite",
        "GEMINI_MAX_ATTEMPTS": "4",
        "GEMINI_RECOVERY_DEADLINE_SECONDS": "30",
        "GEMINI_BASE_BACKOFF_MS": "250",
        "GEMINI_MAX_BACKOFF_MS": "2000",
        "GEMINI_COOLDOWN_SECONDS": "60",
```

A few notes on combining variables:

- `GEMINI_MODEL` and `GEMINI_MODELS` can't be used together. Setting both fails startup.
- `GEMINI_BACKUP_ENABLED=true` needs the full OpenAI-compatible block, including `ALLOWED_MEDIA_ROOTS`.
- `ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE` only applies when `RECOGNITION_PROVIDER` is `openai-compatible`.
- Variables for the unselected provider are ignored (but both credential sets can be present).

## OpenAI-Compatible Variables

| Variable | Required | Default | Rules |
|---|---:|---|---|
| `OPENAI_COMPATIBLE_API_KEY` | Yes | None | Non-empty bearer credential. |
| `OPENAI_COMPATIBLE_BASE_URL` | Yes | None | An operator-controlled base URL; see the [Security Reference](SECURITY.md). |
| `OPENAI_COMPATIBLE_MODEL` | Yes | None | One model name, up to 200 Unicode characters. |
| `OPENAI_COMPATIBLE_PROVIDER_LABEL` | No | `OpenAI-compatible provider` | Up to 64 Unicode characters. |
| `OPENAI_COMPATIBLE_MODEL_ALLOWLIST` | No | Unrestricted | Comma-separated exact model names. |
| `OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS` | No | `60` | Whole number from `1` through `120`. |
| `OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES` | No | `1048576` | Whole number from `1024` through `4194304`. |
| `MAX_INLINE_MEDIA_BYTES` | No | `20971520` | Whole number from `1048576` through `104857600`. |
| `ALLOWED_MEDIA_ROOTS` | Yes | None | One or more existing operator-controlled directories, split by Node `path.delimiter`. |
| `ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE` | No | Disabled | After trimming, exact `true` enables allowed loopback HTTP. Exact `false`, unset, or empty disables it. Any other non-empty value fails startup. |

Numeric values must match `^[0-9]+$` (for example: `60` is valid, `60s` is not). be safe integers, and stay inside their inclusive ranges. Bad values stop startup.

When OpenAI-compatible is selected, any of these excluded aliases fails startup, even if empty: `MEDIA_ROOTS`, `OPENROUTER_API_KEY`, `OPENROUTER_MODELS`, or `OPENROUTER_RESPONSE_CACHE`.

## Model Allowlists

`GEMINI_MODEL_ALLOWLIST` and `OPENAI_COMPATIBLE_MODEL_ALLOWLIST` limit which models an MCP client may pick. Lists are split on commas, entries are trimmed, empty entries are dropped, and duplicates keep their first occurrence.

The effective model is the `modelname` argument when supplied, otherwise the provider's configured or default model. The allowlist check runs before file metadata, reads, encoding, uploads, or network access. A rejected model returns an `invalid-request: ProviderFailure`.

## Parallel Prompts and Merging Methods

`PARALLEL_PROMPTS` is a whole number from `1` through `8`, default `1`. A value outside that range fails startup. A value of `1` keeps the normal single-prompt behavior.

Set it above `1` and that many fixed prompt perspectives run against the same media. At most two variants run at the same time, and that concurrency is not configurable. Each label gets its own output section, joined by markdown dividers. A failing variant is tolerated unless all of them fail.

The eight perspectives, in order:

1. Baseline
2. Visual Details
3. Text & OCR
4. Temporal Sequence
5. Technical Composition
6. Contextual Analysis
7. Entity Counting
8. Key Takeaways

### Aggregation and Merging Strategies

When running multi-perspective parallel prompts, different aggregation strategies determine how perspective outputs are combined:

- **Perspective Aggregation (`all_return`)** *(Default implementation)*:
  Returns each perspective's output labeled with `### Perspective: <Label>` and joined by markdown dividers (`\n\n---\n\n`). This approach requires zero secondary inference tokens, introduces no synthesis latency, and preserves every granular detail across angles without risk of lossy LLM compression.

- **Header Stitching (`header_merge`)**:
  Aligns perspective outputs along shared markdown sections (e.g. `Summary`, `Observations`, `Temporal Sequence`, `Uncertainties`) and stitches corresponding sections into a unified report.

- **LLM Synthesis (`llm_merge`)**:
  Feeds all parallel perspective outputs into a secondary text-only LLM pass. The synthesis pass reconciles conflicting observations, deduplicates repetitive details, and generates a cohesive, unified report. If synthesis fails or is unsupported by the provider, the system gracefully falls back to structured perspective aggregation.

## OpenRouter Example

Use the generic OpenAI-compatible variables and set the base URL to `https://openrouter.ai/api/v1`. The server appends `/chat/completions` itself, so don't include that suffix. For the model, use something like `xiaomi/mimo-v2.5` or any other model from your OpenRouter account:

```json
{
  "mcpServers": {
    "video-recognition-openrouter": {
      "command": "node",
      "args": [
        "/path/to/mcp-video-recognition/dist/index.js"
      ],
      "env": {
        "RECOGNITION_PROVIDER": "openai-compatible",
        "OPENAI_COMPATIBLE_API_KEY": "your_openrouter_api_key",
        "OPENAI_COMPATIBLE_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_COMPATIBLE_MODEL": "your_openrouter_model_id",
        "OPENAI_COMPATIBLE_PROVIDER_LABEL": "OpenRouter",
        "ALLOWED_MEDIA_ROOTS": "/operator-controlled/media"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

`ALLOWED_MEDIA_ROOTS` uses `;` on Windows and `:` on POSIX. For example, `C:\\media;D:\\approved-media` on Windows or `/srv/media:/opt/approved-media` on POSIX. Containment is recursive, so pointing to a parent directory (or an agent/IDE variable like `${workspaceFolder}`) allows any media file inside its subdirectories without adding each folder manually.

## Supported Media and Request Shapes

| Provider | Modality | Extensions and MIME types | OpenAI-compatible wire part |
|---|---|---|---|
| Gemini | Image | `.jpg`, `.jpeg` -> `image/jpeg`; `.png` -> `image/png`; `.webp` -> `image/webp` | Not applicable |
| Gemini | Audio | `.wav` -> `audio/wav`; `.mp3` -> `audio/mp3`; `.ogg` -> `audio/ogg` | Not applicable |
| Gemini | Video | `.mp4` -> `video/mp4` | Not applicable |
| OpenAI-compatible | Image | `.jpg`, `.jpeg` -> `image/jpeg`; `.png` -> `image/png`; `.webp` -> `image/webp` | `image_url` containing a data URL |
| OpenAI-compatible | Audio | `.wav` -> `audio/wav`; `.mp3` -> `audio/mp3` | `input_audio` containing raw base64 and format `wav` or `mp3` |
| OpenAI-compatible | Video | `.mp4` -> `video/mp4`; `.mpeg` -> `video/mpeg`; `.mov` -> `video/mov`; `.webm` -> `video/webm` | `video_url` containing a data URL |

GIF and AVI are unsupported and get rejected before any network activity. OpenAI-compatible files larger than `MAX_INLINE_MEDIA_BYTES` are rejected before reading or base64 allocation. The inline size setting applies only to the OpenAI-compatible adapter; Gemini keeps its default API behavior.

The `video_url` content part is an **OpenRouter extension**. It won't work on every OpenAI-compatible endpoint, so confirm that yours, and your model, support it. Audio goes out as raw base64, not a data URL, and sends only the `wav` or `mp3` format value.

For OpenAI-compatible operation, the requested path must resolve to a regular file inside one of the allowed roots. Containment is recursive: any file located within an allowed root directory or its nested subdirectories is permitted. Traversal and symlink, junction, or reparse-point escapes are rejected. Links that canonicalize inside an allowed root are accepted.
