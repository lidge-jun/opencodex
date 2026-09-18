# Phase 4 — modality fidelity and explicit refusal

Branch `agent/provider-parity-04-modality`, base `agent/provider-parity-03-wire`.
Findings F8, F5, F9 and the Kiro remote-image loss.

Thesis: where a payload can be carried, carry it; where it cannot, say so. The
common defect in all four is that the proxy currently does neither — it drops the
content and returns success.

This layer is last because an explicit refusal is only honest once the layers below
have stopped losing the payload for unrelated reasons.

## Scope

IN: CodeBuddy/Qoder tool-result images, audio and file presence in the translated
IR, translated Chat video, Kiro remote images.

OUT: any remote fetch; a speculative universal audio wire implementation; Qoder's
deliberate image refusal; the vendor-tools-disabled policy on both coding-agent
adapters; native raw passthrough behavior; Google inline video.

No raw media bytes may appear in any error message or marker this layer produces.

## File change map

| File | Action |
|---|---|
| `src/adapters/coding-agent/protocol.ts` | MODIFY — carry tool-result images |
| `src/responses/parser-content.ts` | MODIFY — audio presence markers |
| `src/adapters/openai-chat.ts` | MODIFY — no malformed video part |
| `src/adapters/kiro-images.ts` | MODIFY — remote image marker |
| `tests/adapters/coding-agent-tool-result-images.test.ts` | NEW |
| `tests/responses/parser-content-audio.test.ts` | NEW |
| `tests/adapters/openai-chat-video-part.test.ts` | NEW |
| `tests/adapters/kiro-remote-image.test.ts` | NEW |
| `scripts/test-layout/layout.json` | MODIFY |
| `tests/fixtures/test-layout-expected.json` | MODIFY |
| `structure/providers/kiro.md` | MODIFY |
| `structure/providers/chat-compat.md` | MODIFY |
| `structure/adapters/registry.md` | MODIFY |

## MODIFY `src/adapters/coding-agent/protocol.ts` — F8

`buildConversationInput` already knows how to carry an image: `imagePart`
(`:300-305`) encodes a `data:` URL or an `https` URL as a real image block, and
the current-user branch (`:423`) and history branch (`:446`) both use it. Only the
`toolResult` branch does not.

Before, at `:431-436`:

```ts
  } else if (currentMessage.role === "toolResult") {
    const text = typeof currentMessage.content === "string"
      ? currentMessage.content
      : currentMessage.content.map(p => (p.type === "text" ? p.text : "[image]")).join("");
    const status = currentMessage.isError ? " (error)" : "";
    currentRequestText = \`TOOL RESULT (call_id: \${currentMessage.toolCallId})\${status}:\n\${text}\n\nPlease proceed based on the above tool result.\`;
```

After — the image carriers join `imageBlocks` in order, and the prose keeps a
bounded provenance marker in their place so the text still reads coherently:

```ts
  } else if (currentMessage.role === "toolResult") {
    let text: string;
    if (typeof currentMessage.content === "string") {
      text = currentMessage.content;
    } else {
      const segments: string[] = [];
      for (const p of currentMessage.content) {
        if (p.type === "text") { segments.push(p.text); continue; }
        if (p.type === "image") {
          // Carry the real image rather than flattening it to a marker. The
          // provenance note stays so the model can tell which attachment the
          // tool produced; the bytes travel as an image block, never as text.
          const image = imagePart(p.imageUrl);
          if (image) { imageBlocks.push(image); segments.push("[image attached below]"); }
          else segments.push("[image omitted: unsupported reference]");
          continue;
        }
        segments.push("[video]");
      }
      text = segments.join("");
    }
    const status = currentMessage.isError ? " (error)" : "";
    currentRequestText = \`TOOL RESULT (call_id: \${currentMessage.toolCallId})\${status}:\n\${text}\n\nPlease proceed based on the above tool result.\`;
```

The history loop (`:443-451`) gains the matching `toolResult` case so a historical
tool image is carried too, in the same order the messages appear.

Preserved exactly: the `(error)` label, the `TOOL RESULT (call_id: ...)` framing,
the "Please proceed" trailer, and message ordering. Qoder's explicit 400 on original
images happens upstream of this function and is untouched; both adapters keep
vendor tools disabled.

## MODIFY `src/responses/parser-content.ts` — F5

`inputContentParts` (`:33-60`) handles `input_text`, `input_image`,
`input_video` and `input_file`, and has no `input_audio` branch — so an audio
part vanishes with no trace. `outputToToolResultContent` (`:94-120`) has the same
gap on the tool-output side.

Upstream Codex sends `input_audio` with an `audio_url` field in both positions
(`codex-rs/protocol/src/models.rs`), and `codex-audio-probe.json` shows the raw
body keeping it while the IR loses it.

