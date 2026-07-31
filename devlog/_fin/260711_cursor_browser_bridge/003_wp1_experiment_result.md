# 003 - WP1 experiment RESULT: B-1 disproven with faithful live evidence

## TL;DR

B-1 (make Codex client tools callable under Cursor by advertising them under a
routable providerIdentifier) is DISPROVEN. Neither the tool NAME scheme nor the
providerIdentifier is the fix. Even reproducing the EXACT scheme of the known
working reference bridge (`Hardcode84/opencode-cursor`: provider `opencode`, name
`mcp_opencode_<tool>`), advertised through the same `requestContextArgs` channel,
cursor/gpt-5.6-luna still does NOT see opencodex's client tools as callable and
falls back to Cursor's native Shell every time. Terminal outcome: NEEDS_HUMAN.
No code change landed (the cheap fixes don't work); the real fix is a larger C4
client-capability question that needs a scoping decision.

## Experiments run (all live, zero restart of the user's proxy on port 10100)

Probe method: POST /v1/responses through the REAL request-builder path (so
`requestContextArgs` fires and system-note injection is faithful), reading raw
protocol frames. The user's live proxy on 10100 was used only for the read-only
baseline probes with debug ON (user-authorized); provider-identity variants ran on
an ISOLATED second proxy (port 10199, separate OPENCODEX_HOME/CODEX_HOME copies)
so the live session and Cursor account pool were never disturbed. All copied
tokens/temp dirs were deleted after.

1. BASELINE (live 10100, current scheme: provider `opencodex-responses`, bare name
   `run_probe` + `exec_command`, forced-call prompt):
   - Frames: `execServerMessage requestContextArgs` fired (tools advertised), then
     the model emitted `toolCallStarted toolCase:"shellToolCall"` + `shellStreamArgs`
     (Cursor NATIVE shell), `turnEnded`. ZERO `mcpToolCall`.
   - Model text: "`exec_command` is unavailable; ran equivalent shell command
     successfully ... `run_probe` is not available in this environment."

2. NAME variant (live 10100): tool named `mcp_opencodex-responses_run_probe`
   (pre-prefixed to the Cursor display convention).
   - Model text: "No note-recording tool is available in this session." NOT callable.
   => NAMING is not the gate. (H1 disproven.)

3. PROVIDER-IDENTITY variant (isolated 10199, env-gated scaffold
   `OCX_CURSOR_PROBE_PROVIDER=opencode` -> advertise client tools as provider
   `opencode`, name `mcp_opencode_<tool>`, exactly the working reference scheme),
   3 runs:
   - `[PROBE] execCase=requestContextArgs` x3  (tools WERE advertised under `opencode`)
   - `[PROBE] execCase=shellStreamArgs`   x3  (model used Cursor NATIVE shell)
   - `[PROBE] execCase=mcpArgs`           x0  (model NEVER called our tools)
   - function_calls=0 all 3; model text every run: "run_probe/exec_command are
     unavailable ... ran the equivalent available shell command."
   => PROVIDER IDENTITY is not the gate. (H2 disproven.)

## What this rules out and what it points to

RULED OUT (with faithful advertised-and-observed evidence): the difference between
opencodex (fails) and opencode-cursor (works) is NOT the providerIdentifier string
and NOT the `mcp_<provider>_<tool>` naming. The synthetic-provider advertisement
channel itself is fine (requestContextArgs fires and carries the defs).

LEADING REMAINING HYPOTHESIS (H4, untested - the next experiment): NATIVE-TOOL
CROWD-OUT. In EVERY probe the model had, and reached for, Cursor's native tool
suite (`shellToolCall`/`shellStreamArgs`) and treated the injected MCP tools as
absent. The reference bridge `opencode-cursor` presents itself to Cursor as a
client WITHOUT the native tool surface, so its model has no native Shell and must
use the injected `mcp_opencode_*` tools. Opencodex advertises the full Cursor
native tool suite (Shell/ReadFile/rg/ApplyPatch/...) AND the injected MCP tools;
the model consistently binds to native and never surfaces the MCP tools. So the
fix is likely about HOW opencodex declares client capabilities / which native
tools it exposes to Cursor, not about the MCP tool defs at all.

## Terminal outcome: NEEDS_HUMAN (per goal acceptance)

The goal explicitly listed "documented NEEDS_HUMAN with live evidence disproving
B-1" as a valid outcome. That is what happened. The next step is a C4 decision, not
a mechanical fix:

- OPTION A (recommended next experiment, still C4): test H4 by having opencodex
  suppress / minimize the Cursor NATIVE tool advertisement for a turn while keeping
  the MCP client-tool defs, and re-run the isolated probe. If the model then calls
  `mcp_*`, the fix is a capability-declaration change (scoped, but it changes core
  Cursor request behavior and risks regressing the native file read/write/shell
  path that was just fixed in 26cf884 - hence a human scoping decision).
- OPTION B: accept the limitation and use a NON-cursor model (e.g. gpt-5.6-sol) for
  Browser / mcp__codex_apps__* plugin work. This already works today.

## Cleanup / safety

- Live proxy (10100) never restarted by this work; used only for authorized read
  probes. Its pid changed once (52127 -> 45876) INDEPENDENTLY - it is service /
  KeepAlive managed and the user had restarted it earlier; the second proxy was a
  separate process on 10199 that never bound 10100.
- Throwaway env-gated scaffold (buildCursorToolDefinitions probe branch +
  native-exec probe log) reverted; `git status` clean, `tsc` clean, cursor tests
  25/25 pass.
- Debug turned OFF on 10100. Isolated homes with copied OAuth tokens deleted.
