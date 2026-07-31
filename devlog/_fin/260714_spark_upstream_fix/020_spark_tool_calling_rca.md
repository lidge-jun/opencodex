# 020 — Spark tool-calling failure RCA

## Root cause

codex-rs groups tools into `type: "namespace"` wrappers (PR #24713 confirms this
is capability-gated per provider). Spark's backend rejects namespace tools.

Our first fix (`stripSparkNamespaceFields`) **removed** namespace-type tools from
the tools array — but this also removed all the actual tools inside them
(exec_command, web_search, etc.), leaving spark with no callable tools.

## Evidence

- Banach (sol web search) confirmed: namespace tool emission is capability-gated
  in codex-rs, and Spark's official contract does NOT include namespace tools.
- codex PR #24713 (May 27, 2026): explicit Bedrock enablement for namespace tools
  proves the feature is opt-in per provider.
- codex issue #14242: captured requests show `{"type":"namespace", ...}` structures.
- Gauss smoke test: spark alive but "command tooling not callable" — tools were
  stripped entirely by our namespace removal.
- Zeno search test: "tool invocation mismatch (wrong wrapper)" then disconnect.

## Fix

Comprehensive `stripSparkCompatibility` function in the passthrough adapter:

1. **Catalog**: Keep `use_responses_lite: true` for spark (controls AdditionalTools
   delivery format that spark expects) while stripping it for other non-5.6 natives.

2. **Tool types**: Flatten namespace → inner functions. Drop `custom` (apply_patch
   Lark grammar), `tool_search`, and any other non-function/non-web_search type.

3. **Tool extensions**: Strip `defer_loading` from function tools.

4. **Input items**: Process `additional_tools` developer items (where
   `use_responses_lite` puts the tools). Apply same type filtering inside.
   Drop `custom_tool_call`, `custom_tool_call_output`, `tool_search_call`,
   `tool_search_output` items. Strip `namespace` from all items.

5. **Request params**: Force `parallel_tool_calls: false`. Strip `reasoning.context`,
   `reasoning.summary`, `reasoning.generate_summary`.

## Verification

- Spark `echo hello` → returned "hello" (function_call confirmed in debug log)
- Spark web search → web-search-loop executed (2 real searches before process timeout)
- tsc: 0 errors, catalog tests: 51 pass
