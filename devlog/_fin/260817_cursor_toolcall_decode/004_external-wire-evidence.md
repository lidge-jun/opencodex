# 004 — External wire and format evidence

Gathered by a five-lane `gpt-5.6-luna` discovery swarm, then filtered here.
Public reverse-engineering of Cursor's protocol is **lead-grade, not primary**:
the repository's own generated `gen/agent_pb.ts` outranks all of it and is what
`002` relies on. These sources matter for behavior we cannot read from our tree.

## Load-bearing

**A cursor-grok stream is reported to end before `turnEnded` with tool calls in
flight.** A 2026-07-27 report for `cursor-grok-4.5-high` records
`hasToolCalls: true`, partial content, and "Cursor stream ended before
turnEnded", requiring manual continuation — attributed to the HTTP/2 stream
ending without the application-level frame.
<https://github.com/can1357/oh-my-pi/issues/6772> (lead)

This is independent corroboration that F1 is a real upstream behavior and not a
theoretical branch. It is the reason `010` treats clean EOF as a first-class
terminal state rather than an edge case.

**Cursor documents that MCP tool responses can return base64 images.**
<https://docs.cursor.com/context/model-context-protocol> (primary for product
behavior). Combined with `McpImageContent` in our generated schema, image
results are supported end to end, which is what makes `020` a passthrough fix
rather than a feature request.

**MCP specifies images in tool results.** `CallToolResult.content` is a
`ContentBlock[]` whose union includes `ImageContent` with base64 `data` and
`mimeType`. <https://modelcontextprotocol.io/specification/2025-11-25/schema> (primary)

**Naive gateway translation of image tool results fails loudly.** LiteLLM passed
Chat-Completions-style `image_url` content into a Responses `function_call_output`
and OpenAI rejected it, because Responses expects `input_image`.
<https://github.com/BerriAI/litellm/issues/17507> (lead). Design consequence for
`020`: emit the upstream's own image representation, never a foreign one.

**Bun reuses stale pooled keep-alive sockets without liveness checks**, so a
reaped connection hangs until Bun's ceiling instead of reconnecting.
<https://github.com/oven-sh/bun/issues/31894> (primary, closed "not planned").
Relevant to long-lived Cursor streams; not itself proven to be our defect.

## Context only

- **Protocol principle, adjacent transport.** In gRPC over HTTP/2, status
  trailers are required for normal completion, and Connect's gRPC-web transport
  fails loudly when the encoded trailer is missing.
  <https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md> (primary),
  <https://github.com/connectrpc/connect-es/issues/1115> (primary).
  **Terminology caution:** this adapter speaks Connect framing with an encoded
  end-stream envelope (`live-transport.ts:787-900`), not gRPC-web trailers, so
  these sources supply the general principle — a body without its terminal is not
  authoritative success — and not a statement about our exact wire. F1 rests on
  source reading (`003`), not on these citations.
- xAI documents Grok 4.6 tool calling over streaming and synchronous modes.
  <https://docs.x.ai/developers/tools/streaming-and-sync> (primary). No official
  changelog naming grok-4.6 as dropping tool calls was found.
- A Grok-compatible path was reported returning empty `arguments` with the real
  JSON in `partialJson`. <https://github.com/earendil-works/pi/issues/3131> (lead).
- Codex Computer Use is bridged through the `node_repl` runtime; several 2026
  reports describe it being detected but unattached, with kernel resets.
  <https://github.com/openai/codex/issues/21530> (lead). Some of the user's
  observed instability may originate here rather than in our adapter — recorded
  so we do not over-attribute every symptom to the Cursor path.

## Negative result

No public authoritative `.proto` confirming `McpSuccess` or
`McpToolResultContentItem` was found; available dumps use older
`ClientSideToolV2Call` terminology or are explicitly speculative. Our generated
schema remains the only trustworthy source, which is why `002` quotes it directly.

