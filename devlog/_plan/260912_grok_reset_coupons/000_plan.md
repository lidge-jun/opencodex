# Grok reset coupons — roadmap (000)

## Reader summary

Grok's consumer billing now hands out "reset coupons" (Codex-style usage-reset
credits). This unit teaches opencodex to read them and, only on an explicit
operator action, redeem one — using the xAI OAuth tokens opencodex already
stores, with no browser session. Live probes this session proved the upstream
contract (see [001_survey_seams.md](./001_survey_seams.md)); the implementation
mirrors the existing Codex reset-credit architecture end to end so operators get
the same safety shape they already know.

## Loop spec

- **Archetype:** satisfy-spec (feature delivery against a verified upstream contract).
- **Trigger:** user request this session: "이슈 올리고 pr 하고 머지까지" (file the issue, open the PR, merge) for Grok reset-coupon read + gated redeem.
- **Goal:** ocx can list a Grok account's remaining reset coupons (count + validity window) and redeem one only through an explicit, idempotent, journaled operator action, surfaced via management API + CLI; delivered as a templated issue + PR to `dev`, merged with exact-head CI evidence.
- **Non-goals:** no auto-redeem in this unit (opt-in auto-redeem is a follow-up); no GUI surface; no changes to the Codex reset-credit path; no new dependency (hand-rolled gRPC-Web codec, no @bufbuild/protobuf runtime import).
- **Verifier:** `bun test tests/providers/xai/grok-reset-coupons.test.ts` (targets the new test file directly), `bun run typecheck` (package.json:11 "bun x tsc --noEmit"), `bun run test` (package.json:12 "bun scripts/test.ts" — full tree, reads all domains incl. our layout registrations), `bun run privacy:scan` (package.json "bun scripts/privacy-scan.ts" — scans the tree incl. new files). Live smoke (sanitized) re-proves the read path against the real endpoint.
- **Stop condition:** all criteria met (goalplan c1–c6) and the PR is merged with exact-head CI + issue closed; report DONE. Missing authority (push/merge refusal) reports BLOCKED.
- **Memory artifact:** this unit (devlog/_plan/260912_grok_reset_coupons/, moves to _fin at wp4 D); goalplan + ledger under .codexclaw/goalplans/implement-grok-reset-coupon-support-in-opencodex/; evidence under .codexclaw/evidence/.
- **Expected terminal outcomes:** DONE (all criteria + merged), BLOCKED (missing external authority or upstream contract change), BUDGET_EXHAUSTED (host bounds), NEEDS_HUMAN (upstream schema drift on RedeemReset success shape).
- **Escalation condition:** upstream rejects the documented RedeemReset request shape on a real redeem → stop, report, ask operator how to proceed (spending a coupon is operator-owned). Main reclaims a lane after two distinct agents fail its packet (DISPATCH-RETIRE-01); pushing a slice to a worker requires a P-phase amendment.

## Resource bounds (HOTL)

Tool scope: local git/gh, repo files in this worktree, spawned read/executor subagents (unlimited parallel dispatch explicitly authorized by the operator this session; model picker left empty = inherit), ocx 10100 + aside lanes. Write scope: this worktree; remote branch push, issue, PR, and merge were explicitly authorized in the same session. Token budget: unset by operator (host default). Wall clock: until DONE/BLOCKED within this session.

## Dependency-ordered phase map

| Phase | Work-phase | Doc | Outcome |
|---|---|---|---|
| wp1 | Docs-first roadmap cycle (this cycle) | 000–030 | Roadmap locked at D |
| wp2 | Core gRPC-Web client + xai account integration | [010_phase1_core_client.md](./010_phase1_core_client.md) | src/grok/grpc-web.ts + src/grok/reset-coupons.ts + src/grok/reset-coupon-ledger.ts + focused tests + layout registration |
| wp3 | Surfaces: management API + CLI with gated consume | [020_phase2_surfaces.md](./020_phase2_surfaces.md) | GET/POST routes + ocx account grok-reset-coupons with --consume --yes + operation-id idempotency |
| wp4 | Delivery: docs sync, issue, PR, exact-head CI, merge | [030_phase3_delivery.md](./030_phase3_delivery.md) | docs-site updated, templated issue + PR, merged into dev, issue closed |

## Scope boundary

IN: files named in 010/020/030 only. OUT: src/lab/*, src/router.ts, src/server/lifecycle.ts, src/server/responses/core.ts (lab boundary, tests/lab/core-lab-boundary.test.ts), Codex reset-credit modules, GUI.

## Conditional-path activation (C-ACTIVATION-GROUNDING-01)

| Planned conditional path | Activation scenario at C |
|---|---|
| grpc-status non-zero (e.g. 3 "Invalid token_id") | stubbed fetch returns trailer frame status 3; test asserts surfaced message |
| 401/expired token → one refresh + replay | stubbed fetch 401 then 200; test asserts refresh called once with stored refresh token |
| Consume without --yes | CLI test asserts refusal before any fetch |
| Same operationId replay | ledger test: second call with same id returns journaled settlement, fetch called once |

## SoT sync (SOT-SYNC-01)

docs-site reference pages (targets verified by the docsite lane: docs-site/src/content/docs/reference/cli/providers-accounts.md, docs-site/src/content/docs/reference/management-api.md) + structure/ ownership check at wp2 P re-verification; devlog unit promotes to _fin at wp4 D.
