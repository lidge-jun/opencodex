# 030 — Fix #847: per-call scope in the non-stream collector + mandatory budget + 502 normalization

Depends on: 001 root-cause delta. Translator budgets already landed (`a61607894`); this closes the two narrow gaps and one contract inconsistency.

## P re-verification note (2026-08-02, wp3 cycle — supersedes details below where they conflict)

- Budget-default instead of mandatory type: ALL production callers of `bridgeToResponsesSSE` / `buildResponseJSON` already pass a budget (`core.ts:2172/2224/2656/2716`, `web-search/loop.ts:655`, `images/loop.ts:810`), but `options` itself is optional, so a required field would not compile-guard omission without making `options` required — a 20+-site blast across tests. Instead both entry points now CREATE a default `createTranslatorBudget()` when none is passed (disposed with the call), making omission SAFE rather than unbounded. This delivers the actual invariant (no unbounded caller, present or future) with zero call-site churn.
- Collector contract mirrors `openai-chat.ts:801-817`: `openCall(scope)` on first delta of an index, args charged `{ kind: "tool_args", callId: scope }` (2 MiB per call enforced by the budget), `closeCall(scope)` only AFTER the final serialized copy is charged (`outbound.ts` final `chargeRetained(JSON.stringify(copy))`), open scopes closed on every error path.
- 502 shape mirrors `openai-chat.ts:929-937`: status 502, type `upstream_error`, code kept `translation_buffer_limit`.

## Round-2 repair note (2026-08-02)

- Owned default SSE budgets are disposed at every stream-death path AFTER final charges (terminal close, normal end, incomplete terminal, torn-down controller, heartbeat failure, cancel). ACCEPTED RESIDUAL: a stream abandoned with no terminal and no cancel (never pulled, process alive) leaves the default budget registered in `liveBudgets` — production callers always pass a budget, so this path is test-only; fixing it would need a finalizer the codebase deliberately avoids.
- ACCEPTED RESIDUAL: `retainTranslatedEventBatch` leases are budget-identity-sensitive, so a default build budget cannot release leases charged by a different source budget. Production-impossible today (the same turn budget flows through every `core.ts` caller); if a future caller mixes budgets, the source budget's owner releases at turn end.

## File map

- MODIFY `src/chat/outbound.ts`
  - `collectChatCompletion()` (~:621, ~:700): open/close per-call ownership by stable tool-call index (fall back to call ID) and charge argument bytes as `tool_args` under that call scope — 2 MiB per call, 32 MiB per turn — including authoritative replacement snapshots (last-write-wins replaces, not accumulates). Today args charge to generic `retained_collectors`, so one call can eat the whole turn budget.
  - Overflow mapping: translator/tool overflow in the non-stream Chat path becomes 502 `upstream_error` (matching adapter/bridge), not 413 `invalid_request_error`.
- MODIFY `src/bridge.ts`
  - BOTH optional-budget sites (audit round 1): `bridgeToResponsesSSE` options (~:159) and `buildResponseJSON` options (~:1227) — make `translatorBudget` mandatory in both. All production callers pass one today (`src/server/responses/core.ts:2644`); typecheck will catch any straggler — that is the point.
- MODIFY `src/chat/outbound.ts` overflow mapping (audit round 1 precision): the actual 413 mappings are the rejected-read path (~:650) and the parsed error-frame path (~:679) — normalize BOTH to 502 `upstream_error` explicitly.
- MODIFY `tests/chat-outbound.test.ts` (or the collector's owning suite — confirm at P) + bridge tests: new regressions (below).

Scope OUT: the SSE record ceiling (stays 32 MiB — recorded decision in 001), routing OpenAI Chat through the shared SSE decoder (nice-to-have, separate unit), `service_tier` paths (wt3's lane), PR #847's 4 MiB/8 MiB numbers (native 2 MiB/call is STRICTER; keep).

## Acceptance + activation scenarios

1. Non-stream collector: a single tool call streaming >2 MiB of arguments fails typed (`translation_buffer_limit`-class) at the 2 MiB per-call boundary — not at 32 MiB. Activation: feed chunked arguments over 2 MiB under the test budget; assert typed overflow, no completed tool call in the collected result.
2. Turn-scope overflow: TWO calls under 2 MiB cannot reach 32 MiB (audit round 1 math correction) — use at least 17 calls of ~2 MiB each, or precharge other retained ownership near the turn cap, and assert the turn overflow fires on the call that crosses it. Activation: 17-call fixture.
3. Done-frame authoritative snapshot larger than streamed deltas replaces (does not double-charge). Activation: delta-then-done fixture asserting final charged bytes.
4. Overflow surfaces as 502 `upstream_error` on BOTH mapping sites (:650 rejected-read, :679 error-frame). Activation: assert status+type on each path (was 413).
5. Omitting `translatorBudget` from either bridge entry is a compile error. Activation: typecheck (the negative is structural).
6. Red-green: #1 and #4 red on the pre-fix tree.
7. Call scope lifetime (audit round 1): the synthetic per-index scope closes only AFTER the final collected output's ownership is charged — closing earlier would release the argument string while the finalized output still retains it. Activation: assertion on final charged bytes equaling the surviving output's arguments exactly.

## Regression risks (watch in C)

- Mixed index/ID continuation chunks must attach to the same call scope.
- Releasing call ownership too early while the finalized output retains the argument string.
- 413→502 mapping: confirm no client relies on 413 for retry semantics (grep error-mapping consumers in `src/server/`).
