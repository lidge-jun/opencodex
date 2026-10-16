# Deferred V1 collaboration surface (#6844 remainder) and #6984 drain deadline — lane L3

Release train 2.84.0, lane L3, branch `codex/rt284-issues-proxy`, first cut from `origin/dev` `3e58c2ce3e`
and later rebased onto lane L1's restacked head `1e4d9dad9a` (stack L2 → L1 → L3 → L4).
Coordinator thread `01a130be-2e10-7af0-adf9-efca9fe37e30` owns push, PR, merge and release.

## Objective

1. #6844 remainder. PR #6977 made `collabSurface()` read V1 tools that codex-rs renders inside the
   code-mode `exec` description. When the model supports tool search (every OpenCodex catalog row),
   codex-rs registers V1 as **deferred** and renders none of it, so those turns stay `null` and never
   receive the V1 Max/Ultra proactive guidance. Add a second, positive-only evidence source: the
   developer `<tools>` world-state fragment that lists deferred tool namespaces.
2. #6984. Verify that owner PR #6986 (lane L1, "Closes #6984") fixes the picker relay on Bun 1.4.2 and
   1.4.3 and record the residual. As first planned, no listener change in this lane: a parallel edit of
   `src/claude/intercept/picker-listener.ts` would conflict with L1's stack. **Amended:** the coordinator
   then approved a stacked commit on L1 that bounds the post-EOF drain #6986 added; see
   `020_6984_verification.md`.

## Evidence (codex-rs `openai/codex` @ `16845bb8e8`, 2026-10-12)

- `core/src/context/world_state/tools.rs:29-147` — `ToolsState` renders a **developer** fragment
  `<tools>\nDeferred tool namespaces:\n- <ns>[: <first line, <=250 chars>]\n...</tools>` the first time,
  then only diffs `Added deferred tool namespaces:` / `Removed deferred tool namespaces:`, and
  `No deferred tool namespaces remain.` when empty (`:159`). Omitted rows render
  `... <n> additional namespaces omitted.` (`:203-210`); the fragment is capped at 4 KiB (`:25`);
  names are reserved before descriptions (`tools_budget.rs:27-69`), so a row may be name-only.
- `core/src/session/world_state.rs:318-326` adds the section only when `Feature::DeferredToolWorldState`
  is enabled; `features/src/lib.rs:1572-1575` marks it UnderDevelopment, default off. Codex Desktop
  sessions routed through OpenCodex were observed receiving it (`- multi_agent_v1: Tools for spawning and
  managing sub-agents.`). Feature-off clients stay undetectable — documented, not claimed fixed.
- `core/src/tools/spec_plan.rs:1561-1588` registers V1 tools with `ToolExposure::Deferred` when
  `supports_search_tool`; `core/src/tools/handlers/multi_agents_spec.rs:14` fixes the namespace
  `multi_agent_v1`. V2 tools are `Direct`/`DirectModelOnly` (`spec_plan.rs:1468-1472`), never deferred.
- OpenCodex: developer items reach `parsed.context.messages` with role `developer`
  (`src/responses/parser.ts:318-330`); no OpenCodex code injects or strips `<tools>` items.
  Structured `tool_search` tools carry `toolSearch: true` (`src/responses/parser-tools.ts:120-128`).

## Architect consultation (gpt-6.1-sol, agent 01a130cb-020d-78e3-bd33-396cb4d12bfb)

| ID | Proposal | Main disposition |
|---|---|---|
| D1 | New `deferred-collab-surface.ts`, read developer messages only, standalone `<tools>` fragments | Accepted |
| D2 | Ordered replay: snapshot replaces, added adds, removed removes, empty clears; omitted removals invalidate carried membership; omitted additions never establish; malformed fragment clears carried evidence | Accepted |
| D3 | Host coherence: genuine code-mode exec (existing guards) or a structured `toolSearch` tool; expose rendered foreign-collab claim even without rendered V1 | Accepted |
| D4 | Combination in `collabSurface()` mirrors #6977; deferred evidence never yields V2 | Accepted |
| D5 | Docs: `structure/subagents.md`, English `sub-agent-surface` guide, stale helper comments | Accepted; commit says "Refs #6844", closure is the coordinator's decision because feature-off clients remain undetectable |

Architect for #6984 (agent 01a130cb-02bd-77d2-9f9b-2feaac02de82) proposed a raw-TLS h1 transport
rewrite (D1-D6). Disposition: **rejected for this lane** — #6986 already lands a targeted listener fix
(its PR reports green on Bun 1.4.0/1.4.2/1.4.3; this lane re-ran 1.4.2 and 1.4.3); the rewrite is a
separate design. Residual recorded: the post-EOF ciphertext drain added by #6986 had no deadline —
the coordinator approved bounding it in this lane (architect D4's drain budget, without the rewrite).

## Work-phase map

| Phase | Doc | Outcome |
|---|---|---|
| wp1 | `010_deferred_v1_evidence.md` | Commit `33747c4188` (rebased from reviewed `86ea92a69d`): deferred V1 evidence + tests + docs |
| wp2 | `020_6984_verification.md` | Verification of #6986, then commit `5e943bfe69`: bounded post-EOF discard + deterministic test |
| wp3 | this record | Gates, independent sol review of final head, status report, this docs commit |

## Out of scope

Push, PR, merge, issue comments and issue closure (coordinator-owned), other lanes' files.
`picker-listener.ts` was out of scope until the coordinator approved the stacked drain deadline.

## Final state

- Head of code commits `5e943bfe69ccfc830937374bf8ccd443871407d1` on L1 `1e4d9dad9ab8c133b0f7c531ed52734d65b9b2d8`;
  this docs commit follows it. Nothing pushed.
- `33747c4188` and the reviewed `86ea92a69d` share `git patch-id --stable` `34db79974f`; the final
  review confirmed every non-layout blob byte-identical and both layout maps hold every entry from
  both sides (`scripts/test-layout/layout.json` 1999 lines).
- Reviews (gpt-6.1-sol): #6844 architect `01a130cb-020d` ALIGNED after two folds; plan audit
  `01a130d2-b434` FAIL → NEAR-PASS; #6844 final-head review `01a130e2-226d` FAIL (U+2028/U+2029,
  repeated headings) → PASS at `86ea92a69d`; stacked final-head review `01a130f4-959e` NEAR-PASS
  (P3 doc overstatement) → PASS at `5e943bfe69`; wp3 plan audit PASS.
- Lane terminal status: both lane commits done and reviewed. Pushing, the stacked PR, merge, release
  and closing #6844/#6984 belong to the coordinator. #6844 stays "Refs": feature-off Codex clients
  remain undetectable.

