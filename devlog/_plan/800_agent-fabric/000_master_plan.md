---
title: OpenCodex Agent Fabric Master Plan
programme_id: OCAF
status: proposed
version: 0.1
date: 2026-07-30
repository: lidge-jun/opencodex
canonical_path: devlog/_plan/800_agent-fabric/000_master_plan.md
---

# OpenCodex Agent Fabric Master Plan

## 0. Authority and use

This document defines the proposed OpenCodex Agent Fabric programme. Copy it to:

```text
devlog/_plan/800_agent-fabric/000_master_plan.md
```

Future agents must use current repository state, current source-of-truth documents, accepted decision records, and completed phase handoffs over stale assumptions in this document. No phase is authorised merely because it is described here.

Agents must not rely on chat history.

---

# 1. Executive decision

OpenCodex should expand from a model/provider compatibility layer into a **local-first runtime for portable coding-agent tasks**.

The proposed subsystem is named **OpenCodex Agent Fabric**.

Long-term promise:

> Start work in one coding harness, continue it in another, fork independent reviewers, preserve repository state and evidence, and make every semantic loss explicit.

First production objective:

> A Fabric-owned Codex task can be safely continued in Claude Code through an atomic, capability-aware, loss-aware handoff into an isolated Git worktree.

Agent Fabric is not:

- A generic chat-history converter.
- A universal replacement protocol for all coding agents.
- A replacement for Codex, Claude Code, Gemini CLI, or editor-native agents.
- A cloud-first multi-tenant platform.
- An autonomous swarm framework.
- A mechanism for exporting hidden reasoning.
- Another provider-routing feature bundle with more dashboard cards.

---

# 2. Strategic rationale

## 2.1 OpenCodex already owns useful seams

OpenCodex already crosses boundaries that a generic router normally does not:

- Codex, Claude Code, Claude Desktop, Grok Build, and related client surfaces.
- OpenAI Responses, OpenAI Chat Completions, Anthropic, Gemini, and provider-specific transports.
- Provider credentials, OAuth identities, API keys, account pools, affinity, quotas, and cooldowns.
- Model catalogues and capability adaptation.
- Streaming lifecycle translation.
- Tool calls, MCP namespaces, images, reasoning controls, usage accounting, continuation state, and structured errors.
- Local CLI, dashboard, service lifecycle, management API, and startup safety.

This makes OpenCodex a credible place to coordinate task continuity across harnesses.

> FAB-00 correction (2026-08-03): these are provider-routing / data-plane seams. The Fabric's managed-execution role (Fabric -> codex app-server / Claude Agent SDK) is a separate upstream controller, not an extension of the `/v1/responses` seam. The Fabric runs in its own process boundary and does not reuse the data plane (`010` #6, `030` #2).

## 2.2 Gateway features are becoming commodities

9Router, OmniRoute, LiteLLM, Bifrost, Portkey, TensorZero, and similar projects increasingly compete on:

- Provider count.
- Fallback and load balancing.
- Cost and latency routing.
- Quota management.
- Compression.
- Circuit breakers.
- Analytics.
- Virtual keys and budgets.
- Protocol support.

These remain useful, but they do not create a durable category for OpenCodex.

## 2.3 The missing layer

The open gap is **durable coding-task continuity across native harnesses**.

Existing systems generally solve one layer:

- Inference routing.
- Tool connectivity.
- Editor-to-agent communication.
- Agent-to-agent delegation.
- UI event transport.
- Transcript conversion.
- Issue-driven scheduling.
- Proprietary orchestration.

They do not usually preserve one task across:

- Native session identities.
- Repository and worktree ownership.
- Typed command, tool, file, plan, and approval events.
- Verification evidence and artifacts.
- Runtime capability differences.
- Handoff provenance.
- Explicit semantic loss.
- Crash recovery.
- Stale-writer fencing.

Agent Fabric targets this layer.

---

# 3. Product thesis

## 3.1 Canonical abstraction

The canonical abstraction is an **OpenCodex Task**, not a request and not a transcript.

A task records:

- Goal and acceptance criteria.
- Repository and workspace identity.
- Runtime sessions.
- Typed events.
- Explicit plans and decisions.
- Tool and command evidence.
- File changes.
- Approvals.
- Verification results.
- Artifacts.
- Ownership.
- Handoffs.
- Capability manifests.
- Semantic loss.
- Security observations.
- Parent/child lineage.

