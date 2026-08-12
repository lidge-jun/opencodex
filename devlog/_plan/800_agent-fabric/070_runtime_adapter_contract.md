---
title: FAB-00 Runtime Adapter Contract
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 070 -- Runtime Adapter Contract

## 1. Mandatory operations

`probe`, `describeCapabilities`, `launch`, `startSession`, `subscribe`, `sendInput`, `interrupt`, `closeSession`, `inspectSession`, `prepareExport`.

## 2. Optional operations

`resumeSession`, `forkSession`, `adoptSession`, `checkpoint`, `restoreCheckpoint`, `steer`, `requestReview`, `listSessions`.

## 3. Normalised events

As `060` sec.2. Unknown native events -> `RawRuntimeEvent`; adapters **must not guess**.

## 4. Native resume vs semantic continuation

- **Native resume:** the harness restores its own session (`resumeSession`). Adapter reports the capability as `probed|verified|degraded|blocked`.
- **Semantic continuation:** a NEW target session receives the Task Core + workspace + git state + decisions + evidence refs + outstanding work + bounded brief + effective policy + Semantic Loss Ledger. Distinct in the event model: `SessionStarted.cause = semantic_continuation` vs `SessionResumed`. The UI/event model names these differently (sec.13).

## 5. Adapter bindings (grounded in `020`)

- **Codex adapter:** `codex app-server` JSON-RPC (stdio or unix socket). `thread/start` + `thread/resume` map to `startSession` / `resumeSession`. Approvals / plan / file-change events map to the normalised set. `cwd` = worktree path; `approvalPolicy` / `sandbox` / `permissions` translated from `policy_snapshot`. Versioned schema via `generate-ts`. **No native-storage mutation.**
- **Claude adapter:** Claude Agent SDK (TypeScript, in-process). Sessions resume/fork; Hooks -> approval/permission events; structured output for acknowledgement; reviewer = read-only permission profile. Other-language hosts use `claude -p --output-format json` as a subprocess adapter.

## 6. Capability status

`claimed | probed | verified | degraded | blocked | unknown`. Only `verified` and explicitly-accepted `degraded` satisfy mandatory requirements (`130`).
