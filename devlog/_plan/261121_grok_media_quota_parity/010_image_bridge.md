# 010 — Image bridge on grok-imagine-image-2.0

Evidence: [001](./001_live_evidence.md#images-docsxai). Commit: `feat(images): default the Grok image bridge to grok-imagine-image-2.0 and send quality`.

## Changes

### NEW `src/images/xai-upstream-error.ts` (shared with 020)

Only messages that parse into a closed vocabulary reach the caller, and the caller receives a
canonical message rebuilt from the parsed tokens, never the upstream string. No pattern accepts
free text: every captured token is either a member of a fixed set or a bounded number.

```ts
const QUALITY_TOKENS = new Set(["low", "medium", "high", "auto"]);
const FIELD_TOKENS = new Set(["image", "last_frame", "keyframes", "reference_images", "reference_audios",
  "quality", "aspect_ratio", "resolution", "duration"]);
const RESOLUTION_TOKENS = new Set(["480p", "720p", "1080p"]);
// Each rule: exact regex over the trimmed upstream string, token checks, canonical builder.
//  quality list   /^This model only supports the following quality value\(s\): ([a-z]+(?:, [a-z]+)*)\.$/
//                 every token in QUALITY_TOKENS → "This model only supports the following quality value(s): <tokens joined by ', '>."
//  field          /^`([a-z_]+)` is not supported for this model\.$/ with token in FIELD_TOKENS
//  resolution     /^(\d{3,4}p) video resolution is not available for this model\.$/ with token in RESOLUTION_TOKENS
//  keyframe count /^Too many keyframes: (\d{1,2})\. Maximum allowed is (\d{1,2})\.$/
//  keyframe time  /^`keyframes` timestamp (\d{1,3}(?:\.\d{1,3})?)s must be strictly inside the clip \(0 < t < (\d{1,3}(?:\.\d{1,3})?)s\)\./
//                 → canonical sentence with the two numbers
const SAFE_VIDEO_FAILURE_CODES = new Set(["invalid_argument","permission_denied","failed_precondition","service_unavailable","internal_error"]);
/** Canonical caller-visible detail, or undefined. Never logged. */
export function safeXaiErrorDetail(message: unknown): string | undefined
/** Reads a bounded JSON error body (`readDisplaySafeErrorPayloadText`) and applies safeXaiErrorDetail
 *  to `error` / `error.message` / `message`. */
export async function readSafeXaiErrorDetail(resp: Response, signal?: AbortSignal): Promise<string | undefined>
export function safeVideoFailureCode(code: unknown): string | undefined
```
Unmatched text, HTML and the 422 deserializer text yield no detail, so the error stays
`xAI images API returned 400`. Logs (`console.warn`, request-log fields) stay status-only.
Tests: each live message maps to its canonical form; adversarial values that fit the shape but not
the vocabulary ("secret words" as a quality list, `my_prompt` as a field, `999p`, a prompt fragment,
an `xai-` key, a path or a URL in any slot) yield undefined; unknown text and HTML bodies add nothing.

### MODIFY `src/images/xai-client.ts`

1. Default model and edit sources:
   ```diff
   -  model?: string; // default "grok-imagine-image-quality"
   +  model?: string; // default "grok-imagine-image-2.0"
   +  /** Extra edit sources after imageUrl; together they form images[] (at most 5). */
   +  imageUrls?: string[];
   -const XAI_DEFAULT_MODEL = "grok-imagine-image-quality";
   +export const XAI_DEFAULT_IMAGE_MODEL = "grok-imagine-image-2.0";
   +export const XAI_MAX_EDIT_IMAGES = 5;
   ```
2. Aspect ratios: literals = the live-validated set; the size map gains `2:3`/`3:2` so OpenAI's
   1024x1536 / 1536x1024 map exactly:
   ```ts
   const XAI_ASPECT_RATIOS = [["1:1",1],["3:4",.75],["4:3",4/3],["9:16",.5625],["16:9",16/9],["2:3",2/3],["3:2",1.5]];
   const XAI_ASPECT_RATIO_LITERALS = new Set([...XAI_ASPECT_RATIOS.map(([l]) => l),
     "9:19.5","19.5:9","9:20","20:9","1:2","2:1","21:9","5:2"]);
   ```
3. Quality (exported for tests):
   ```ts
   /** xAI quality for models that accept it (2.0 only, per docs); undefined omits the field. */
   export function mapQualityToXaiQuality(model: string, quality?: string): "low" | "medium" | "auto" | undefined {
     if (!quality || !/^grok-imagine-image-2(\.|-|$)/.test(model)) return undefined;
     const q = quality.toLowerCase();
     if (q === "low" || q === "standard") return "low";
     if (q === "medium" || q === "high" || q === "hd") return "medium"; // 2.0 answers 400 to "high"
     if (q === "auto") return "auto";
     return undefined;
   }
   ```
   `callXaiImages`: `const xq = mapQualityToXaiQuality(String(body.model), req.quality); if (xq) body.quality = xq;`.
   Resolution mapping is unchanged (high/hd → 2k, low/standard/auto → 1k).
4. Edits: sources = `[imageUrl, ...imageUrls]` (trimmed, non-empty, deduplicated). More than
   `XAI_MAX_EDIT_IMAGES` throws `{status: 400, message: "xAI image edits accept at most 5 images"}`
   before any fetch. One source → `image: {url, type: "image_url"}` (unchanged); several →
   `images: [{url, type: "image_url"}, ...]`.
5. Non-2xx: `const detail = await readSafeXaiErrorDetail(resp, linkedSignal)` (replaces the bare
   cancel) → message `xAI images API returned 400: <detail>` when present; `err.status` unchanged.
   Redirects are unchanged.

### MODIFY `src/images/plan.ts`, `src/server/images.ts`, `src/types/config.ts`

Replace the `"grok-imagine-image-quality"` constants with `XAI_DEFAULT_IMAGE_MODEL`; update the
`bridgeModel` comment.

### MODIFY `src/server/images.ts` (`tryXaiImageRelay`, edits branch)

Collect every source in order: string `image`, string `image_url`, then each `images[]` entry
(string, or object with `image_url` string / `image_url.url` / `url`). Over five → 400
`invalid_request_error` "xAI image edits accept at most 5 images" (no upstream call). First →
`imageUrl`, rest → `imageUrls`. The existing catch already sanitizes and URL-scrubs `err.message`.

### MODIFY `src/images/synthetic-tool.ts`

`aspect_ratio` enum adds `2:3`, `3:2`, `21:9`, `5:2`; new optional
`quality: {type: "string", enum: ["low","medium","auto"]}`.

## Tests (failing first)

`tests/images/xai-client.test.ts`:
- default model `grok-imagine-image-2.0`;
- quality high → medium, hd → medium, low → low, auto → auto on 2.0; omitted for
  `grok-imagine-image` and for unknown values;
- 1024x1536 → 2:3; 21:9 literal forwarded; the literal-set test updated to the new contract;
- two sources → `images[]`; six sources reject with 400 and no fetch;
- a JSON 400 whose `error` matches a template surfaces it; unmatched JSON text and HTML bodies add nothing.

`tests/images/plan.test.ts`: default bridge model.
`tests/server/server-images.test.ts:213`: update the expected default in place (same line count).
New `tests/server/server-images-xai-relay.test.ts` (layout + expected shard): multi-image edit
forwarding, six images → 400 without upstream, upstream 400 text in the relay error body.

## Docs

`docs-site/src/content/docs/{,es/,fr/,ja/,ko/,ru/,tr/,zh-cn/,zh-tw/}guides/image-bridge.md`:
default `grok-imagine-image-2.0`; `quality` low/medium/auto is forwarded (OpenAI high/hd → medium);
the retired `grok-imagine-image-quality` (and `-pro`, already redirected to it since 2026-05-15) is
served as 2.0 low; price depends on quality × resolution, edits add $0.01 per input image; edits take
up to five images.

## Structure

`structure/data-planes/images.md` gains an "xAI image and video models" section: default models,
quality mapping, edit-source limit, video capability table, image-input rule and the error-detail
allowlist. Check the other `src/images/` owners (`structure/runtime.md`, `structure/transports/inventory.md`)
for stale defaults; `bun run structure:check` must pass.

## Verify

`bun test tests/images` and, in a separate Bun process (a module mock in `tests/images/plan.test.ts`
leaks into the server file when they share one), `bun test tests/server/server-images.test.ts tests/server/server-images-xai-relay.test.ts`;
`bun test tests/ci-workflows/docs-spanish-localization.test.ts tests/ci-workflows/docs-link-targets.test.ts`, `bun run structure:check`, `bun run typecheck`, `bun run test:changed`.
