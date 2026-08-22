# CL-08 — Compatibility Lab Automation / Evidence Refresh

## Programme position

**Repository:** `lidge-jun/opencodex`
**Integration target:** `dev`
**Branch:** `feat/cl-08-lab-automation`
**Starting SHA:** `da8ebd3135553c1d4dd85c1f258e998a5de14f28`
**CL-07 merge prerequisite:** `02e62fc8c7354c544ef71f8bb3db5ebba42cb600`

CL-07 is accepted and closed.

CL-08 adds bounded, explicit orchestration around the existing Compatibility Lab producers. It does **not** redesign evidence semantics, production routing, or Agent Fabric.

---

# 1. Goal

CL-08 answers:

> Which Compatibility Lab evidence is due for collection or refresh, when may it run, and how can OpenCodex execute that work safely without duplicate probes, uncontrolled retries, unexpected provider traffic, or production-request coupling?

The architecture is:

```text
                     CL-08 Orchestrator
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
       CL-01 protocol   CL-03 live     CL-07 Fabric
          runner          probe          producer
             │              │              │
             └──────────────┴──────────────┘
                            │
                            ▼
                     CL-02 evidence
                         ledger
                            │
                            ▼
                       projection
```

The orchestrator schedules work.

It does **not** create compatibility evidence directly.

---

# 2. Core invariants

## 2.1 No production-path execution

Compatibility Lab automation must never be initiated by:

- production request routing;
- Router Intelligence evaluation;
- Routing Profile evaluation;
- provider discovery;
- request-history reads;
- compatibility projection reads;
- dashboard rendering;
- model selection.

Those components may read existing Lab projections only.

They must never synchronously or asynchronously trigger evidence collection.

---

## 2.2 Default off

Automatic Lab execution is opt-in.

The default configuration must produce:

```text
0 automatic provider requests
0 automatic Fabric executions
```

Manual Lab execution remains independent of automation.

---

## 2.3 Existing evidence authority remains unchanged

CL-08 must use the existing:

- scenarios;
- suites;
- subject identities;
- CL-01 protocol runner;
- CL-03 live-route runner;
- CL-07 task-effectiveness producer;
- CL-02 canonical JSONL ledger;
- SQLite projection;
- invalidation/purge semantics.

CL-08 must not introduce:

- a second evidence ledger;
- mutable compatibility flags;
- an alternate subject identity;
- an alternate verdict system.

---

# 3. V1 automation scope

## 3.1 `protocol_conformance`

Automatic execution allowed.

Protocol scenarios are deterministic and synthetic.

No external provider request is permitted.

---

## 3.2 `live_route_compatibility`

Automatic execution allowed only when:

- automation is explicitly enabled;
- the exact route is eligible;
- the suite/scenario is approved for automatic execution;
- evidence is missing or approaching expiry;
- route cooldown allows execution;
- global/provider/request budgets allow execution.

Every request must still pass the existing CL-03 destination, credential, SSRF, environment, and scenario authorization boundaries.

---

## 3.3 `task_effectiveness`

CL-08 V1 may understand and plan task-effectiveness work, but **automatic unattended task execution remains disabled by default and should not be enabled merely because general Lab automation is enabled**.

Required policy:

```text
task_effectiveness background execution = explicit separate opt-in
```

If the existing CL-07 execution boundary is not strong enough to safely guarantee unattended operation, CL-08 must leave task-effectiveness automation unavailable and expose that state honestly.

Manual CL-07 execution remains valid.

Do not weaken CL-07 security boundaries to make background execution easier.

---

# 4. Automation policy

Create a versioned closed policy model, approximately:

```ts
type LabAutomationLayer =
  | "protocol_conformance"
  | "live_route_compatibility"
  | "task_effectiveness";

interface LabAutomationPolicyV1 {
  schemaVersion: 1;

  enabled: boolean;

  layers: {
    protocolConformance: boolean;
    liveRouteCompatibility: boolean;
    taskEffectiveness: boolean;
  };

  refreshBeforeStaleMs: number;

  maxConcurrentRuns: number;
  maxConcurrentLiveRuns: number;
  maxConcurrentRunsPerRoute: number;

  maxRunsPerHour: number;
  maxLiveRequestsPerHour: number;

  failureCooldownMs: number;
  blockedCooldownMs: number;

  taskEffectivenessBackgroundEnabled: boolean;
}
```

Exact shape may change after repository audit.

Requirements:

