---
title: FAB-00 Handoff
programme_id: OCAF
phase: FAB-00
final_status: PHASE_COMPLETE
verdict: CORRECTION_REQUIRED
date: 2026-08-03
---

# FAB-00 Handoff

## Phase
FAB-00 -- architecture authority and bounded technical spikes.

## Final status
`PHASE_COMPLETE` -- all required FAB-00 outputs produced; no blocker prevented completing the research/spike/decision phase. Programme verdict is `CORRECTION_REQUIRED` (`160`); FAB-01 is **not** authorised (`170`).

## Authority
This launch prompt (source-of-truth #1), the canonical master plan (`devlog/_plan/800_agent-fabric/000_master_plan.md`, copied from the provided source file per its own sec.0), and current repository state. Executed on a dedicated worktree `fab/00-agent-fabric` from `origin/main` (`bbb630e`). `main` was never modified; no other contributor's work was merged.

## Base / final commits
- **Base:** `f9b9440` (`origin/main`, release v2.10.0) -- the worktree was rebased onto current main after a fetch refreshed a stale local ref (initially `bbb630e`/v2.6.25).
- **Final (tip):** recorded in the terminal response below (tip of `fab/00-agent-fabric` after this handoff lands).

## Branch and repository state
- Branch `fab/00-agent-fabric` at `C:\Users\ws\opencodex-fab00`, created off `origin/main` (`bbb630e`). Clean tree before commits. `main` untouched. No native Codex/Claude storage mutated.

## Files changed
All under `devlog/_plan/800_agent-fabric/`: `010`-`170` (17 documents) + `handoffs/FAB-00.md` + `spikes/spike-a/`, `spikes/spike-b/`, `spikes/spike-c-kernel/` (source + captured output). **No** changes under `src/`, `bin/`, `tests/`, `gui/`, or `scripts/`. ci.yml path filters are not matched.

## Research completed
- Codex app-server (JSON-RPC, primitives Thread->Turn->Item, `thread/start`/`thread/resume`/`thread/rollback`, versioned `generate-ts`, events/approvals). `020` A.
- Claude Agent SDK (sessions resume/fork, permissions, hooks, structured output, `-p --output-format json`). `020` B.
- ACP?A2A convergence (Linux Foundation, v1.0, opaque, no ownership-transfer); AG-UI (agent?UI, cancel/resume); git worktree (no per-worktree perms). `020` C/D.
- Gateways (LiteLLM, TensorZero) confirm the commodity thesis + the continuity gap. `020` D. No "OpenAI Symphony" product found; closest is the OpenAI Agents SDK.

## Spike A/B/C evidence
- **Spike A -- PASS:** `codex app-server generate-ts` produced a full versioned schema enumerating the managed-execution surface incl. native `thread/rollback`. Evidence: `spikes/spike-a/`. Live `thread/start` not run (model-spend/auth boundary).
- **Spike B -- capability PASS; live headless attempt blocked by auth/TTY boundary** (design finding: use the in-process SDK). Evidence: `spikes/spike-b/summary.md`.
- **Spike C -- PASS:** 8/8 invariant tests + 5/5 crash-boundary recovery + FINAL verify. Evidence: `spikes/spike-c-kernel/` (`go test ./...`, `go run .`).

## Architecture decisions
Task Core (`040`: ULID task_id, content-hashed acceptance criteria, opaque native refs); state machines (`050`: Task/Run/Handoff/Workspace with `lost`/`quarantined` recoverable, fencing monotonic); event + artifact contracts (`060`: protobuf envelope, hash chain, normalised events, `RawRuntimeEvent` passthrough, content-addressed artifacts, trust labels); runtime adapter contract (`070`: mandatory/optional ops, native-resume vs semantic-continuation, Codex/Claude bindings); handoff transaction (`080`: 11 atomic stages, ownership-commit one-way door, machine-readable ack, loss-ledger tiers); workspace & lease model (`090`: OS-enforced read-only, fencing token as single write-authority, crash-recovery matrix, dedicated IPC + scopes, privacy defaults); conformance (`130`: manifests, scenarios, cross-language fixtures, hard-constraint ordering).

## Go authority
`IMPLEMENTATION_BLOCKED_PENDING_GO_AUTHORITY` (`120`). The sec.7 "Go migration line" premise is invalidated (no Go in repo). Recommended correction: TS-native Supervisor (matches repo + protobuf/MCP/zod stack) or, if the maintainer commits to it, an explicit Go migration line.

## Security findings
Threat model (`100`): assets/principals/boundaries/entry points/credential classes + 14 enumerated threats each with a grounded mitigation; deferred remote-worker risks to FAB-08; kill + recovery paths; security acceptance gates. No unresolved high-severity boundary requiring `NEEDS_HUMAN` to complete FAB-00.

## Privacy decision
Mirrors the repo's existing invariant (`structure/05`: `usage.jsonl` 0o600, never prompts): hidden reasoning / full terminal streams / secrets / tokens / env vars / raw prompts are **not** persisted by default (`090` sec.6). `bun run privacy:scan` invariant honored (no secrets/private content committed).

## Deviations

1. The canonical master plan (`000_master_plan.md`) was not pre-present at its repo path; it was **copied** from the provided source file (`C:\Users\ws\Downloads\000_master_plan.md`, 35,085 bytes) per the plan's own sec.0 instruction and as required-output file #1 -- not reconstructed from the launch prompt.
2. Spike A live `thread/start` not executed (model-spend/auth boundary); `generate-ts` schema is the deterministic primary evidence.
3. Spike B live headless `claude -p` blocked by an auth/TTY gate; capability confirmed via primary docs and the in-process SDK is the intended path.
4. Root `AGENTS.md`/`CONTRIBUTING.md`/`MAINTAINERS.md` not found at repo root (`010` sec.4); governance creation is a FAB-01 prerequisite (`170`).
5. Issues/PRs full pagination beyond the first page not completed (`010` sec.10); no overlap observed.

## Unresolved risks

1. **Language authority** -- maintainer must choose TS-native vs Go line (`120`/`170`). Highest-risk unresolved item.
2. **Product placement** -- Fabric as opencodex subsystem vs sibling project (`030` sec.2). Maintainer decision.
3. **Claude headless auth** -- programmatic structured ack must use the in-process SDK, not redirected headless CLI (`150` Spike B).
4. **git-enforced read-only** -- reviewer/quarantine must be OS/process-enforced, not git (`020` D/`090`).

## Corrections

Recommended plan corrections before FAB-01: (a) sec.7 -- remove the false "Go migration line" premise; record the chosen authority. (b) sec.13/sec.14 -- update "ACP adapter" framing to A2A-converged; local managed execution uses native SDKs (app-server, Agent SDK). (c) sec.17 -- note read-only/quarantine is OS-enforced. (d) sec.2.1 -- scope the "already owns useful seams" claim to provider routing; the Fabric adds a new upstream controller seam.

## FAB-01 authority status
NOT AUTHORISED. See `170`. Prerequisites: independent acceptance + maintainer language/placement decisions.

## Verification commands / results

- `git -C 'C:\Users\ws\opencodex-fab00' diff --check` -- whitespace clean (docs only).
- `go test ./...` (in `spikes/spike-c-kernel`) -> `ok fab00-spike-c/kernel 0.361s` (8/8 PASS).
- `go run .` (crash harness) -> all 5 boundaries recover + FINAL verify PASS.
- `codex app-server generate-ts --out <tmp>` -> full versioned schema generated (Spike A).
- ci.yml is **not** triggered (changes under `devlog/_plan/**` only).
- Native Codex storage: not mutated (verified -- spike writes confined to temp dirs + plan dir).
- Credentials: none committed.

## Evidence locations

`devlog/_plan/800_agent-fabric/spikes/spike-c-kernel/` (source + `test_output.txt` + `crash_output.txt`); `spikes/spike-a/` (`schema_summary.md`, `codex-version.txt`); `spikes/spike-b/` (`summary.md`, `ack-output.txt`, `ack-error.txt`).

## Recommended characteristics for the independent acceptance model

Re-run the high-value evidence (`go test`/`go run` in spike-c; `codex app-server generate-ts`); challenge the sec.7 Go-authority reasoning and the direction-mismatch finding (`010` sec.6/`030` sec.2); verify no `src/` changes and no native-storage mutation; confirm no credentials; issue `PASS` / `CORRECTION_REQUIRED` / `REJECTED`. This handoff self-assesses `CORRECTION_REQUIRED`.

## Statement

`FAB-01 IS NOT AUTHORISED BY THIS HANDOFF ALONE.`
