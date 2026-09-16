# Trio stack: WS stage instrumentation, native-main device reauth, paginated history recovery

Unit 260912_unimplemented_trio_stack. HOTL loop goalplan slug
`implement-three-unimplemented-opencodex-backlog` (session
01a09616-38e6-72e0-b5bf-99eb10ce58a6). Bottom-up manual stacked-PR chain
against `dev` (lidge-jun/opencodex). No merges, no GitHub native-stack
registration. Every push uses `git push --no-verify`; local product
suite/build/typecheck/install NOT RUN; each PR relies on hosted exact-head
CI and says so in its Verification section.

## Objective

Close the three implementable unimplemented backlog items identified in the
2026-09-12 inventory:

1. Issue #4191 — WS 1006 / response-prelude-timeout diagnosis has no durable
   content-free evidence. Ship stage instrumentation only; no fix, no
   auto-retransmit fallback.
2. Issue #3898 — headless hub cannot reauth native `__main__` because
   deviceauth is pool-only. Ship the native-main device reauth API/CLI, then
   the main-card Re-login GUI on top of it.
3. Issue #4311 residual — paginated history still has no writer support and
   no recovery for ordinal-corrupted rollouts. Ship the offline recovery
   tool with preservation proofs; live writes stay refused.

## Sources

- #4191 body: content-free stage diagnostics list; A/B evidence that the
  failure is proxy-path-specific; related #2471, #4083, #3976.
- #3898 body: suggested contract (reuse OpenAI deviceauth, persist to native
  main slot, keep `__main__` out of `/api/codex-auth/login`, no codex
  binary/keyring requirement, secret-free DTOs).
- #4311 body: ordinal-0 clone defect (now guarded), incident recovery by
  ordinal-digit rewrite while Codex was closed, prohibition of N+1 guessing
  and live rewrites.
- devlog/_plan/260912_accounts/080_reauth_api.md and 090_reauth_ui.md —
  accepted Accounts-lane design drafts this unit adopts for L2/L3.
- devlog/_plan/260912_history_containment/ — refusal contract this unit
  must preserve.

## Constraints (hard)

- L1 logs stay content-free: create-frame byte count, send completion,
  close code (numeric), elapsed/first-frame timings, frame counters, OCX and
  Bun versions. No conversation text, no headers, no close-reason text, no
  account identifiers in the new records.
- L1 adds no `responseCommitted === false` auto-retransmit: turn
  duplication risk is documented in #4191 discussion.
- L2 keeps `/api/codex-auth/login` rejecting `__main__` (400), keeps pool
  Add/Re-login semantics unchanged, and must not route the native flow
  through `startLoginFlow("chatgpt")` (scratch-slot overwrite + pool
  singleflight collision, src/oauth/index.ts:1899-1973).
- L2 commit to `$CODEX_HOME/auth.json` only under an exclusive claim with
  path/hash/inode assertion and same-identity verification; never retains
  old identity token beside new credentials; fails safe
  (`native_main_unavailable`) when no fence can be established.
- L3 must not reuse `AddCodexAccountModal` or `openReauth("__main__")`;
  dedicated hook and dedicated backend namespace only (the pool login route
  rejects `__main__` at src/codex/account-id.ts:15-20).
- L4 must not invent last-ordinal+1, must not write to a live rollout, must
  not weaken `history_paginated_requires_native_writer` refusal in
  preflight/apply/restore paths, and must preserve every non-ordinal byte.
- All layers: focused tests land with the layer; every new test file gets
  layout.json `explicit` + tests/fixtures/test-layout-expected.json
  entries in the same PR.
- structure/ ownership: any owned source area changed by a layer updates
  its structure doc in the same PR (structure/AGENTS.md).

## Work-phase map (dependency order = stack order, bottom first)

| WP | Layer | Branch | PR base | Decade doc |
|----|-------|--------|---------|------------|
| wp2 | L1 #4191 WS stage instrumentation | codex/260912-ws-stage-instrumentation | dev | 010 |
| wp3 | L2 #3898 native-main reauth API/CLI | codex/260912-native-main-reauth-api | wp2 branch | 020 |
| wp4 | L3 #3898 main-card Re-login GUI | codex/260912-native-main-reauth-ui | wp3 branch | 030 |
| wp5 | L4 #4311 paginated history recovery | codex/260912-native-paginated-writer | wp4 branch | 040 |

Dependency logic: L2 and L3 are one feature split at the API/UI seam
(030 depends on 020's route). L1 is independent but touches the shared
request-log schema, so it sits at the bottom where later layers rebase onto
a stable log contract. L4 is the riskiest (user data) and rides on top so
lower layers can land without waiting for it. There is no functional
dependency between L1/L2 and L4; the chain exists to serialize review.

## Verification policy per layer

- Red-first focused tests, then implementation, then green.
- `bun test tests/<domain>/<file>` (or `cd gui && bun test tests/<file>`
  for L3) fresh at C, captured via `cxc receipt test`.
- Full local suite/build/typecheck/install: NOT RUN (standing rule); each
  PR Verification section labels this and names the hosted exact-head CI
  run as the integration evidence. Cancelled/skipped CI never counts as
  passing.
- L4 additionally: privacy-relevant paths (rollout bytes) stay in tests
  with synthetic fixtures only.

## Open decisions carried to audit

1. L2 hub fence: on a headless hub the native owner never activates
   (src/server/index.ts:1026-1046 + src/codex/desired-state.ts:79-81).
   020 resolves how commit fencing works there without weakening the
   exclusive-claim contract; audit must confirm the chosen fence.
2. L4 scope: true live-write support needs a Codex-owned writer API that
   does not exist in this tree. This unit ships the offline recovery tool
   and keeps live refusal; the PR description must say so explicitly.
3. L3 screenshot evidence: obtained from hosted CI artifacts or recorded
   exemption, per repo PR gate (title/body mentions of gui need a
   screenshot).