- closed schema;
- strict validation;
- deterministic normalization;
- versioned;
- hard upper bounds;
- callers cannot increase CL-00/CL-03/CL-07 execution ceilings;
- no secrets or destinations in persisted policy;
- no arbitrary cron syntax in V1.

Automation policy is operational Lab configuration.

It must **not** be embedded in Routing Profiles.

---

# 5. Planning model

Implement a deterministic planner.

Input:

- automation policy;
- current time;
- scenario/suite catalogue;
- current Lab projection/evidence;
- eligible exact subjects/routes;
- current queue/running state;
- cooldown/budget state.

Output:

```ts
PlannedLabRunV1[]
```

A planned run should identify only safe canonical information such as:

```text
runKey
evidenceLayer
suiteId
suiteVersion
scenarioId
scenarioVersion
subjectId
reason
priority
eligibleAt
```

Never persist credentials, raw URLs, prompts, repository paths, request bodies, model responses, or account identity.

---

# 6. Run identity and deduplication

Define a deterministic `runKey`.

It must bind at least:

```text
evidence layer
subject ID
suite ID/version/manifest digest
scenario ID/version/manifest digest
relevant execution contract identity
```

Properties:

- same effective work → same `runKey`;
- materially different scenario/subject/contracts → different `runKey`;
- only one queued/running run may exist for one key;
- duplicate scheduler ticks must not duplicate execution;
- process restart must not cause duplicate accepted evidence.

Use existing event idempotency after execution as defense in depth, not as scheduler deduplication.

---

# 7. Freshness planning

Planner states should distinguish:

```text
fresh
refresh_due
missing
cooldown
budget_blocked
already_queued
already_running
automation_disabled
layer_disabled
inapplicable
```

A refresh should be scheduled before evidence becomes stale according to:

```text
effectiveFreshnessDeadline - refreshBeforeStaleMs
```

Do not invent new verdict semantics.

Freshness planning controls execution timing only.

---

# 8. Queue / lifecycle

Use a bounded state machine:

```text
queued
  ↓
running
  ├── completed
  ├── blocked
  ├── failed
  └── cancelled
```

Optional explicit:

```text
abandoned
```

if useful for crash recovery.

Each state transition must be deterministic and validated.

Queue state is orchestration state, **not compatibility evidence**.

---

# 9. Queue persistence

Audit existing application scheduling/background-state facilities first.

Prefer reuse.

If durable orchestration state is required, persist only the minimum bounded scheduler metadata required for:

- deduplication;
- restart recovery;
- cooldown;
- budgets;
- operator visibility.

Do not create another canonical compatibility evidence database.

Queue persistence must be disposable or reconcilable against canonical Lab evidence where possible.

Never persist:

- API credentials;
- prompts;
- provider request/response bodies;
- task repository content;
- task patches;
- arbitrary stdout/stderr;
- arbitrary filesystem paths.

---

# 10. Scheduler

Implement a bounded scheduler tick.

Conceptually:

```text
load policy
   ↓
read current Lab state
   ↓
build deterministic plan
   ↓
apply queue dedup/cooldowns/budgets
   ↓
enqueue eligible work
   ↓
dispatch within concurrency limits
```

Requirements:

- one scheduler tick cannot enqueue unlimited work;
- scheduler cannot recursively trigger itself;
- one failed run cannot create an infinite retry loop;
- scheduling decisions must be inspectable;
- disabled automation must exit without execution;
- shutdown must stop new dispatch.

Do not implement an arbitrary cron engine.

---

# 11. Concurrency

Enforce:

- global concurrent Lab runs;
- global concurrent live-route probes;
- per-route concurrent runs;
- task-effectiveness concurrency if ever enabled.

Initial conservative defaults are preferred.

Example:

```text
global Lab              2
live probes             1
same route              1
task effectiveness      1
```

Exact defaults require repository review.

---

# 12. Budgets

Implement bounded rolling-window budgets.

At minimum:

```text
max runs / hour
max live requests / hour
```

Prefer monotonic deterministic accounting.

Provider-specific/request-specific limits may be added if justified.

Budget exhaustion causes scheduling deferral/blocking.

It must never produce a route compatibility failure.

---

# 13. Cooldowns

Differentiate at minimum:

## Attributable compatibility result

Ordinary freshness rules apply.

### Authentication blocked

Do not repeatedly retry missing/invalid credentials.

Use blocked cooldown.

### Provider/environment transient failure

Use bounded retry/cooldown.

### Harness defect

Do not hammer the route.

Prefer strong cooldown / operator visibility.

### Budget exhausted