This layer preserves *presence*, not audio capability. It follows the convention
the file already uses for files at `:53-59`: record that an attachment existed,
never inline the bytes.

```ts
    } else if (block.type === "input_audio") {
      // The IR has no audio carrier and no adapter consumes one, so a silent drop
      // would tell the model nothing was sent. Record presence only — never the
      // payload, which is large base64 and would explode the token count.
      const b = block as { audio_url?: string; format?: string };
      const format = nonEmptyString(b.format);
      if (nonEmptyString(b.audio_url)) {
        parts.push({ type: "text", text: format ? \`[audio: \${format}]\` : "[audio]" });
      }
    }
```

The same branch is added to `outputToToolResultContent`.

Native raw passthrough is untouched and keeps forwarding `input_audio` verbatim —
that path never enters this parser. Real audio transport through the translated IR
needs a carrier type, per-provider capability data and a wire mapping for each
vendor; it is recorded as residual rather than guessed at here.

## MODIFY `src/adapters/openai-chat.ts` — F9

The image-bearing branch at `:790-794` maps every non-image part through
`(p as OcxTextContent).text`. For a video part that property does not exist, so the
wire receives `{type:"text", text: undefined}` — a malformed part, which is worse
than a drop because it can fail schema validation upstream.

```ts
          const chatParts = parts!.map(p => {
            if (p.type === "image") {
              return { type: "image_url", image_url: { url: p.imageUrl, ...(p.detail ? { detail: p.detail } : {}) } };
            }
            // OpenAI's Chat Completions wire has no video content part. Emitting a
            // bounded marker keeps the turn well-formed and tells the model an
            // attachment it cannot see was sent; the previous code produced a text
            // part whose text was undefined.
            if (p.type === "video") return { type: "text", text: "[video omitted: the translated Chat route has no video mapping]" };
            return { type: "text", text: (p as OcxTextContent).text };
          });
```

The text-only branch at `:781-786` already breaks on an empty serialization, which
is correct and stays: a message whose only content was a video produces no empty
system message.

Native Chat passthrough and Google inline video are not touched by this diff.

## MODIFY `src/adapters/kiro-images.ts` — Kiro remote image

`extractKiroImages` (`:27-36`) calls `parseDataUrlImage`, which returns undefined
for anything that is not a `data:` URL (`:13-14`). A remote `https` image is
therefore dropped with neither bytes nor marker — the payload and the evidence that
it existed both disappear.

Kiro's wire carries base64 bytes only, so a remote reference genuinely cannot be
inlined, and this layer introduces no fetch. The fix is to stop losing it silently:

```ts
/** Remote image references Kiro cannot inline, reported so the loss is never silent. */
export function extractKiroUnsupportedImageCount(content: string | OcxContentPart[]): number
```

The payload builder (`src/adapters/kiro/payload.ts:237` and `:285`) appends a
bounded marker to that turn's text when the count is non-zero:
`[image omitted: remote image references are not supported by this provider]`.
No URL is included — a remote URL can carry a signed token, and this proxy does not
log or echo credentials.

## Acceptance criteria

| # | Scenario | Observable effect |
|---|---|---|
| 1 | CodeBuddy turn, current tool result with a data-URL image | image block reaches the wire; `[image]` no longer appears |
| 2 | same with a remote https image | image block with `source.type === "url"` |
| 3 | historical tool result with an image | carried, in message order |
| 4 | tool result with `isError: true` | `(error)` label preserved alongside the image |
| 5 | tool result mixing text and image | text order preserved; provenance marker in place |
| 6 | tool result with an unsupported image reference | `[image omitted: unsupported reference]`, no crash |
| 7 | `input_audio` in user content | `[audio: <format>]` text part; no base64 in the output |
| 8 | `input_audio` in tool output | same |
| 9 | no audio | parts byte-identical to today |
| 10 | translated Chat, video beside an image | `{type:"text"}` with a real string; no undefined text |
| 11 | translated Chat, video only | message dropped cleanly, no empty system message |
| 12 | Kiro turn with a remote image | bounded marker present; no URL in the text; no fetch attempted |
| 13 | Kiro turn with a data-URL image | unchanged from today |

Rows 1-8, 10 and 12 are the red-first regressions.

## Bypass record

Tier E7. Executing surface: the four new test files plus `bun run typecheck` and
`bun run privacy:scan`. Known bypass: a marker is advisory — a model may ignore it,
and no schema enforces its presence. Residual risk: accepted; the alternative is the
current silent loss. Wording was deliberately downgraded in one place and it is
stated plainly: the audio change is presence preservation, **not** audio support,
and the PR says so rather than implying the modality now works.
