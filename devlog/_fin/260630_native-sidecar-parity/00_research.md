# Native sidecar parity — web_search and vision/image-read investigation

Date: 2026-06-30
Status: research recorded; no implementation applied in this doc.

## Question

Can opencodex sidecars make routed providers look native in Codex UI, instead
of only feeding sidecar output back to the routed model as plain text?

## Web search sidecar

### Current opencodex behavior

- `src/web-search/loop.ts` intercepts the synthetic `web_search` tool call.
- `src/web-search/executor.ts` runs a real hosted `web_search` through the
  ChatGPT forward `/responses` backend.
- `src/web-search/parse.ts` extracts final text and URL citations.
- The result is injected back into the routed model as a tool result.
- The synthetic web-search call is not relayed to Codex, so the UI does not get
  a native `Searched the web` item.

### codex-rs consumer trace

codex-rs already understands native web-search activity:

- `codex-rs/protocol/src/models.rs`
  - `ResponseItem::WebSearchCall`
  - wire type: `web_search_call`
  - fields: `id`, `status`, `action`
- `codex-rs/protocol/src/models.rs`
  - `WebSearchAction::{Search, OpenPage, FindInPage, Other}`
- `codex-rs/core/src/event_mapping.rs`
  - maps `ResponseItem::WebSearchCall` to `TurnItem::WebSearch`
- `codex-rs/core/src/session/turn.rs`
  - `response.output_item.added` becomes item started
  - `response.output_item.done` becomes item completed
- `codex-rs/tui/src/history_cell/search.rs`
  - renders the web-search history cell

### Minimal event shape

Start:

```json
{
  "type": "response.output_item.added",
  "output_index": 0,
  "item": {
    "type": "web_search_call",
    "id": "ws_sidecar_...",
    "status": "in_progress"
  }
}
```

Done:

```json
{
  "type": "response.output_item.done",
  "output_index": 0,
  "item": {
    "type": "web_search_call",
    "id": "ws_sidecar_...",
    "status": "completed",
    "action": {
      "type": "search",
      "query": "..."
    }
  }
}
```

### Feasibility

Feasible as an opencodex-only bridge change. Preserve sidecar search executions
in `runWithWebSearch`, then emit `web_search_call` output items before the final
assistant text. codex-rs should parse and render them without client changes.

Risk is mostly sequencing and truthfulness:

- Avoid confusing sidecar search with the routed model's native capability.
- Keep output indexes and terminal `response.completed` ordering valid.
- Do not leak hidden sidecar prompt text.

## Vision / image-read sidecar

### Current opencodex behavior

- `src/server.ts` plans the vision sidecar before the main provider request.
- `src/vision/index.ts` activates only when the routed model is classified as
  text-only (`provider.noVisionModels`) and the request carries image parts.
- `src/vision/describe.ts` sends each image to a ChatGPT forward vision model.
- `describeImagesInPlace(...)` replaces image content parts with a text
  description before the routed model sees the request.

This is not a Responses output-item bridge today; it is request preprocessing.

### Native codex-rs image paths

There are two different native image affordances:

1. User-attached images
   - `ContentItem::InputImage` and `UserInput::Image` are carried as image URLs.
   - TUI/app render them as part of the user message (`remote_image_urls`).
   - There is no separate "model read image" output item for normal vision
     input. A native vision model simply receives the image.

2. Local `view_image` tool
   - codex-rs exposes the `view_image` tool.
   - `core/src/tools/handlers/view_image.rs` loads the local file, emits
     `TurnItem::ImageView`, then returns a `function_call_output` containing an
     `input_image` content item.
   - `protocol/src/items.rs` maps `TurnItem::ImageView` to
     `EventMsg::ViewImageToolCall`.
   - `tui/src/history_cell/patches.rs` renders `Viewed Image`.

### Feasibility

Not the same as web_search.

For view_image tool results:

- Native-like UI is already produced by codex-rs when the local `view_image`
  tool runs.
- opencodex receives the follow-up `function_call_output` with an `input_image`.
- For text-only routed models, the vision sidecar describes that image and
  replaces it with text.
- No extra native UI event is needed; adding one would duplicate the existing
  `Viewed Image` activity.

For user-attached images:

- Codex already shows the attachment in the user message.
- Native OpenAI vision does not produce a separate "read image" activity item.
- The sidecar could optionally emit a diagnostic/proxy-only status, but there is
  no codex-rs native Responses item equivalent to `web_search_call` for "vision
  sidecar described this input image".
- Faking `ImageView` would be semantically wrong unless the image came from the
  actual `view_image` local tool, because `ImageViewItem` requires a local path
  and represents a tool execution.

### Recommendation

- Implement native-like `web_search_call` re-emission first.
- Leave vision sidecar UI alone for now:
  - `view_image` already has native UI.
  - user attachments already render as user message images.
  - sidecar description is an internal preprocessing step, not a native Codex
    event.
- If visibility is needed, add a transparent opencodex diagnostic/status event
  later rather than pretending the model or Codex ran a local image-view tool.

## Bottom line

`web_search` parity is straightforward because codex-rs has a native
`web_search_call` output item. Vision sidecar parity is different: native Codex
does not expose "image was read" as a model output item, and the local
`view_image` UI is already emitted by codex-rs when that tool is actually used.