Wait for budget eligibility.

No exponential retry loop without a hard cap.

---

# 14. Retry policy

V1 should use minimal automatic retries.

Recommended:

```text
one execution attempt per scheduled run
```

A future scheduler tick may reconsider it after cooldown.

Avoid internal retry loops unless required by an existing runner contract.

A compatibility failure must not immediately generate repeated provider traffic.

---

# 15. Crash recovery

On process startup:

- inspect durable scheduler state;
- identify runs left `running`;
- do not assume they completed;
- reconcile against canonical evidence where possible;
- otherwise mark them abandoned/recoverable;
- apply a bounded recovery cooldown;
- never immediately duplicate an uncertain live request.

Crash recovery must be deterministic and testable.

---

# 16. Cancellation

Support cancellation of queued work.

For running work:

- use the runner's existing cancellation/termination mechanism;
- do not introduce unsafe process killing outside owned execution boundaries;
- cancellation is orchestration state;
- it must not create false route incompatibility evidence.

Application shutdown should:

1. stop new scheduling;
2. stop new dispatch;
3. request bounded cancellation of owned runners;
4. flush safe orchestration state.

---

# 17. Execution dispatch

Use a closed dispatcher:

```ts
switch (plannedRun.evidenceLayer) {
  case "protocol_conformance":
    // invoke existing CL-01 runner
    break;

  case "live_route_compatibility":
    // invoke existing CL-03 route probe
    break;

  case "task_effectiveness":
    // invoke CL-07 only if explicitly authorized
    break;
}
```

No:

- dynamic modules;
- callbacks loaded from config;
- arbitrary executables;
- arbitrary shell commands;
- arbitrary scenario-provided functions.

---

# 18. Task-effectiveness unattended gate

Before enabling CL-07 automatic execution, explicitly review:

- host-issued executor authority;
- child-process isolation;
- filesystem access;
- network access;
- shell/process capability;
- secret exposure;
- cancellation;
- post-timeout cleanup;
- operator consent.

If required unattended guarantees cannot be enforced:

```text
taskEffectivenessBackgroundEnabled = false
```

must remain mandatory.

Do not falsely claim an OS sandbox exists.

---

# 19. Management API

Add bounded management endpoints, approximately:

```text
GET  /api/lab/automation
PUT  /api/lab/automation
GET  /api/lab/automation/runs
POST /api/lab/automation/run
POST /api/lab/automation/runs/:id/cancel
```

Exact routing should follow existing management API conventions.

Requirements:

- explicit mutation;
- validation;
- bounded pagination;
- no secret material;
- manual run clearly distinguished from scheduled run;
- read endpoints never trigger execution.

---

# 20. CLI

Expose equivalent operator functionality through the existing Lab CLI structure.

Possible UX:

```text
ocx lab automation status
ocx lab automation enable
ocx lab automation disable
ocx lab automation runs
ocx lab run ...
```

Do not invent CLI names before auditing current Lab command structure.

---

# 21. UI

UI is optional for CL-08 core unless the existing Compatibility Lab management surface clearly requires configuration exposure.

If added:

- automation toggle;
- enabled layers;
- next scheduled refresh;
- current queue;
- recent runs;
- cooldown/budget reason;
- manual run action.

No huge scheduler dashboard.

No auto-refresh behavior that itself starts runs.

---

# 22. Security requirements

CL-00 security/privacy rules remain authoritative.

The scheduler must never receive or persist:

- raw provider credentials;
- auth headers;
- user prompts;
- conversation content;
- user repositories;
- task worktrees;
- MCP configuration;
- arbitrary filesystem content;
- arbitrary provider responses;
- hidden reasoning.

CL-03 remains responsible for live-route network/credential enforcement.

CL-07 remains responsible for task producer execution containment.

CL-08 must not weaken either boundary.

---

# 23. Observability

Every planning decision should be explainable without sensitive data.

Useful reason codes:

```text
automation_disabled
layer_disabled
fresh
refresh_due
missing
already_queued
already_running
cooldown
budget_blocked
route_ineligible
scenario_inapplicable
task_background_disabled
```

Expose bounded counters such as:

```text
queued
running
completed_last_hour
blocked_last_hour
remaining_run_budget
remaining_live_request_budget
```

Do not create a numerical compatibility score.

---

# 24. Tests

Required adversarial and deterministic coverage:

## Planner

- missing evidence schedules once;
- stale evidence schedules once;
- fresh evidence schedules nothing;
- refresh window works correctly;
- inapplicable scenario schedules nothing;
- changed subject creates new run key.