A transcript is only one projection.

## 3.2 Native state remains native

OpenCodex must not flatten every harness into a weakest-common-denominator transcript.

The Fabric task stores stable native references, normalised events the adapter understands, capability evidence, and opaque native-state references where necessary. It must not fabricate unsupported native state.

## 3.3 Portability must be honest

Every cross-harness handoff produces a **Semantic Loss Ledger** classifying state as:

- `native`
- `normalised`
- `reconstructed`
- `summary_only`
- `omitted`
- `unavailable`
- `unsafe`

The target acknowledges the task, workspace, acceptance criteria, effective policy, and loss-ledger hash before ownership changes.

---

# 4. Alternatives considered

## 4.1 Transcript converter

Convert native session histories into a shared document and inject that document into another harness.

Advantages:

- Small scope.
- Immediate demo.
- Useful fallback when native APIs are weak.

Weaknesses:

- Preserves narrative, not complete execution state.
- Cannot reliably transfer approvals, ownership, tool lifecycle, permissions, or native continuation.
- Easy to copy.
- Easy to overclaim.

Decision: retain only as a degraded fallback.

## 4.2 Central task runtime with native adapters

OpenCodex owns the durable task while native harnesses retain their own session semantics.

Advantages:

- Preserves richer semantics.
- Supports continuation, fork, review, verification, and rescue.
- Allows incremental harness integration.
- Builds a compatibility/conformance moat.
- Separates task ownership from inference routing.

Weaknesses:

- High complexity.
- New persistence and security boundaries.
- Requires leases, worktrees, crash recovery, and strict migration authority.

Decision: selected.

## 4.3 Universal public protocol first

Define one OpenCodex protocol for sessions, tools, files, approvals, workers, tasks, artifacts, and UIs.

Weaknesses:

- Either collapses to the weakest common subset or becomes too large to adopt.
- Duplicates Codex App Server, ACP, A2A, AG-UI, and MCP boundaries.
- Encourages protocol work before task semantics exist.

Decision: rejected.

## 4.4 Issue-driven autonomous scheduler

Use issues as canonical tasks and launch isolated agents to complete them.

Decision: useful later as a task-source adapter, but not the initial product.

---

# 5. Architectural principles

1. **The task is canonical.** It survives runtime, model, provider, UI, and process changes.
2. **Harness-native state remains native.** Adapters preserve, reference, or declare loss.
3. **Deterministic orchestration owns mutation.** Models propose; the supervisor validates and commits.
4. **Capability negotiation precedes execution.** Unknown does not mean supported.
5. **One writer per workspace.** Parallel writers require separate worktrees.
6. **Permissions may narrow automatically, never widen automatically.**
7. **Protocols are boundary adapters.** They do not define the internal task.
8. **Local-first.** Repositories, credentials, and execution remain on the owning machine initially.
9. **A failed handoff leaves one authoritative owner.**
10. **No hidden reasoning export.** Preserve explicit plans, decisions, summaries, and evidence only.
11. **Evidence beats claims.** Completion, verification, and capability status require artifacts.
12. **No duplicated orchestration kernels.** The TypeScript/Go transition must have one production authority.

---

# 6. System architecture

```text
+----------------------------------------------------------+
| User surfaces                                            |
| CLI * OpenCodex dashboard * future ACP clients           |
+---------------------------+------------------------------+
                            |
                     Agent-control API
                            |
+---------------------------+------------------------------+
| OpenCodex Fabric Supervisor                              |
|                                                          |
| Task kernel        Ownership/leases     Handoff engine   |
| Event store        Policy engine        Artifact store   |
| Projections        Workspace manager    Compatibility DB |
| Runtime registry   Recovery manager     Security stream  |
+--------------+-------------------+-----------------------+
               |                   |
       Runtime adapter API   Existing OpenCodex data plane
               |                   |
      +--------+--------+     Providers, accounts, quotas,
      |        |        |     adapters, routing, usage
 Codex App  Claude   Generic ACP
 Server     adapter    adapter
      |        |        |
+-----+--------+--------+----------------------------------+
| Managed native harness processes and Git worktrees       |
+----------------------------------------------------------+
```

## 6.1 Process boundary

The Fabric Supervisor should be a separate local process boundary, even if shipped in the same Go distribution.

Reasons:

