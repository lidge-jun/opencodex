# codex-rs compatibility-surface audit (260707)

Goal: compare codex-rs wire protocol (protocol/src/models.rs ResponseItem, codex-api/src/sse/responses.rs)
against opencodex src/responses/{schema,parser}.ts + bridge and close routed-provider gaps.

## Findings (probe-verified with /tmp/probe-parser.test.ts)

1. **function_call_output array drops `input_text` blocks** (BUG, verified).
   codex-rs FunctionCallOutputContentItem = InputText | InputImage | EncryptedContent.
   opencodex outputContentBlockSchema only accepts output_text|text|refusal, and
   outputToToolResultContent skips input_text. MCP tools returning text+image lose ALL text.
   Probe: output [{input_text "here"},{input_image}] -> toolResult content had ONLY the image.

2. **custom_tool_call_output with array output passes raw blocks through** (BUG, verified).
   codex-rs CustomToolCallOutput.output is FunctionCallOutputPayload (string | content items).
   opencodex schema requires string; array falls to loose branch and raw `{type:"input_text"}`
   objects leak into OcxContentPart[] (invalid parts for adapters).

3. **`context_compaction` input items silently dropped** (BUG, verified).
   codex-rs ResponseItem::ContextCompaction { encrypted_content: Option<String> } is
   is_api_message()==true and retained by compaction/history — it CAN appear in input.
   Parser has no handler -> summary lost. Also not scrubbed in passthrough forward path.

4. **local_shell_call input items dropped** (degrade). codex-rs pairs function_call_output
   with local_shell_call ids; parser drops the call so the output becomes an orphan toolResult
   (textified). Convert to assistant toolCall to preserve pairing.

5. **web_search_call input items dropped** (minor). Replayed history loses evidence a search
   ran; textify into assistant content like tool_search precedent (anti re-search-loop).

## Scope
- src/responses/schema.ts: accept input_text + encrypted_content in function_call_output arrays;
  accept array output for custom_tool_call_output.
- src/responses/parser.ts: handle input_text/encrypted_content blocks; array custom output;
  context_compaction handler (reuse compactionItemToText); local_shell_call -> toolCall;
  web_search_call -> assistant text note.
- src/adapters/openai-responses.ts: scrub ocx1 context_compaction in passthrough.
- tests: extend responses parser tests.
Out of scope: GUI, multiauth, provider adapters other than the scrub line.

## Verification
bun test ./tests/ && bun x tsc --noEmit
