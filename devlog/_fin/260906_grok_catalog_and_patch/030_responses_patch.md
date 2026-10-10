# 030 Codex native Responses patch completion parity

Depends on recorded export layers for stack delivery; runtime independent. Class C3, spec-satisfaction repair. Goal: same repaired executable input at deltas/input.done/item.done/response.completed for complete patches misrouted as exec. No arbitrary JavaScript rewriting.

MODIFY src/server/responses-custom-tool-repair.ts: register same-name routed custom calls in addition to aliases. Track original wire name and target; hold custom input deltas when code-mode exec may be a patch envelope or when helper alias requires compilation. Accumulate under TranslatorBudget, release on done/dispose. Run restoreRoutedCustomCalls for same-name custom items, and use existing resolveCodeModeHelperName/compileCodeModeHelperInput at input.done. Do not place exec in repairNames. Preserve ordinary JavaScript streaming where monotonic; once raw prefix would diverge, withhold to authoritative completion. Suppress function helper-alias progressive previews rather than emitting raw patch before compiled JS.
MODIFY tests/responses/responses-custom-tool-repair.test.ts: native custom exec raw/wrapped complete patch, fragmented marker, input.done and output_item.done plus terminal snapshots; function apply_patch wrapper alias; invalid/incomplete envelopes and valid JS remain exact; flat catalogs and foreign namespaces do not retarget; cancellation frees retained buffers.
UPDATE existing patch compatibility docs and structure/11_compatibility-contracts.md to describe completion-boundary parity.

Verifier: pure standalone synthetic SSE-block imports, compare outputs at each lifecycle edge and execute generated JS against a recording tools.apply_patch stub (no filesystem writes). Probe must assert monotonic preview or held preview, one call, exact canonical patch data. CI runs added regressions and existing bridge/native compatibility tests plus full suite/typecheck. Complete only after independent review and exact-head CI; register requested stack and admin merge after verified heads. Fetch dev and prove every merge SHA ancestor. D records parity inventory and public PR links.

## Audit amendment

Executable repair is limited to authorized code-mode exec and recognized helper aliases; unrelated same-name native custom tools keep raw input byte-for-byte. Explicit negative: render_diagram input JSON string {"input":"literal"} is not unwrapped. Separate scenarios cover missing input.done, terminal-only completion, failed/incomplete after held deltas, and disposal. Authoritative completion wins over previews. Failure never synthesizes successful completion. All retained buffers release. One simulated execution means choose the client-consumed completed item once, not execute every redundant lifecycle representation.

## P revalidation

Consume 020 ff388977a with isolated route/writer proof and remote75+19 tests. 030 remains scoped to the two patch lifecycle gaps. Append040 for independently confirmed ordinary function and dotted-namespace parity gaps; all terminal CI/merge obligations move there unchanged. Main owns production030; a disjoint worker may add tests only in tests/responses/responses-custom-tool-repair.test.ts. Native code-mode exec previews may be held until final when they could be complete raw/wrapped envelopes; unrelated native custom JSON bodies remain raw.

## Implementation audit synthesis

A fragmented pretty JSON wrapper beginning with brace-newline escaped the compact-prefix guard, so preview bytes could contradict compiled completion. The completion parser accepts arbitrary whitespace, escaped property names and property order; native exec now conservatively holds all object-leading inputs to completion. Ordinary JavaScript stays byte-exact, though a block-leading program waits for completion. Added per-character pretty-wrapper and escaped-key regressions.
