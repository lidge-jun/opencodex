# 020 — Video bridge on grok-imagine-video-1.5 / 1.5-lite

Evidence: [001](./001_live_evidence.md#video-docsxai). Commit: `feat(videos): support Grok Imagine Video 1.5, 1080p and pinned frames`.

## Decisions

- Default `videoBridgeModel`: `grok-imagine-video-1.5-lite`. xAI recommends it for simple videos and
  it is the cheapest per second at 480p/720p ($0.02 vs $0.05 for the classic model). 1080p on Lite is
  an upscale billed about $0.14/s (live: $0.14 for one second). Frame pins and references need
  `grok-imagine-video-1.5`; the docs explain how to switch.
- The tool advertises only what the configured model accepts. Models outside the table keep exactly
  today's surface (prompt, duration, 480p/720p, the existing seven aspect ratios, no image inputs).
- Image inputs (first frame, last frame, keyframes, references) accept `https://` URLs,
  `data:image/(png|jpeg|webp);base64,` URLs up to 10 MiB decoded, and references to images the image
  bridge produced in this process. No local file is ever read: when the image bridge downloads an xAI
  result (`url` response format) it records `artifact id → original xAI https URL` in a bounded
  process-local map (256 entries, one-hour lifetime). A video input given as the opaque artifact URL
  `/v1/opencodex/artifacts/<id>`, an absolute path or a `file:` URL is used only as a lookup key: its
  basename must match the artifact id pattern and the map must hold that id for exactly that resolved
  path; the recorded xAI URL is what gets sent. Anything else (relative paths, unknown ids, `http:`,
  other schemes, inline-base64 results that have no source URL) is a tool error. Filesystem races and
  Windows path semantics therefore cannot widen what is sent. The recorded URL is an xAI temporary
  URL created for this proxy's own xAI credential, so it is only sent to the pinned xAI destination:
  with a custom `images.videoProvider` an artifact reference is a tool error (callers may still pass
  their own https/data URLs). xAI may expire the URL before the map entry; that surfaces as the
  upstream failure. Results returned as `b64_json` have no source URL and cannot be referenced.

## Changes

### NEW `src/images/video-capabilities.ts`

```ts
export interface VideoModelCapabilities { resolutions: readonly string[]; aspectRatios: readonly string[];
  firstFrame: boolean; lastFrame: boolean; maxKeyframes: number; maxReferenceImages: number;
  referenceMaxResolution?: string; }
export function videoModelCapabilities(model: string): VideoModelCapabilities
// grok-imagine-video-1.5 (+ -preview, -2026-05-30): 480p/720p/1080p, 9 ratios, first+last, 4 keyframes,
//   14 references, references capped at 720p
// grok-imagine-video-1.5-lite: 480p/720p/1080p, 9 ratios, first frame only
// grok-imagine-video: 480p/720p, 9 ratios, first frame, 7 references
// other: 480p/720p, the legacy 7 ratios, no image inputs
```

### NEW `src/images/video-image-input.ts` and MODIFY `src/images/fulfill.ts`

`rememberArtifactSourceUrl(path, url)` / `resolveVideoImageInput(value: unknown, now?)` implementing the
rule above. `fulfill.ts` calls `rememberArtifactSourceUrl` after `downloadImageToArtifact` succeeds (not
for `b64_json` results).

### MODIFY `src/images/synthetic-tool.ts`

`buildVideoTool(model?: string)` derives `resolution` / `aspect_ratio` enums and adds `image`,
`last_frame`, `keyframes` (`{image, timestamp_s}`, maxItems), `reference_images` (maxItems) only when
supported; `sidecar-execution.ts` passes `vidPlan.model`.

### MODIFY `src/images/fulfill-video.ts`

`ParsedVideoArgs` adds `image?`, `lastFrame?`, `keyframes?: {image; timestampS}[]`, `referenceImages?`.
`parseVideoCallArgs(raw, model?)`:
- resolution / aspect ratio validated against the model's capabilities;
- prompt required unless a frame or reference is present;
- a field the model does not support → `"<field> is not supported by <model>"`; over the keyframe or
  reference limit → error; keyframe needs finite `timestamp_s > 0` (and `< duration` when given);
  references with 1080p on 1.5 → `"reference_images are limited to 720p"`.
`pollVideoWithHeartbeats`: failed → `video generation failed: <code>: <detail>` (code from `safeVideoFailureCode`, detail from `safeXaiErrorDetail`; unmatched messages omitted); the retry `console.warn` stays status-only.

### MODIFY `src/images/xai-video-client.ts`

Default model `grok-imagine-video-1.5-lite`. Submit body adds `image: {url}`, `last_frame: {url}`,
`keyframes: [{image: {url}, timestamp_s}]`, `reference_images: [{url}]`. Non-2xx submit/poll append
`readSafeXaiErrorDetail`. Poll parses `error.code` (allowlist of the five documented codes) and
`error.message` into `XaiVideoPollResult.error`.

### MODIFY `src/images/plan.ts`, `src/images/loop.ts`, `src/types/config.ts`

Default constant; loop resolves each image input with `resolveVideoImageInput` before submit (error →
tool result, no upstream call) and passes the plan model to `parseVideoCallArgs`; config comment.

## Tests (failing first)

- `tests/videos/fulfill-video.test.ts`: 1080p on 1.5/lite accepted and on classic/unknown rejected; 21:9
  accepted on 1.5; unknown model keeps the old enums; last_frame on lite rejected; five keyframes
  rejected; prompt optional with a frame; references + 1080p rejected; failed poll shows code + detail.
- `tests/videos/xai-video-client.test.ts`: xAI body shape for the new inputs; default model; 400 detail.
- New `tests/videos/video-capabilities.test.ts`: tool schema per model, unknown model unchanged.
- New `tests/videos/video-image-input.test.ts`: https and data URLs accepted; http, relative paths,
  unknown ids, a known id under a different path, expired entries and oversized data URLs rejected; an
  artifact URL, absolute path and `file:` URL of a remembered image resolve to the recorded xAI URL;
  the map stays bounded.
- `tests/videos/plan-video.test.ts`: default model.

## Docs

`guides/video-bridge.md` in all nine locales: default model and the model table (1.5 / 1.5-lite /
classic) with prices, 1080p (native vs upscale, R2V 720p cap), aspect ratios, the new arguments and
the image-input rule.

## Structure

Covered by the `structure/data-planes/images.md` section added in 010 (video capability table and
image-input rule); update `src/images/xai-video-client.ts` comments (resolution list).

## Verify

`bun test tests/videos tests/images`, `bun test tests/ci-workflows/docs-spanish-localization.test.ts tests/ci-workflows/docs-link-targets.test.ts`, `bun run structure:check`, `bun run typecheck`, `bun run test:changed`.
