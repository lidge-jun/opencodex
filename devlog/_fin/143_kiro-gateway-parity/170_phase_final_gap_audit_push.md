# Phase 170 - Final Kiro parity gap audit and push

## Trigger

All planned Kiro/CodeWhisperer parity hardening slices have landed. The user
asked to continue until final completion, verify whether any functional gaps
remain, and push the branch after the final audit passes. Multi-account failover
remains explicitly out of scope.

## Plain-language plan

Review the completed Kiro work against the GPT-Pro gap list, confirm that each
in-scope item has code and test evidence, run the strongest practical local
verification, get a read-only employee audit, then push `feat/kiro-on-dev`.
Do not add new feature code unless the audit finds a blocking in-scope gap.

## Gap checklist

### In scope and expected closed

- Native Kiro image payloads via `userInputMessage.images`.
- Terminal handling for Kiro eventstream exception/error frames.
- Kiro HTTP retry/backoff and first-token retry boundaries.
- OAuth refresh singleflight, SQLite reload/recovery, broader single-account
  auth inputs, and API-region/runtime-region split.
- Resume/tool-result payload correctness.
- AWS eventstream decoder bounds/fuzz hardening.
- Tool schema sanitization and tool fallback hardening for long descriptions,
  orphaned tool results, and no-tools payloads.
- Model list/resolver updates, versioned aliases, and max effort metadata.
- Actionable Kiro upstream error mapping.
- Thinking-tag exposure fix.
- Truncation detection/fail-closed stream recovery.
- Estimated usage tagging and redacted Kiro diagnostics.

### Explicitly out of scope

- Multi-account Kiro failover, sticky account selection, and circuit breakers.
- Live validation against a real Kiro account when local credentials/session are
  not available.
- ChatGPT web-session follow-up if the linked ChatGPT page requires login.

## Diff plan

### NEW `devlog/_plan/143_kiro-gateway-parity/170_phase_final_gap_audit_push.md`

This document.

### MODIFY durable memory

Save a short session outcome to:

- `structured/episodes/live/2026-06-29.md`

### NO CODE CHANGES unless audit fails

If the final audit finds an in-scope blocker, return to a new PABCD fix phase
instead of pushing.

## Verification plan

- `bun x tsc --noEmit`
- `bun test tests/kiro-images.test.ts tests/kiro-stream.test.ts tests/kiro-retry.test.ts tests/kiro-oauth.test.ts tests/eventstream-decoder.test.ts tests/kiro-adapter.test.ts tests/error-fidelity.test.ts tests/usage-log.test.ts tests/request-log.test.ts tests/debug.test.ts tests/usage-debug.test.ts tests/usage-summary.test.ts`
- `git status --short --branch`
- Read-only Backend verifier to compare completed commits/plans against the
  GPT-Pro P0/P1/P2 list.
- Push only after verifier status is `DONE`.

## Commit/push plan

- Commit this plan/evidence as `docs(kiro): plan final parity audit`.
- If verification passes and no blocker remains, push:
  - `git push origin feat/kiro-on-dev`

## Local final audit evidence

Local audit after the Kiro Request Logs full-context usage follow-up found no
new in-scope functional gap against the GPT-Pro P0/P1/P2 checklist. The
remaining known non-parity is intentionally out of scope: Kiro multi-account
failover / sticky account selection / circuit breakers, and live Kiro account
validation when no live account is available.

Verification passed:

- `bun x tsc --noEmit`
- `bun test tests/kiro-images.test.ts tests/kiro-stream.test.ts tests/kiro-retry.test.ts tests/kiro-oauth.test.ts tests/eventstream-decoder.test.ts tests/kiro-adapter.test.ts tests/error-fidelity.test.ts tests/usage-log.test.ts tests/request-log.test.ts tests/debug.test.ts tests/usage-debug.test.ts tests/usage-summary.test.ts`
- `138 pass, 0 fail`
- Kiro split files are below the 500-line limit; `src/adapters/kiro.ts` is 494
  lines.

Independent Backend employee verification could not be completed in this
session. Two dispatch attempts returned `Not logged in - Please run /login`.
Therefore no employee `DONE` verdict is claimed.

Push was not performed in this audit pass because the verification plan says to
push only after employee `DONE`, and the current user turn did not freshly
authorize `git push`.

## Post-audit follow-up

Later live Codex Desktop/Kiro Computer Use testing found additional tool
fidelity issues that were not covered by the local final-audit matrix:
namespaced MCP/Computer Use tool names needed full wire-name preservation,
complete JSON tool calls could reach EOF without a Kiro `stop` frame, and
Computer Use screenshot images were dropped from Kiro tool-result
continuations. The follow-up patch and evidence are recorded below.

Implementation summary:

- `src/adapters/kiro-tools.ts` now advertises full
  `namespacedToolName(namespace, name)` wire names instead of bare tool names,
  and no longer truncates tool specification names to 64 characters.
- `src/adapters/kiro.ts` replays assistant `toolUses` with the same full wire
  name, so Kiro history matches the current tool definitions and the bridge can
  restore MCP namespaces from `toolNsMap`.
- `parseKiroStream()` still fails closed for incomplete tool JSON at EOF, but
  recovers complete JSON tool calls when Kiro omits the terminal `stop` frame.
- `src/responses/schema.ts` now explicitly accepts `input_image` blocks in
  `function_call_output.output`.
- Kiro tool-result continuations now preserve screenshots by extracting image
  parts from structured `toolResult` content and attaching them to the carrier
  `userInputMessage.images` alongside structured `toolResults`.

Regression coverage added:

- Full MCP/Computer Use wire names are advertised and replayed.
- Long namespaced tool names are preserved rather than truncated.
- Complete JSON EOF recovery emits a normal tool call; partial JSON EOF still
  emits the truncation error.
- Responses `function_call_output` image blocks are preserved.
- Kiro carrier user messages receive tool-result screenshot images.

Local verification passed:

- `bun x tsc --noEmit`
- `bun test tests/kiro-adapter.test.ts tests/kiro-stream.test.ts tests/bridge.test.ts tests/responses-parser.test.ts`
- Result: 62 pass, 0 fail.
- `src/adapters/kiro.ts` remains at the 500-line limit.

Remaining work after the local patch is runtime-only: rebuild/restart the local
proxy/app so the patched adapter is loaded, run one live Kiro Computer Use smoke
(`list_apps`, `get_app_state` on Chrome/Finder), and confirm the next Kiro turn
can reason over the screenshot. Whether the conversation UI should render a
visible screenshot thumbnail remains a Codex Desktop UI-rendering question; the
Kiro model-context mapping is now covered locally.