- A hung agent runtime must not block model routing.
- Durable task state has a different lifecycle.
- Repository mutation creates a distinct security boundary.
- Supervisor restart must not drop inference traffic.
- It avoids implementing the task kernel twice during the Go migration.

## 6.2 Local IPC

Preferred:

- Unix domain socket on Linux/macOS.
- Named pipe on Windows.
- Loopback TCP only for development or explicit remote mode.

Use a dedicated agent-control credential. Do not reuse data-plane or management-plane secrets.

---

# 7. TypeScript and Go authority

OpenCodex currently uses `dev` for normal integration and a parallel Go migration line. Applicable behaviour must eventually exist in the Go runtime.

> FAB-00 correction (2026-08-03): the "parallel Go migration line" premise is INVALIDATED by FAB-00 evidence: current `origin/main` (v2.10.0) has no `go.mod` and no `*.go`; OpenCodex is 100% TypeScript/Bun; OpenAI Codex is Rust, not Go (`010` #8, `020` F). The preferred `GO_FIRST_AUTHORISED` outcome is therefore not valid against current repo state. **Maintainer decision (2026-08-03): the Fabric is a TS-native Supervisor within opencodex as a subsystem** (see `120`). The plan's "no dual complete implementations" rule is satisfied trivially (one runtime, TypeScript/Bun).

The programme must not build a full TypeScript Fabric and later port it.

FAB-00 must select one outcome:

## Preferred: `GO_FIRST_AUTHORISED`

- Production Fabric Supervisor is Go-native.
- Contracts, fixtures, and documentation may land on `dev`.
- TypeScript receives only launcher/client, dashboard, generated-schema, or migration shims.
- No TypeScript event-store, lease, workspace, or handoff kernel.

## Fallback: `IMPLEMENTATION_BLOCKED_PENDING_GO_AUTHORITY`

- Contracts and spikes may complete.
- Production work pauses.

## Rejected: dual complete implementations

A full TypeScript implementation followed by a later Go port is not a passing programme result without explicit maintainer override.

Language-neutral contracts must cover:

- Event envelope.
- Task Core.
- Capability manifest.
- Runtime adapter contract.
- Semantic Loss Ledger.
- Handoff acknowledgement.
- IPC messages.
- Conformance fixtures.

FAB-00 must choose the contract representation based on versioning, generated bindings, unknown-field tolerance, fixture readability, and cross-language tests.

---

# 8. Domain model

## 8.1 Separate state machines

### Task

```text
open
completed
cancelled
quarantined
```

### Run

```text
created
starting
running
waiting_input
waiting_approval
paused
completed
failed
cancelled
lost
```

### Handoff

```text
proposed
preparing
awaiting_approval
starting_target
committing
completed
rolled_back
failed
```

### Workspace

```text
registered
preparing
ready
owned
read_only
dirty
quarantined
released
archived
```

## 8.2 Task Core

```text
Task
+- identity
|  +- task_id
|  +- schema_version
|  +- created_at
|  +- created_by
|  +- parent_task_id / fork_point
+- objective
|  +- title
|  +- goal
|  +- acceptance_criteria[]
|  +- constraints[]
|  +- unresolved_questions[]
+- repository
|  +- canonical_remote
|  +- repository_id
|  +- base_commit
|  +- target_branch
|  +- workspace_policy
+- policy_snapshot
|  +- sandbox
|  +- network
|  +- command_approval
|  +- file_approval
|  +- secrets_policy
|  +- allowed_runtimes/providers
+- execution
|  +- current_owner
|  +- active_run
|  +- runtime_sessions[]
|  +- workspaces[]
|  +- handoffs[]
+- evidence
|  +- artifacts[]
|  +- verification_runs[]
|  +- decisions[]
|  +- claims[]
+- provenance
   +- events[]
   +- capability_manifests
   +- semantic_loss_ledgers
   +- security_observations
```

## 8.3 Runtime Session

Required fields:

- Runtime-session ID.
- Task ID.
- Adapter and version.
- Harness and version.
- Native session ID.
- Native state reference.
- Workspace ID.
- Role.
- Capabilities at start.
- Policy at start.
- Status and terminal reason.

Initial roles:

- `primary`
- `reviewer`
- `verifier`
- `observer`

## 8.4 Artifacts

Initial types:

- Patch.
- Diff.
- Commit.
- Test report.
- Build report.
- Review report.
- Security finding.
- Decision record.
- Plan.
- Screenshot.
- Generated file.
- Bounded log excerpt.
- Handoff package.
- Semantic Loss Ledger.

Every artifact needs a content hash, producer, runtime session, workspace, Git state, MIME type, size, trust label, redaction state, and creation event.

## 8.5 Claims and evidence

A claim records:

- Statement.
- Producer.
- Required evidence class.
- Supporting artifacts.
- Validation status.
- Validator.
- Superseding claim.

Examples:

- "Unit tests pass."
- "The target accepted the handoff."
- "The source worktree is unchanged."
- "No actionable security issue remains."

---

# 9. Persistence

## 9.1 Narrow event sourcing

Event-source Fabric task state only. Do not migrate unrelated OpenCodex configuration or routing state.

## 9.2 Layout

```text
~/.opencodex/fabric/
+- fabric.sqlite
+- artifacts/
|  +- sha256/<prefix>/<hash>
+- runtime-state/
+- exports/
+- backups/
+- logs/
```

Never share SQLite files or transactions with native Codex storage.

## 9.3 Core tables

- `tasks`
- `task_events`
- `runtime_sessions`
- `workspaces`
- `leases`
- `handoffs`
- `artifacts`
- `capability_manifests`
- `conformance_results`
- `security_observations`

Suggested `task_events` fields:

```text
task_id
sequence
event_id
event_type
schema_version
occurred_at
actor_type
actor_id
runtime_session_id
payload_json
previous_event_hash
event_hash
```

Requirements:

- Expected-sequence append.
- Unique event IDs.
- Rebuildable projections.
- Versioned events.
- Snapshot optimisation without replacing event authority.

## 9.4 Privacy defaults

Do not persist by default:

- Hidden reasoning.
- Full terminal streams.
- Provider secrets.
- OAuth tokens.
- Environment variables.
- Entire repository archives.
- Arbitrary ignored files.
- Raw prompts unrelated to task continuity.

Persist only explicit task instructions, plans, decisions, bounded metadata, required artifacts, hashes, references, and redacted diagnostics.

---

# 10. Ownership, leases, and fencing

A task may have many sessions but one primary execution owner.

Every writable worktree has one write lease.

Each ownership transition increments a monotonic fencing token. Every mutating runtime event carries the current token. Late events using an older token are rejected.

Lease classes:

- Primary execution lease.
- Workspace write lease.
- Handoff transaction lease.
- Projection rebuild lease.
- Compatibility test lease.

On lease loss:

1. Reject stale mutation.
2. Attempt native interruption.
3. Mark the run `lost`.
4. Quarantine ambiguous changes.
5. Emit recovery/security events.
6. Require explicit reconciliation.

---

# 11. Runtime adapter contract

## Mandatory operations

```text
probe
describeCapabilities
launch
startSession
subscribe
sendInput
interrupt
closeSession
inspectSession
prepareExport
```

## Optional operations

```text
resumeSession
forkSession
adoptSession
checkpoint
restoreCheckpoint
steer
requestReview
listSessions
```

## Normalised events

```text
SessionStarted
SessionResumed
RunStarted
RunProgress
UserMessage
AgentMessage
PlanUpdated
ReasoningSummary
ToolCallStarted
ToolCallCompleted
CommandProposed
CommandOutput
FileChangeProposed
FileChangeCompleted
ApprovalRequested
ApprovalResolved
ArtifactProduced
UsageUpdated
RunInterrupted
RunCompleted
RunFailed
SessionClosed
RawRuntimeEvent
```

Each event retains native type, native ID, adapter version, task, workspace, runtime session, and optional raw-event reference.

Unknown events become `RawRuntimeEvent`. Adapters must not guess.

---

# 12. Codex adapter

Use Codex App Server for managed execution. Do not directly mutate native session storage.

Required capabilities:

- Thread start, resume, and fork.
- Turn start and interrupt.
- Typed item events.
- Command and file approvals.
- Plan and diff events.
- Usage and terminal status.
- Restart and reconnect.

Initial limitations:

- Fabric-created or Fabric-managed sessions.
- Read-only import of existing sessions.
- No promise of seizing an active Codex Desktop thread.
- No two writers controlling one active thread.
- No direct SQLite or rollout edits.
- No promise of provider-private state portability.

All paths must be canonicalised and tested across platforms and symlink cases.

---

# 13. Claude adapter

FAB-00 must evaluate the official Claude Agent SDK and maintained ACP adapter path.

> FAB-00 correction (2026-08-03): ACP has merged into A2A under the Linux Foundation (`020` C). Local managed execution uses the native SDKs (codex app-server for Codex; Claude Agent SDK for Claude), not the ACP/A2A protocol. A2A is deferred to the FAB-08 remote boundary (`070`, `110`).

Required MVP capabilities:

- Managed session.
- Assigned worktree.
- Permission events.
- File-change events.
- Tool/command events.
- Cancellation.
- Read-only reviewer mode.
- Structured handoff acknowledgement.
- Native session identity where available.

Distinguish:

## Native resume

The harness restores its own session.

## Semantic continuation

A new target session receives the Task Core, current workspace, Git state, explicit decisions, relevant evidence, outstanding work, bounded handoff brief, effective policy, and Semantic Loss Ledger.

The UI and event model must name these differently.

---

# 14. Protocol boundaries

- **Codex App Server:** managed Codex execution.
- **ACP:** generic harness integration and future editor clients. (FAB-00 correction: converged into A2A under the Linux Foundation; local managed execution uses native SDKs -- `110`.)
- **MCP:** tools and external context.
- **AG-UI:** later dashboard/mobile event projection.
- **A2A:** later external delegation and remote boundaries.
- **OpenCodex Task Core:** internal source of truth.

Do not begin with A2A or AG-UI. Internal task semantics must work locally first.

---

# 15. Semantic Loss Ledger

## Classes

| Class | Meaning |
|---|---|
| `native` | Same semantic supported natively |
| `normalised` | Equivalent Fabric concept |
| `reconstructed` | Recreated from durable evidence |
| `summary_only` | Only bounded explanation transfers |
| `omitted` | Excluded by policy |
| `unavailable` | Source cannot expose it |
| `unsafe` | Transfer violates policy or widens privilege |

## Tiers

### Tier 0

All required semantics are native or normalised.

### Tier 1

Bounded reconstruction or summary-only loss with no safety or acceptance impact. Show warning.

### Tier 2

Material context, plan, tool, workspace, or evidence loss. Require explicit approval.

### Tier 3

Permission widening, inconsistent workspace, ambiguous ownership, or missing mandatory evidence. Block.

## Target acknowledgement

The target acknowledges:

- Task ID.
- Workspace ID.
- Base commit.
- Current checkpoint.
- Acceptance-criteria hash.
- Loss-ledger hash.
- Effective policy.
- Adapter and runtime versions.

---

# 16. Atomic handoff

1. Validate target capability, health, provider/model availability, policy, workspace, and loss tier.
2. Acquire handoff lease.
3. Reach a source safe point.
4. Freeze repository and workspace evidence.
5. Produce handoff package.
6. Create target worktree.
7. Start target without ownership.
8. Receive structured acknowledgement.
9. Commit ownership transfer atomically.
10. Increment fencing token.
11. Release source ownership.

Before ownership commit, failure rolls back to the source. After ownership commit, failure is a target-runtime failure handled by rescue or explicit reversal.

A handoff must never leave both source and target with valid write authority.

---

# 17. Workspace architecture

Modes:

| Mode | Writes | Role |
|---|---:|---|
| `primary` | Yes | Main implementer |
| `review` | No | Independent reviewer |
| `verify` | Isolated | Test/verifier |
| `observe` | No | Human/UI |
| `quarantine` | Isolated | Failed/suspicious output |

Structure:

```text
base repository
+- task branch
   +- primary worktree
   +- reviewer worktree
   +- verifier worktree
   +- quarantined worktrees
```

Rules:

- One writer per worktree.
- No automatic merge of competing branches.
- Dirty state is checkpointed before handoff.
- Untracked files require explicit inclusion rules.
- Secret-pattern files are excluded by default.
- Reviewer worktrees are read-only (FAB-00 correction: enforced via OS/process sandbox, not git -- `020` D / `090`).
- Deletion is quarantine-first.
- Recovery never discards ambiguous changes automatically.

---

# 18. Security architecture

## Trust boundaries

- Human operator.
- Fabric Supervisor.
- OpenCodex request proxy.
- Runtime adapter.
- Native harness.
- Model/provider.
- MCP server.
- Repository content.
- External content.
- Imported task package.
- Future remote worker.

## Dedicated credential

Suggested scopes:

```text
task:read
task:create
task:run
task:handoff
task:approve
workspace:read
workspace:write
runtime:manage
compatibility:probe
admin
```

Agent-control credentials remain separate from data-plane, management, and GUI credentials.

## Owner-only actions

Agents cannot decide:

- Credential addition.
- Remote-worker authorisation.
- Permission widening.
- Tier 2 loss acceptance.
- Sensitive task export.
- Unattended execution.
- Security-policy disablement.

## Persistent security monitoring

Correlate suspicious changes across runs, not only within one diff.

## Trust labels

```text
trusted_user
trusted_runtime
untrusted_model
untrusted_repository
untrusted_external
verified_test
verified_human
quarantined
```

## Required kill paths

- Interrupt run.
- Revoke ownership.
- Freeze workspace.
- Disable adapter.
- Disable Fabric network.
- Quarantine task.
- Stop Fabric without stopping the proxy.
- Recover from committed events and checkpoints.

---

# 19. Compatibility and conformance

Manifest dimensions:

```text
harness
harness_version
adapter
adapter_version
protocol
operating_system
workspace_mode
provider
model
reasoning_mode
sandbox_mode
capabilities
known_degradations
tested_at
evidence
```

Capability status:

```text
claimed
probed
verified
degraded
blocked
unknown
```

Only verified and explicitly accepted degraded capabilities satisfy mandatory requirements.

Required scenarios:

- Session start/resume/fork/interrupt/cancel/close/recovery.
- Text, images, structured context, streaming, duplicate/out-of-order events.
- Serial/parallel/MCP tool calls, errors, cancellation.
- File read/edit/patch, dirty worktree, symlink path, permissions.
- Command/file approvals, decline, expiry, restart.
- Native resume, semantic continuation, reviewer fork, loss block, stale lease.
- Runtime and supervisor crashes.
- Disk full, database busy, artifact failure, worktree failure, network loss, quota exhaustion.

Each result records exact versions, fixtures, input/output events, exit status, artifact hashes, environment, expected semantics, and observed semantics.

---

# 20. CLI direction

```bash
ocx task create
ocx task list
ocx task show <task>
ocx task inspect <task>
ocx task start <task> --runtime codex
ocx task continue <task> --runtime claude
ocx task fork <task> --runtime gemini --role reviewer
ocx task verify <task> --runtime codex
ocx task rescue <task> --runtime claude
ocx task handoff <task> --to claude --preview
ocx task import codex <thread-id>
ocx runtime probe codex
ocx compat test codex --scenario native-fork
ocx workspace quarantine <id>
```

`import` is read-only. `adopt` or `continue` must not imply control of an already active external process.

---

# 21. Dashboard direction

Add a **Tasks** control surface rather than a replacement chat application.

Task detail tabs:

- Overview.
- Timeline.
- Workspaces.
- Sessions.
- Evidence.
- Handoffs.
- Security.

The flagship UI is the handoff preview showing:

- Target readiness.
- Native versus semantic continuation.
- Proposed worktree.
- Effective permissions.
- Loss tier.
- Preserved, reconstructed, unavailable, omitted, and unsafe state.
- Required approval.

---

# 22. Programme execution protocol

Every phase requires:

1. Explicit execution authority.
2. Execution output.
3. Handoff.
4. Independent acceptance.
5. Correction phase when necessary.
6. Explicit authority for the next phase.

## Source-of-truth order

1. Current phase authority.
2. Current repository state.
3. Current structure/maintainer source of truth.
4. Accepted phase handoffs.
5. This master plan.
6. Historical investigations.
7. Chat history is prohibited.

## Terminal states

Every phase ends with exactly one:

- `PHASE_COMPLETE`
- `BLOCKED`
- `NEEDS_HUMAN`

No terminal state automatically authorises the next phase.

## Handoff requirements

- Phase and status.
- Authority.
- Base/final commits.
- Branch and repository state.
- Changed files.
- Commands and tests.
- Evidence.
- Decisions.
- Findings.
- Deviations.
- Risks.
- Next-phase recommendation.
- Explicit statement that later work is not authorised by the handoff alone.

---

# 23. Programme phases

## FAB-00: architecture authority and bounded spikes

### Objective

Attempt to disprove the programme before production implementation.

### Allowed

- Repository assessment.
- Research.
- Architecture decisions.
- Contract prototypes.
- Threat model.
- Fixtures.
- Bounded disposable spikes.

### Prohibited

- Production Fabric implementation.
- Starting FAB-01.
- Native Codex storage mutation.
- Full TypeScript orchestration kernel.
- Remote workers.
- A2A service.
- Automatic multi-agent routing.

### Required files

```text
devlog/_plan/800_agent-fabric/
+- 000_master_plan.md
+- 010_live_repository_assessment.md
+- 020_research_landscape.md
+- 030_alternatives_and_decisions.md
+- 040_task_domain_model.md
+- 050_state_machines.md
+- 060_event_and_artifact_contracts.md
+- 070_runtime_adapter_contract.md
+- 080_handoff_transaction.md
+- 090_workspace_and_lease_model.md
+- 100_security_threat_model.md
+- 110_protocol_boundaries.md
+- 120_ts_go_runtime_authority.md
+- 130_conformance_strategy.md
+- 140_spike_plan.md
+- 150_spike_results.md
+- 160_fab00_decision_record.md
+- 170_fab01_authority_or_block.md
+- handoffs/
   +- FAB-00.md
```

### Spike A: Codex App Server

Prove or disprove:

- Start.
- Resume.
- Fork.
- Interrupt.
- Approval events.
- Plan events.
- File-change events.
- Restart/reconnect.
- Stable identifiers.
- Cross-platform viability.

### Spike B: Claude path

Prove or disprove:

- Managed session.
- Assigned worktree.
- Permission event.
- File event.
- Cancellation.
- Read-only review.
- Structured package.
- Machine-readable acknowledgement.

### Spike C: task kernel

Prove or disprove:

- Append-only event.
- Expected-sequence concurrency.
- Projection rebuild.
- Event version handling.
- Artifact hashing.
- Lease and fencing.
- Stale-writer rejection.
- Recovery at handoff crash boundaries.

### FAB-00 pass criteria

- Codex is manageable through supported APIs.
- Claude can acknowledge structured state.
- Replay is deterministic.
- Fencing prevents stale mutation.
- Go-first authority is valid.
- Privacy and security boundaries are explicit.
- Continuation offers more than summary injection.
- No production feature escapes spike scope.

### FAB-00 block/reject criteria

- Native events are insufficient.
- Reliable interruption/cancellation is impossible.
- Structured acknowledgement is not feasible.
- Two complete supervisors are required.
- Ownership cannot remain unambiguous.
- Security or privacy boundaries are unacceptable.
- Cross-harness continuation provides no material advantage over a transcript converter.

## FAB-00-ACCEPTANCE

Independent review must re-run high-value evidence, challenge architecture, challenge Go authority, verify scope, and issue:

- `PASS`
- `CORRECTION_REQUIRED`
- `REJECTED`

## FAB-00C

Bounded correction phase only when accepted findings are correctable.

## FAB-01: read-only Task Inspector

- Fabric database.
- Event store.
- Projections.
- Artifact store.
- Task CLI.
- Read-only Codex importer.
- Usage correlation.
- Task Inspector dashboard.
- No runtime ownership or handoff.

## FAB-02: Supervisor and workspace manager

- Go Supervisor.
- IPC.
- Dedicated auth.
- Leases/fencing.
- Worktrees.
- Quarantine.
- Process registry.
- Crash recovery.

## FAB-03: managed Codex tasks

One complete task through Codex App Server, including approvals, edits, tests, interruption, supervisor restart, resume, and completion.

## FAB-04: Codex-to-Claude continuation

- Local only.
- One repository.
- Managed Codex source.
- Managed Claude target.
- Continue and read-only review.
- Loss Ledger.
- Target acknowledgement.
- Atomic transfer.
- Rollback.
- No automatic target selection, A2A, or remote worker.

## FAB-05: independent review and verification

- Reviewer and verifier roles.
- Review artifacts.
- Finding reconciliation.
- Evidence-based completion.
- Automatic heterogeneous review remains off.

## FAB-06: conformance and role routing

- Versioned manifests.
- Automated conformance.
- Regression detection.
- Task requirements.
- Dry-run selection.
- Hard constraints before scoring.

## FAB-07: ACP and UI projections

- OpenCodex ACP agent.
- Task/session mapping.
- Resume/close.
- Event projection.
- Editor approvals.
- AG-UI experiment.

## FAB-08: A2A and remote workers

Only after local task semantics, security, recovery, and artifacts are mature.

---

# 24. Verification strategy

## Domain

Given/when/then event tests.

## Projection

- Rebuild from zero.
- Rebuild from snapshot.
- Schema upgrade.
- Unknown event.
- Duplicate event.
- Missing artifact.
- Corrupt hash chain.

## Properties

- Sequence increases.
- One primary owner.
- Fencing token never decreases.
- Completed handoff has one target owner.
- Rollback changes no ownership.
- Permissions never widen without approval.

## Crash matrix

Kill the supervisor:

- Before append.
- After append before projection.
- During artifact write.
- During worktree creation.
- Before acknowledgement.
- After acknowledgement before transfer.
- After transfer before source shutdown.

## Security

- Prompt injection.
- Malicious repository instructions.
- Permission escalation.
- Symlink escape.
- Stale owner mutation.
- Forged acknowledgement.
- Poisoned manifest.
- Artifact tampering.
- Multi-run malicious change.
- Agent answering owner-only prompts.

## Platforms

Linux, macOS, and Windows, including IPC, paths, ACLs, process trees, and worktrees.

---

# 25. Minimum credible demo

1. Create a Fabric task.
2. Start Codex in an isolated worktree.
3. Capture edits and tests.
4. Preview handoff.
5. Show the Semantic Loss Ledger.
6. Approve a Tier 1 handoff.
7. Claude acknowledges exact hashes.
8. Ownership transfers atomically.
9. Claude continues.
10. Fork a read-only reviewer.
11. Show one timeline and evidence bundle.
12. Restart the supervisor and resume.

Manual copy-paste of a generated summary does not count.

---

# 26. Non-goals through FAB-04

- Cloud platform.
- Multi-tenancy.
- Billing.
- Public worker marketplace.
- Automatic best-agent selection.
- Automatic swarms.
- General A2A federation.
- Universal session rewriting.
- Hidden reasoning export.
- Automatic merge of competing branches.
- Active-session seizure.
- Native UI replacement.
- Lossy tool-output compression by default.
- Provider expansion unrelated to required spikes.

---

# 27. Open questions for FAB-00

1. Can Fabric-owned Codex sessions survive process and supervisor restarts on all supported systems?
2. Which Codex events are stable enough for Task Core v1?
3. Can Claude provide reliable machine-readable acknowledgement?
4. Which Claude integration boundary is maintainable?
5. Which contract format best serves Go and TypeScript?
6. Which task content persists by default?
7. Which content requires opt-in?
8. How are dirty workspaces checkpointed?
9. How are untracked files filtered for secrets?
10. Which loss classes warn, require approval, or block?
11. How is IPC authenticated?
12. Which process owns worktrees?
13. Can stale events be reliably rejected?
14. What is the exact native-resume/semantic-continuation distinction?
15. What is the minimum stable event set?
16. Which paths require security or CODEOWNERS review?
17. How is TS/Go parity avoided?
18. What recovery is possible after ownership commit?
19. What evidence authorises FAB-01?
20. Does the first handoff materially outperform a transcript converter?

---

# 28. Research standards

FAB-00 must inspect current primary sources, including:

- OpenCodex source, architecture, branches, issues, PRs, and migration policy.
- Codex App Server.
- ACP and maintained adapters.
- A2A.
- AG-UI.
- MCP where relevant.
- Git worktree.
- OpenAI Symphony.
- OpenHands event architecture.
- 9Router and OmniRoute.
- LiteLLM, Portkey, Bifrost, TensorZero, and comparable gateways.
- Research on heterogeneous review, routing, durable state, agent security, prompt injection, and stateful monitoring.
- Event sourcing, fencing leases, SQLite durability, process supervision, and local IPC.

Prefer official specifications, official repositories, official documentation, and primary research.

---

# 29. Final programme decision

Proceed only through FAB-00 initially.

FAB-00 is not tasked with defending this plan. It is tasked with trying to disprove it.

Proceed to FAB-01 only if evidence supports a credible path to:

> A durable Fabric-owned Codex task that can be continued in Claude Code through an atomic, capability-aware, loss-aware handoff into an isolated worktree.

If that cannot be done without hidden semantic loss, ambiguous ownership, duplicated kernels, or unacceptable security risk, narrow or reject the programme.
