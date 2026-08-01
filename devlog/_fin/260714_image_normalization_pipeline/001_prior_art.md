# 001 — Prior art: how Claude Code and open-source proxies handle Anthropic image limits

Research record, 2026-07-14. Sources: local corpus `/Users/jun/Developer/codex/150_claude_code`
(reconstructed official Claude Code source), gh code/issue search, hosted web search.
Tier legend per cxc-search: Tier 2 = source opened/verified, Tier 1 = candidate, unopened.

## 1. Anthropic API limits (verified)

| Limit | Value | Unit | Evidence |
|---|---|---|---|
| Per-image size | 5MiB (5,242,880) | **base64 string length, NOT raw bytes** | Claude Code `src/constants/apiLimits.ts:22` — "The API rejects images where the base64 string length exceeds this value"; comment says verified against Anthropic internal `api/api/schemas/messages/blocks/` (2025-12-22). Tier 2 (corpus) |
| Total request | ~32MB raw HTTP body | serialized bytes (base64 chars count 1:1) | `apiLimits.ts:52` PDF comment; anthropics/claude-code #13823, #6434. Tier 2 |
| Image count | 100/request hard cap | — | `apiLimits.ts:100` API_MAX_MEDIA_PER_REQUEST (client-validated for clear errors). Tier 2 |
| Dimensions | >20 images ⇒ 2000px/side; ≤20 ⇒ 8000px; server auto-resizes >1568px | px | `apiLimits.ts:33-43` (server resize per `encoding/full_encoding.py`); our guard header comment. Tier 2 |

Consequence for our code: wp2 fixes Rule 1b, which currently compares DECODED bytes
(>5MiB decoded ⇔ ~6.99MiB base64) — images in the 5.24–6.99MiB-base64 gap pass the guard
and then 400 upstream.

## 2. Official Claude Code (corpus, all Tier 2)

Three-layer design — ingestion normalization, preflight validation, reactive recovery:

- **Ingestion normalization** (`src/utils/imageResizer.ts:169-260`,
  `maybeResizeAndDownsampleImageBuffer`, used by paste/FileRead/BashTool/MCP paths):
  sharp (native libvips). Pass-through when raw ≤ 3.75MB (`IMAGE_TARGET_RAW_SIZE` =
  5MiB×3/4 so base64 ≤ 5MiB) AND ≤2000px. Otherwise: PNG `compressionLevel 9 + palette`
  first (transparency preserved) → JPEG quality ladder 80/60/40/20 → dimension resize.
  Friendly `ImageResizeError`; sharp module-load failures classified for analytics
  (`imageResizer.ts:52-125`).
- **Preflight validation**: media count (100) checked client-side for a clear error
  instead of the confusing API one (`apiLimits.ts:95-100`); image size errors thrown
  before the API call (`services/api/errors.ts:445-448`).
- **Reactive 413 recovery** (`src/query.ts:1060-1180`): the streaming loop WITHHOLDS the
  API error, then (1) drains staged context-collapses and retries
  (`CONTEXT_COLLAPSE`, transition `collapse_drain_retry`); (2) reactive compact —
  history summarization; media-size rejections skip the collapse drain and use compact's
  **strip-retry** (strips images); (3) single-shot guard `hasAttemptedReactiveCompact`
  prevents spirals; (4) on failure, surfaces the error WITHOUT running stop hooks
  (documented death-spiral rationale, `query.ts:1155-1160`). Background pain: issues
  #13823, #6434, #10314 (413 infinite loop).
- PDFs: raw target 20MB (32MB budget note), >3MB extracted to page images
  (`apiLimits.ts:47-77`).

## 3. Open-source proxy survey

| Project | Mechanism | Evidence | Tier |
|---|---|---|---|
| claude-code-router (musistudio) | Per-image byte cap, clear-error REJECT; no resize/trim | `packages/core/src/mcp/fusion-vision-mcp.ts` — throws `Local image exceeds ${maxLocalImageBytes} bytes`; i18n pattern in `contracts/i18n.ts` | 2 (gh code search, lines read) |
| LiteLLM (BerriAI) | Inbound size middleware (`max_request_size_mb`) → own 413 REJECT; 413→`request_too_large` mapping in Anthropic-compatible surface; no image mutation (`max_pixels` search: no anthropic-path resize) | `litellm/proxy/middleware/request_size_limit_middleware.py`, `anthropic_interface/exceptions/exception_mapping_utils.py` | 2 |
| y-router | Thin CF Worker relay; PASSTHROUGH, platform/upstream 413 surfaces | web survey; no size-handling code found | 1 |
| one-api / new-api | PASSTHROUGH; no resize/trim feature found | web survey | 1 |
| opencodex (ours, pre-unit) | Count/dimension guard + 20MiB base64 budget with oldest-first textify (devlog/260714_anthropic_413_image_budget) | `src/adapters/anthropic-image-guard.ts` | 2 |

**Pattern:** proxies reject or pass through; only the official CLIENT mutates content
(resize at ingestion, strip/compact on failure). Proxy-side graceful degradation (ours)
has essentially no prior art — hence wp3 designs it from the client playbook instead of
copying a proxy.

## 4. Runtime capability probe (Tier 2, this machine)

- Repo pins bun `1.3.14` (`package.json` engines + packageManager); `bun --version` matches.
- `bun -e 'console.log(typeof Bun.Image)'` → `function` — `Bun.Image`
  (sharp-compatible pipeline, libjpeg-turbo/spng/libwebp, zero native addons, added in
  1.3.14) is available in the pinned runtime.
- sharp fallback: official Bun support via Node-API v9 (sharp install docs; known friction
  is `bun --compile` standalone binaries — not our execution model).
- OPEN (wp3 B-phase probe): exact `Bun.Image` API shape; decode coverage for GIF (incl.
  animated) and WebP; behavior on corrupt input. Recorded results gate the sharp-fallback
  decision (P amendment if needed).

## 5. What we deliberately do NOT copy

- **Reactive compact (history summarization)** — changes conversation semantics; that is
  the client's right, not the proxy's. Codex has its own compaction.
- **Files API** — the fundamentally better fix for repeat-send, but a separate feature
  unit (beta headers, upload lifecycle, cleanup); out of scope here.
