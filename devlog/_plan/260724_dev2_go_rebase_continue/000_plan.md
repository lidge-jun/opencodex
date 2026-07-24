# 000_plan — dev2-go rebase onto origin/dev + residual Go port continuation

Date: 2026-07-24
Session: 019f9215-29e1-7152-9e60-6d6b1b3ad90c
Branch: `dev2-go` @ `222b4371d13cb64d934c8f52848d15608a634f9b`
Target base: `origin/dev` @ `b7585565c593a4f4c03f188c9273a0ae129ca02a`
Merge-base: `6a670bcefefa8f125ac12022446d85571349324c`
Work class: C4
Loop archetype: spec-satisfaction continuation

## Loop specification

- Trigger: HOTL `cxc-loop` + Sol subagents; absorb latest `origin/dev` into `dev2-go`, then residual Go ports.
- Goal: rebased independent Go track; residual ports implemented or dependency-deferred with evidence; exact-SHA Go CI green without Node-20 deprecations.
- Non-goals: merge into `dev`/`preview`/`main`; npm/release; GUI redesign; force-push non-`dev2-go`; unverified live parity claims.
- Verifier: local Go gates; hosted Go CI on exact tip; goalplan criteria with capturedEvidence.
- Stop: `DONE` when rebased + residual roadmap closed + final CI green; `BUDGET_EXHAUSTED` only for stated 4h bound (does not count as residual-port acceptance).
- Memory: this unit; goalplan `rebase-and-continue-the-opencodex-go-rewrite-on`.
- Escalation: product depth for live/voice; force-with-lease only on `dev2-go` after local gates.

## HOTL resource bounds

- Write: `go/**`, `.github/workflows/go-ci.yml` if required, `dev2-go` governance docs, this unit, goalplan.
- Tools: git, go, gh Actions, Sol subagents; no secrets.
- Wall-clock: 4h.

## Push / CI sequence (authoritative)

Hosted CI is never required before push.

1. Local gates on intended tip.
2. Authorized force-with-lease push to `origin/dev2-go` using **fetched remote tip** as lease (not merely local HEAD if they diverge).
3. Hosted Go CI exact-SHA proof (auto or `gh workflow run "Go CI" --ref dev2-go`).
4. Never claim hosted green before push.

## Current evidence

| Ref | SHA |
|-----|-----|
| HEAD / origin/dev2-go | `222b4371d13cb64d934c8f52848d15608a634f9b` |
| origin/dev | `b7585565c593a4f4c03f188c9273a0ae129ca02a` |
| merge-base | `6a670bcefefa8f125ac12022446d85571349324c` |
| left-right | 131 / 31 |
| overlapping changed files | **0** |
| merge-tree write-tree | success (`94a3ea0349b7b8added8d35fe9a73e319da7b7ed`) |
| pre-rebase `go test ./...` | green |

## Dependency-ordered work-phase map (locked target)

| workPhaseId | Decade doc | Purpose |
|---|---|---|
| wp0_docs_roadmap | 000–003 | Docs-only inventory + A-gate + lock |
| wp1_rebase_dev | 010 | Rebase + local gates + force-with-lease + exact CI |
| wp2_sse_terminal_fidelity | 020 | SSE activity + adapter terminal truth + queue/chat incomplete + queue queue bound |
| wp3_cursor_continuity | 030 | store:false continuity / requested_model / isolated turns |
| wp4_shim_discovery | 040 | shim auto-restore + discovery status API |
| wp5_live_or_defer | 050 | GPT-Live relay **or** dependency-readiness deferral (not budget-as-success) |
| wp6_secondary_adapters | 060 | Kiro/pool/websearch/freeform/google residual |
| wp7_final_proof | 070 | Final exact-head CI + archive |

## Acceptance

1. `git merge-base --is-ancestor origin/dev HEAD`
2. Local Go gates green on tip
3. Hosted Go CI green for exact final SHA, no Node-20 deprecations
4. Each residual phase ported with tests or dependency-deferred with anchors
5. Criteria capturedEvidence non-empty

## Rollback

- Pre-push: abort rebase; tip remains `222b4371`
- Post-lease: only re-push previous tip with maintainer confirmation if consumers require it
- Never rewrite `dev`/`preview`/`main`
