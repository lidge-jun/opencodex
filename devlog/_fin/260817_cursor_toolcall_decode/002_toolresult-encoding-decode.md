# 002 — Tool-result encoding decode

Source: `src/adapters/cursor/protobuf-request.ts`, `gen/agent_pb.ts`,
`native-exec-mcp.ts`. Verified by direct read plus an independent
`gpt-5.6-sol` audit.

## F2 — images are destroyed, and the wire did not ask for that (High)

`contentToText` (`protobuf-request.ts:328`) maps every non-text part of a tool
result to a literal placeholder:

```ts
.map(part => part.type === "text" ? part.text : `[image input unsupported by Cursor adapter phase 3: ${part.detail ?? "auto"}]`)
```

`toolResultPart` (`:384`) then always builds exactly one `text` content item. So
a screenshot returned by Computer Use, a browser QA tool, or any image-returning
MCP tool reaches Cursor as the string
`[image input unsupported by Cursor adapter phase 3: auto]` and nothing else.

**The Cursor protobuf supports images.** `McpToolResultContentItem.content` is a
oneof with exactly two defined cases (`gen/agent_pb.ts:8476`):

```ts
content:
  | { value: McpTextContent;  case: "text" }   // field 1
  | { value: McpImageContent; case: "image" }  // field 2
  | { case: undefined; value?: undefined };
```

`McpImageContent` (`:8449`) carries `data: Uint8Array` (bytes, base64 in JSON)
and `mimeType: string`.

**The adapter already knows how to send one.** `native-exec-mcp.ts:115` decodes
base64 from an MCP block and emits a real `McpImageContent`. That path covers
tools invoked through `CursorMcpManager`; it does not cover Codex
`OcxToolResultMessage` values flowing through `protobuf-request.ts`. The
placeholder is therefore not a wire limitation but an unfinished migration — the
"phase 3" in its own text.

A model driving Computer Use therefore receives a blind result and cannot see
what its own action did. That is a real capability loss, proven by source
reading.

**It is not proven to be the cause of the reported retries and session resets.**
No live trace ties those symptoms to this branch, and the external evidence in
`004` points at least partly elsewhere (the `node_repl` runtime). An adversarial
audit flagged the original causal claim as unsupported; it is withdrawn. The
defect stands on its own merits and does not need to explain every symptom to be
worth fixing.

## The three result paths in `conversationTurns`

| Path | Behavior | Lines |
|------|----------|-------|
| External model | `AssistantMessage` with `[Tool Result]`/`[Tool Error]` + placeholder | 481-490 |
| Native model, matching pending call | `toolResultPart(result)` attached to the MCP call — still text-only | 493-496 |
| Native model, no matching call | `toolResultToText` as an `AssistantMessage` | 498-503 |

All three lose the image. A fix must cover the native path (real
`McpImageContent`) and degrade honestly on the external path.

## Other image surfaces (context, not in scope)

User-message images are also placeholdered, at `request-builder.ts:201` and
`protobuf-request.ts:314`. The schema would support them: `UserMessage` has
`selectedContext` -> `selectedImages` (`agent_pb.ts:1823`, `:11178`), and
`SelectedImage` accepts `blobId`, inline `data`, or `blobIdWithData`
(`:10389`). No adapter code populates these. Out of scope for this unit; noted
so a later unit does not have to rediscover it.

## Size limits (hypothesis partly disproved)

There is no single whole-request cap and no cap inside `contentToText`. What
exists:

- tool catalog: 330 tools / 120,000 protobuf bytes (`request-builder.ts:29`) —
  definitions only, not results;
- external root replay: 192 roots / 512 KiB with UTF-8 truncation marked
  `…[truncated for Cursor external replay budget]` (`protobuf-request.ts:60`, `:122`);
- blob store: 16 MiB per blob, 4,096 entries, 64 MiB total, 15-minute TTL
  (`native-exec.ts:81`);
- `requestScope` pins blobs for the in-flight request so eviction cannot
  invalidate advertised ids; over-capacity raises `CursorBlobAdmissionError`
  rather than truncating (`native-exec.ts:363`, `:374`).

Implication for `020`: adding real image bytes to results makes the blob and
replay budgets load-bearing, so the fix must bound image payloads deliberately
instead of trusting these limits to absorb them.

