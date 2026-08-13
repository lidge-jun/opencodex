---
title: FAB-00 Workspace and Lease Model
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 090 -- Workspace and Lease Model

## 1. Workspace modes

| Mode | Writes | Role | Enforcement |
|---|---|---|---|
| `primary` | Yes | Main implementer | one writer per worktree |
| `review` | No | Independent reviewer | OS/process sandbox **read-only** (git has no per-worktree perms -- `020` D) |
| `verify` | Isolated | Test/verifier | separate worktree, sandboxed |
| `observe` | No | Human/UI | no runtime write authority |
| `quarantine` | Isolated | Failed/suspicious output | locked, no merge |

Structure: base repository -> task branch -> {primary, reviewer, verifier, quarantined} worktrees.

**Rules:** one writer per worktree; no automatic merge of competing branches; dirty state checkpointed before handoff; untracked files require explicit inclusion rules; secret-pattern files excluded by default; reviewer worktrees read-only (OS-enforced); deletion is quarantine-first; recovery never discards ambiguous changes automatically.

## 2. Ownership, leases, fencing (sec.10)

- A task has many sessions but **one primary execution owner**.
- Every writable worktree has **one write lease**.
- Each ownership transition increments a **monotonic fencing token**; stale writers are rejected on token mismatch.
- Lease types: workspace write lease, handoff transaction lease, projection rebuild lease, compatibility test lease.

**On lease loss:**
1. Reject stale mutation (fencing token check).
2. Attempt native interruption.
3. Mark the run `lost`.
4. Quarantine ambiguous changes.
5. Emit recovery/security events.
6. Require explicit reconciliation (no auto-merge, no auto-discard).

## 3. Crash recovery (sec.15 crash matrix, `130`)

Kill the supervisor at each boundary; required recovery result:

| Crash point | Recovery |
|---|---|
| Before append | no state changed; retry from last event |
| After append before projection | event persisted; projection rebuild on restart |
| During artifact write | partial artifact discarded (hash mismatch detected); re-emit |
| During worktree creation | drop partial worktree; re-create |
| Before acknowledgement | handoff not committed; source retains ownership |
| After acknowledgement before ownership commit | handoff not committed; source retains; target session discarded |
| After ownership commit before source shutdown | target owns; source worktree downgraded; rescue if source still writing -> stale-writer fenced |

**Decision:** SQLite WAL + fsync + atomic rename for durability; events are the authority, snapshots optimize. A crash never leaves two writers; the fencing token is the single source of truth for "who may write."

## 4. Local IPC and authentication (sec.6.2, sec.18)

- **Transport:** Unix domain socket (Linux/macOS); named pipe (Windows); loopback TCP **only** for dev/explicit remote mode.
- **Credential:** dedicated agent-control credential -- **never** reuse data-plane or management-plane secrets. Same posture as opencodex's existing separation of `~/.opencodex` (opencodex-owned) from `$CODEX_HOME` (Codex-owned).
- **Dedicated scopes:** `task:read`, `task:create`, `task:run`, `task:handoff`, `task:approve`, `workspace:read`, `workspace:write`, `runtime:manage`, `compatibility:probe`, `admin`.

## 5. Permission translation (sec.18)

Capability `claimed|probed|verified|degraded|blocked|unknown` (only `verified` + accepted `degraded` satisfy mandatory). Harness permission models map to a normalized policy:

- Codex: `approvalPolicy` (`never`|`on-failure`|`on-request`|`always`) + `sandbox` (`read-only`|`workspace-write`|`danger-full-access`) + `permissions` profiles (`:workspace` etc.) -> normalized `command_approval` / `file_approval` / `sandbox` / `network` policy.
- Claude: SDK permission rules (allow/deny/ask) + sandbox config -> same normalized policy.

**Invariant:** permissions never widen without an approval event (`050` cross-machine invariants). A handoff with a wider effective policy than the source is **Tier-3 blocked** (`080` sec.4).

## 6. Privacy defaults (sec.9.4)

Do **not** persist by default: hidden reasoning, full terminal streams, provider secrets, OAuth tokens, environment variables, entire repository archives, arbitrary ignored files, raw prompts unrelated to continuity.

Persist only: explicit task instructions, plans, decisions, bounded metadata, required artifacts, hashes, opaque native refs, and redacted diagnostics. This mirrors opencodex's `usage.jsonl` invariant (`structure/05`: "never exposes prompts", `0o600`, request metadata + token counts only).

## 7. Deviation from plan sec.9-sec.18

None material. Concretized: read-only/quarantine enforced via OS not git; fencing token is the single write-authority source; privacy defaults aligned with the repo's existing usage invariant.
