# DONE — codex-rs compatibility-surface fixes (260707)

Work-phase: PABCD cycle closed DONE. Audit: gpt-5.5 (Hilbert) PASS-WITH-FIXES, all fixes adopted.
Parallel cxc-search (Jason): Tier-1 corroboration — codex-bridge/CLIProxyAPI/LiteLLM handle the same
surface; openai/codex#14695 confirms function_call_output array-output shape breaks naive backends.

## Shipped changes

1. src/responses/schema.ts
   - toolOutputContentBlockSchema: function_call_output/custom_tool_call_output arrays now accept
     codex-rs FunctionCallOutputContentItem: input_text, input_image, encrypted_content
     (plus legacy output_text/text/refusal).
   - custom_tool_call_output.output: string OR content-item array (codex-rs FunctionCallOutputPayload).
   - input_image.detail: accepts "original" (codex-rs ImageDetail).

2. src/responses/parser.ts
   - outputToToolResultContent: handles input_text (was silently dropped -> MCP text+image outputs
     lost ALL text), encrypted_content -> "[encrypted content omitted]" marker.
   - custom_tool_call_output arrays normalized via outputToToolResultContent (was leaking raw wire
     blocks into OcxContentPart[]).
   - context_compaction: ocx1 payload -> replayed summary user message; empty marker -> silent drop;
     never sets _compactionRequest (only compaction_trigger does).
   - local_shell_call replay -> assistant toolCall {name:"shell", arguments:{command}} so the paired
     function_call_output no longer orphans.
   - web_search_call replay -> assistant text "[web search performed: <query>]" (anti re-search loop).
   - tool_search_output: failed status -> isError tool result instead of fake "no tools" success.
   - normalizeImageDetail: "original" -> "high" before adapters (openai-chat forwards detail verbatim
     and would 400 on "original").

3. src/adapters/openai-responses.ts
   - scrubOcxCompactionItems also scrubs ocx1 context_compaction items on the passthrough forward path.

## Verification (C evidence)
- bun test ./tests/  -> 1543 pass, 0 fail, 159 files (was 1532; +11 new regression tests in
  tests/responses-parser.test.ts "codex-rs compat surface (260707)" + 1 in responses-compaction.test.ts)
- bun x tsc --noEmit -> exit 0

## Explicit non-goals (recorded per audit fix 7)
- Message `phase` (commentary/final_answer) round-trip: codex-rs treats absence as "phase unknown"
  with mandated fallback behavior; dropping it is lossless for routed chat models. Not implemented.
- ToolSearchCall/ToolSearchOutput `execution` field: informational; not needed for pairing.

## Not live until ocx restart (still pending user approval, along with image-guard + compaction v2).
