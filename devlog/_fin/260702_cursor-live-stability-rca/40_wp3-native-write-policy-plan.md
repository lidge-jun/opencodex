# WP3 plan — apply_patch bridge and native-write policy

Date: 2026-07-02
Status: IMPLEMENTED 2026-07-03. User decision: codex-native — when the request
advertises apply_patch (bare freeform tool allowed by tool_choice), Cursor-native
write/delete exec requests are refused with structured `rejected` results that
point the model at apply_patch (reads stay allowed; non-Codex callers without
apply_patch keep native writes). Conditional system-guidance line added.
Remaining from this plan: live acceptance (repeat run-3 scenario, confirm the
edit lands via a codex-visible custom_tool_call).

## Evidence

- apply_patch IS already bridged: Responses custom tool → `{input: string}`
  function-shape advertised to Cursor (`src/responses/parser.ts:122-131`),
  return path emits `custom_tool_call` when `freeformToolNames` matches
  (`src/bridge.ts:255-260, 362-379`). codex-rs REJECTS apply_patch arriving as
  `function_call` (`ToolPayload` mismatch), so the custom_tool_call shape is
  load-bearing.
- The reason codex never advertised apply_patch for cursor models was catalog
  metadata (`apply_patch_tool_type`) missing → WP0 (erosion) is the true root.
- Separately, Cursor-native WRITES (exec channel `writeArgs`,
  `native-exec-fs.ts`) succeed but bypass codex approvals/sandbox/diff/rollout
  (run 3: file created with zero codex-visible tool calls).

## Decision needed (user)

Route file mutations through codex (apply_patch client round trip: safer,
visible, slower) vs keep Cursor-native writes (fast, invisible, no codex
policy). Options: block/redirect native write tools once WP2's declaration
mechanism exists; or surface synthetic events for native writes so codex UX
shows them.

## Steps (to finalize)

1. After WP0 lands, live-verify composer uses apply_patch when advertised
   (repeat run-3 scenario; inspect rollout for custom_tool_call apply_patch).
2. Decide native-write policy with user; implement declaration/mapping
   accordingly (shares machinery with WP2 Case A fix).
3. Tests + live acceptance (edit lands via codex-visible path when policy says
   so).