## Dedup

- two scheduler ticks cannot enqueue duplicate work;
- concurrent scheduler ticks cannot execute same key twice;
- restart cannot duplicate a known running/completed run.

## Disabled state

- default configuration schedules nothing;
- disabled automation executes zero runners;
- disabling during queued state prevents further dispatch.

## Production boundary

Prove that:

- production request handling never invokes scheduler;
- Routing Profile evaluation never invokes scheduler;
- Router Intelligence never invokes scheduler;
- provider discovery never invokes scheduler;
- Lab query/read API never invokes scheduler;
- dashboard rendering never invokes scheduler.

## Budgets

- hourly run budget enforced;
- live request budget enforced;
- budget cannot be raised above hard maximum;
- budget exhaustion does not create compatibility failure.

## Cooldown

- auth blocked does not hammer route;
- route/environment failure applies cooldown;
- harness failure applies cooldown;
- successful run clears/replaces appropriate scheduling state.

## Concurrency

- global max respected;
- live max respected;
- per-route max respected;
- queue continues after completion.

## Recovery

- abandoned running entry recovered safely;
- uncertain live run not immediately duplicated;
- corrupt scheduler state fails closed.

## Cancellation

- queued cancellation;
- running cancellation;
- process shutdown;
- cancellation does not become route failure.

## Privacy

Canary secrets must never appear in:

- queue;
- scheduler persistence;
- API;
- CLI;
- logs;
- errors;
- tests/artifacts.

## Task-effectiveness

- task background execution remains disabled unless separately enabled;
- general automation enablement does not enable Fabric background execution;
- untrusted Fabric executor cannot be scheduled;
- manual CL-07 still works.

---

# 25. Validation

At minimum:

```text
bun x tsc --noEmit
bun run privacy:scan
bun test tests/lab-automation.test.ts
bun test relevant existing Lab suites
bun test routing/profile regression suites
bun test repo hygiene
```

Then full CI.

Cross-platform behavior required on:

```text
Linux
macOS
Windows
```

No platform may silently weaken scheduler locking/dedup/security semantics.

---

# 26. Documentation

Create:

```text
devlog/_fin/260807_compatibility_lab/008_cl08_automation.md
```

Update:

```text
001_pr_stack_status.md
000_master_plan.md
```

only where required.

Record:

- starting SHA;
- branch;
- scope;
- frozen automation contract;
- security boundary;
- validation;
- acceptance status;
- final accepted head;
- merge commit.

---

# 27. Explicit non-goals

CL-08 must not implement:

- CL-09 work;
- general Agent Fabric;
- arbitrary jobs;
- arbitrary cron;
- user-worktree execution;
- autonomous repository modification;
- Routing Profile mutation;
- automatic production routing changes;
- provider metadata mutation;
- universal compatibility score;
- public evidence publishing;
- community leaderboard;
- prompt capture;
- hidden reasoning capture;
- second evidence ledger.

---

# 28. Delivery strategy

Recommended implementation sequence:

## CL-08.0 — Audit and contract

- inspect current `dev`;
- audit existing timers/background services/config persistence/API lifecycle;
- create `008_cl08_automation.md`;
- freeze policy/run/dedup/security contracts.

### CL-08.1 — Pure planner

Implement:

- policy validation;
- run key;
- freshness planner;
- reason codes.

No execution yet.

### CL-08.2 — Queue and recovery

Implement:

- state machine;
- dedup;
- concurrency;
- cooldown;
- budgets;
- crash reconciliation.

### CL-08.3 — Existing runner dispatch

Wire:

1. protocol conformance;
2. live route compatibility.

Task effectiveness remains background-disabled.

### CL-08.4 — Management surfaces

Add API/CLI controls and status.

### CL-08.5 — Task-effectiveness gate

Audit unattended CL-07 execution.

Either:

```text
ENABLE with explicit separate opt-in + proven boundary
```

or:

```text
DEFER with documented security reason
```

Both outcomes are acceptable if technically justified.

### CL-08.6 — Adversarial validation

Run:

- concurrency races;
- restart;
- duplicate scheduling;
- cooldown;
- budget;
- privacy;
- production-path isolation;
- cross-platform CI.

---

# 29. Acceptance criteria

CL-08 is accepted only when:

1. automation defaults off;
2. no production request path can trigger Lab execution;
3. deterministic planner exists;
4. duplicate work cannot run concurrently;
5. retries/cooldowns are bounded;
6. concurrency is bounded;
7. provider request budgets are bounded;
8. crash recovery is deterministic;
9. cancellation works;
10. no sensitive material enters orchestration state;
11. existing evidence authority remains unchanged;
12. protocol automation works;
13. live-route automation works under explicit opt-in;
14. task background execution is either proven safe and separately enabled or explicitly deferred;
15. routing semantics remain unchanged;
16. relevant focused tests pass;
17. privacy scan passes;
18. full CI passes;
19. all valid CodeRabbit Critical/High/Medium findings are resolved;
20. independent final review reports `MERGE`.

Do not start CL-09 until CL-08 is accepted and merged.

---

# 30. Implementation traceability (feat/cl-08-lab-automation)

Audit against repository state after CL-08 implementation on `feat/cl-08-lab-automation`.

| Section | Status | Notes |
| --- | --- | --- |
| §1 Goal | IMPLEMENTED | Orchestrator in `src/lab/automation/` plans and dispatches to CL-01/CL-03 producers. |
| §2 Core invariants | IMPLEMENTED | Default-off policy; read paths do not call scheduler (tests + static checks). |
| §3 V1 scope protocol | IMPLEMENTED | Protocol auto-planning when layer enabled. |
| §3 V1 scope live | IMPLEMENTED | Live planning + dispatch via host `TrustedLabRouteExecutor`; `buildAutomationLiveRouteContext` + production factory in `src/lib/lab-live-route-production.ts`. |
| §3 V1 scope task | DEFERRED | `taskEffectivenessBackgroundEnabled` remains false; dispatch rejects background task runs. |
| §4–§7 Policy / run key / planner | IMPLEMENTED | `policy.ts`, `run-key.ts`, `planner.ts`, `persistence.ts`. |
| §8–§14 Queue, budgets, cooldown, recovery | IMPLEMENTED | `queue.ts`, `budgets.ts`, `cooldown.ts`, `recovery.ts`, `orchestrator.ts`. |
| §15 Crash recovery | IMPLEMENTED | `recovery.ts` + startup reconcile in `startLabAutomationScheduler`. |
| §16 Cancellation | IMPLEMENTED | Queued cancel; running cancel via `AbortSignal` / `cancelSignal` on live executor. |
| §17 Dispatch | IMPLEMENTED | `dispatch.ts` closed to CL-01/CL-03; live without executor → `route_ineligible` blocked, not throw. |
| §18 Task gate | DEFERRED | Unattended CL-07 guarantees not proven; separate opt-in enforced; manual CL-07 unchanged. |
| §19 Management API | IMPLEMENTED | `lab-automation-routes.ts`. |
| §20 CLI | IMPLEMENTED | `ocx lab automation …`, `ocx lab run …`. |
| §21 UI | OUT OF SCOPE | Optional per plan. |
| §22–§23 Security / observability | IMPLEMENTED | Policy/routes hold refs only; reason codes + counters in status. |
| §27 Non-goals | VALIDATED | CL-09 not started. |
| §24 Tests | IMPLEMENTED | `tests/lab-automation.test.ts` (trusted dispatch, authority forging, budgets, shutdown, auth block) + existing Lab suites. |

**Production trusted live dispatch:** `src/server/index.ts` wires `createProductionLabRouteExecutor({ loadConfig, configDir })` into `setLabAutomationDispatchDeps` at process startup. CL-08 consumes the host-issued executor only; it does not mint credentials, construct provider transport, or bypass CL-03 destination/SSRF/credential binding. Missing executor → `route_ineligible` with no provider traffic. Protocol automation remains independent of live authority.

| Area | Status | Notes |
| --- | --- | --- |
| Protocol automation | IMPLEMENTED | CL-01 harness dispatch when layer enabled. |
| Live automation planning | IMPLEMENTED | Planner + routes + freshness + dedup. |
| Production trusted live dispatch | IMPLEMENTED | Server startup wires production CL-03 executor. |
| Live-route authority/security reuse | VALIDATED | Credential lease, pinned transport, receipt sealing, persistence gate on `trusted_route`. |
| Task-effectiveness background | DEFERRED | Separate opt-in remains disabled; unattended CL-07 not proven safe. |
| UI | OUT OF SCOPE | Per plan §21. |

**Known limitation:** Automation trusted-route contract advertises `live_transport` only (`CL08_TRUSTED_LIVE_HARNESS_FEATURES`). Scenarios requiring additional harness features (inert tools, MCP stubs, etc.) are not planned or dispatched until a broader trusted contract is explicitly defined.