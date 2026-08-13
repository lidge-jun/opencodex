---
title: FAB-00 Decision Record
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 160 -- FAB-00 Decision Record

## Verdict: `CORRECTION_REQUIRED`

The programme **direction** is sound; the **plan** has a material incorrect assumption requiring correction before FAB-01. Evidence follows, not effort.

## What supports the direction

- Codex is externally manageable (Spike A PASS; `020` A).
- Claude is manageable + structured acknowledgement is supported (Spike B capability confirmed; `020` B).
- The task kernel is feasible (Spike C PASS -- all invariants + crash recovery).
- The continuity layer is a real gap (`020` F; LiteLLM etc. have no task continuity).
- Continuation offers materially more than a transcript converter (ownership, worktrees, loss ledger, fencing -- `080`/`090`).

## What requires correction (why not `PROCEED_TO_FAB_01`)

- Master plan sec.7 "parallel Go migration line" is **INVALIDATED** -- no Go in repo (`010` sec.8). `GO_FIRST_AUTHORISED` is not a valid decision (`120`). The FAB-00 pass-criterion "Go-first authority is valid" therefore **FAILS**.
- Direction mismatch: OpenCodex is a downstream provider proxy; the Fabric needs an upstream controller role (`010` sec.6, `030` sec.2) -- a new subsystem requiring maintainer product-placement authority.

## Why not `BLOCKED` or `REJECT_AGENT_FABRIC_DIRECTION`

- Not `BLOCKED`: FAB-00's own scope (research / spikes / decisions / handoff) completed; no technical blocker prevents producing the FAB-00 deliverables.
- Not `REJECT`: the *end* (durable cross-harness continuity) is valid; only the *means* (language + placement) needs correction. Spike evidence does not meet any block/reject criterion of sec.23.

## Corrections (resolved by maintainer decision 2026-08-03)

1. ~~Maintainer chooses language authority~~ **DONE** -- TS-native Supervisor (`120`).
2. ~~Maintainer confirms product placement~~ **DONE** -- opencodex subsystem (`030` sec.2).

Both corrections are recorded; the blockers they represented are resolved. Remaining FAB-01 prerequisites are independent acceptance + governance + explicit execution authority (`170`).

## FAB-00-ACCEPTANCE recommendation

Independent review should re-run: `go test ./...` + `go run .` in `spikes/spike-c-kernel`; `codex app-server generate-ts` (Spike A); challenge the `120` Go-authority reasoning; verify scope (no production code under `src/`); confirm no native storage mutated and no credentials committed. Issue `PASS` / `CORRECTION_REQUIRED` / `REJECTED`. This record self-assesses `CORRECTION_REQUIRED` pending that independent acceptance.
