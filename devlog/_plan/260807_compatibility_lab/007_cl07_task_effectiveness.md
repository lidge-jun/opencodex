# CL-07 implementation record — Task-effectiveness evidence producer

## Programme position

| Field | Value |
|---|---|
| **Phase** | CL-07 |
| **Starting SHA** | `b66e33ce7207d91014644d99317e456c992a3418` (CL-06 merge #1394) |
| **Branch** | `feat/cl-07-task-effectiveness-producer` |
| **Target** | `lidge-jun/opencodex:dev` |
| **CL-08** | **Not started** (explicit non-goal) |

## 0. Audit summary (repository reality)

Inspected at starting SHA `b66e33ce7207d91014644d99317e456c992a3418`:

| Area | Reality |
|---|---|
| `TaskSubjectV1` | Defined and validated (`src/lab/events/types.ts`, `validate.ts`); query DTO mapped |
| Agent Fabric product | **Absent**. Only `devlog/_plan/800_agent-fabric/` planning notes and CL-00 reserved consumer semantics |
| Lab ledger / artifacts / projection | Present; `task_effectiveness` already a legal evidence layer |
| CL-04 catalog | Protocol + live only — no fabric suite discovery yet |
| CL-05 matrix | Already lists `task_effectiveness` column; read-only |
| CL-06 routing | `requiredSuites.evidenceLayer` is **only** `protocol_conformance` \| `live_route_compatibility` |
| Live sandbox | Counter/env limits for probes; **not** a synthetic scratch-tree executor |
| `fabric-core` / `synthetic-patch` / `exact-tree-diff-v1` | Reserved in `020_scenario_contract_and_catalogue.md`; **no runtime implementation** |

**Decision:** CL-07 implements a **bounded Lab-owned task producer** under `src/lab/fabric/`. It does **not** invent a general Agent Fabric platform, ACP/A2A orchestration, background grind, or user-worktree execution.

## A. Frozen producer boundary

### A.1 Subject identity

Evidence uses existing `TaskSubjectV1` only (no alternate task identity):

```text
subjectSchemaVersion      1
subjectKind               task
routeSubject              RouteSubjectV1   # exact nested route from CL-03/CL-06 builders
taskClassId
taskClassVersion
taskFixtureDigest
verifierManifestDigest
fabricCompatibilityVersion
sandboxProfileDigest
```

`subjectId = subjectIdForSubject(taskSubject)` (existing digest helper).

Any material change to route, task class, fixture, verifier, fabric compatibility version, or sandbox profile yields a distinct subject. Evidence must not reuse across subjects.

### A.2 Producer outcome schema (`FabricTaskOutcomeV1`)

Closed, fail-closed on unknown fields. Schema version `1`.

Required fields:

| Field | Role |
|---|---|
| `schemaVersion` | `1` |
| `taskClassId` / `taskClassVersion` | Exact class |
| `routeSubject` / `taskSubject` / `subjectId` | Exact identities |
| `taskFixtureDigest` | Fixture identity |
| `verifierManifestDigest` | Verifier identity |
| `fabricCompatibilityVersion` | Executor contract version |
| `sandboxProfileDigest` | Sandbox policy identity |
| `startedAt` / `completedAt` | Execution window (ms epoch integers) |
| `limits` | Declared ceilings |
| `usage` | Actual resource counters used for limit checks |
| `outcome` | Normalized: `pass` \| `fail` \| `blocked` \| `inconclusive` |
| `verifier` | Bounded `exact-tree-diff-v1` result |
| `failure` | Optional typed failure (`class`, `code`, `retryable`, `attribution`) |
| `artifactDigests` | Content-addressed digests only |
| `sourceRefs` | Optional safe IDs (request / route-decision / attempt) — never bodies |

**Forbidden in outcome and artifacts:** user repositories, arbitrary file trees, prompts, hidden reasoning, credentials, env secrets, host paths, unrestricted logs/stdout/stderr, raw model transcripts, arbitrary response bodies.

### A.3 V1 executable scope (only)

| Item | Value |
|---|---|
| Suite | `fabric-core@1.0.0` |
| Scenario | `fabric-core.task.synthetic-patch@1.0.0` |
| Evidence layer | `task_effectiveness` |
| Execution mode | `fabric` |
| Verifier | `exact-tree-diff-v1` |
| Fixture | Lab-owned scratch with `src/value.txt` = UTF-8 `before\n`; requested final `after\n` |

No additional task classes in this phase.

### A.4 Limits (non-weakened)

| Limit | Value |
|---|---|
| Files touched | 1 |
| Aggregate input/output | 64 KiB |
| Patch operations | 1 |
| Total timeout | 30 s |
| Inactivity timeout | 5 s |
| Aggregate artifacts | 1 MiB |
| Network | denied in scratch |
| User MCP | unavailable |
| Arbitrary shell | unavailable |
| User repository | unreachable |

### A.5 Patch producer seam

Execution does **not** embed a general coding agent. Production evidence requires a host-issued `TrustedFabricPatchExecutor` invoked through `runFabricSyntheticPatchTaskForRoute`, with `RouteSubjectV1` built from `routeContext` + `destination` via `buildRouteSubjectV1`. Patch producers run in an isolated Bun child with hard termination on timeout.

- Tests use `runFabricSyntheticPatchTaskHarness` with closed `FabricHarnessProducerKind` values or fixture executor modules; harness outcomes are not persistable via `persistFabricRunResult`.
- A future live route adapter may call a provider **outside** the scratch sandbox and return only a validated `SyntheticPatchV1`; raw prompts/responses never enter Lab storage.
- CL-07 does **not** ship automatic background execution (CL-08).

## B. Verifier: `exact-tree-diff-v1`

Deterministic, no LLM.

1. Walk only the bounded scratch root (no follow).
2. Reject symlinks, special files, path traversal (`..`, absolute, drive prefixes), unexpected paths.
3. Sort repository-relative POSIX paths by UTF-8 bytes.
4. Hash/read allowed file bytes under bounds.
5. Pass iff the sole change is `src/value.txt: before\n → after\n` with no add/delete/rename.
6. Emit bounded structured result: `{ verifierId, manifestDigest, passed, pathSummaries[], reason? }`.

Verifier manifest bytes participate in `verifierManifestDigest` → `TaskSubjectV1`. Behavior changes require a new digest; historical observations are never reinterpreted with current bytes.

## C. Sandbox / execution boundary

Minimal deny-by-default scratch executor:

- Create ephemeral Lab-owned directory under the Lab paths tree (not the user repo).
- Materialize fixture files only.
- Apply at most one validated patch operation via direct file write (no shell).
- Enforce byte/time/inactivity ceilings.
- Cleanup on success, failure, and timeout.
- Freeze `sandboxProfileDigest` from a versioned sandbox profile object.

Reuse patterns from `src/lab/artifacts/secure-fs.ts` / live sandbox env stripping where applicable; do not reuse live provider network transport inside the scratch.

## D. Route identity

Nested `RouteSubjectV1` must come from existing CL-03/CL-06 builders (`buildRouteSubjectV1` / policy subject helpers). Approximate `provider/model` strings are forbidden. Optional `sourceRefs` may cite `routeDecisionId` / attempt IDs without copying request content.

## E. Lab ingestion

`observationFromFabricOutcome` / internal `persistFabricOutcome` (not public):

- `evidenceLayer: "task_effectiveness"`
- `executionMode: "fabric"`
- Exact scenario/suite IDs + manifest digests + fixture digests
- Exact `TaskSubjectV1` + `subjectId`
- Assertions from verifier
- Typed `failure` attribution
- Bounded environment metadata
- Sanitized artifact refs via existing artifact store

No second ledger, mutable task DB, or separate verdict store. JSONL canonical; SQLite rebuildable; verdicts projected.

### E.1 Idempotency

Event identity uses existing `assignEventId` content-addressing. Replaying the same outcome (same event payload identity) must not create contradictory evidence. A legitimate second attempt uses a distinct `attempt` / timing / outcome payload and remains distinct evidence.

## F. Verdict / failure mapping

Layer remains independent of protocol/live.

| Condition | Observation outcome | Failure class → attribution | Projection effect |
|---|---|---|---|
| Verifier pass (current required task) | `pass` | — | May contribute to `PROBED`/`VERIFIED` per suite rule |
| Verifier semantic fail | `fail` | `behavioral_failure` → `route` | `DEGRADED` path per suite |
| Sandbox violation / containment | `blocked` or `inconclusive` | `sandbox_violation` → `harness`/`environment` | `BLOCKED` / none |
| Timeout / inactivity / budget | `blocked` | matching blocker → `environment` | none (not route incompatibility) |
| Harness/executor defect | `inconclusive` | `harness_failure` → `harness` | none |
| Malformed producer outcome | reject (no event) | — | — |
| Artifact integrity failure | reject or invalidate | `integrity_failure` → `harness` | invalidate |

Registry/provider claims **cannot** create task-effectiveness `CLAIMED`.

## G. Freshness / invalidation / artifacts

Reuse existing Lab freshness, invalidation, sensitive purge, and rebuild. Missing historical contract artifacts make evidence unusable.

Allowed artifacts: verifier summary, normalized tree-diff summary, bounded execution metadata, sanitized failure summary. Never file bodies, prompts, or raw logs.

## H. Read surfaces / UI / CL-06 interaction

- Extend CL-04 `queryLabCatalog` to discover `fabric-core` scenarios.
- Projection/query already accept `task_effectiveness` subjects.
- CL-05 matrix remains read-only; show task layer if already wired.
- **CL-06 unchanged:** do **not** add `task_effectiveness` to routing `requiredSuites`. `TaskSubjectV1` cannot be resolved pre-dispatch (task class/fixture/verifier/sandbox unknown until execution). Historical task evidence may appear in Lab reads; it must not silently alter production routing without a future explicit contract (out of CL-07 scope).

## I. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| General Agent Fabric API / worktree runner | Out of scope; unsafe surface area |
| Shell-based patch apply | Violates no-arbitrary-shell; use direct write |
| Pre-dispatch routing on task suites | Subject unknown before execution |
| Numerical effectiveness score / leaderboard | Forbidden by CL-00 |
| Second ledger / mutable verified flag | Breaks Lab persistence authority |
| Embedding prompts in observations | Privacy violation |
| Weakening byte/time limits for tests | Contract non-negotiable |
| CL-08 auto/background probing | Explicit exclusion |

## J. Security review checklist

Scratch-root containment; symlink/path-traversal/special-file rejection; max files/bytes; artifact publication bounds; no network/MCP/shell in scratch; minimal env; no credentials/config exposure; cleanup; concurrent isolation; hostile patch paths. Fail closed. Adversarial tests required (§18 of programme request).

## K. Implementation layout (proposed)

```text
src/lab/fabric/
  constants.ts
  types.ts
  subject.ts
  fixture.ts
  sandbox-profile.ts
  scratch.ts
  patch.ts
  verifier.ts
  executor.ts
  manifest.ts
  observe.ts
  index.ts
tests/lab-fabric-task.test.ts
```

## L. Validation plan

Typecheck; focused fabric/subject/sandbox/verifier/observe/ledger/projection/read-surface tests; routing regressions proving CL-06 unchanged; privacy scan; hygiene; GUI only if touched.

## M. Status

- **State:** ACCEPTED / CLOSED
- **Merge commit on `dev`:** `02e62fc8c7354c544ef71f8bb3db5ebba42cb600`
- **Accepted / source head:** `0efe2c69514d3baefee686383fe740e4ecb37d83`
- **Starting SHA:** `b66e33ce7207d91014644d99317e456c992a3418` (CL-06 merge #1394)
- **PR:** [#1438](https://github.com/lidge-jun/opencodex/pull/1438) (merged)

### Authoritative route execution boundary

- Production evidence uses `runFabricSyntheticPatchTaskForRoute({ routeContext, destination, patchExecutor })`.
- `RouteSubjectV1` is built only via `buildRouteSubjectV1(routeContext, destination)` — callers cannot supply an independent route identity.
- Patch production requires a host-issued `TrustedFabricPatchExecutor` (`createHostIssuedFabricPatchExecutor` in `src/lib/fabric-task-host.ts`).
- **Public ingestion:** `persistFabricRunResult` only; it rejects harness runs (`executionAuthority !== "trusted_route"`).
- `persistFabricOutcome` is internal to `observe.ts` and is **not** exported from the fabric public surface.
- Harness runs (`runFabricSyntheticPatchTaskHarness`) use closed `FabricHarnessProducerKind` values only; they cannot create production ledger evidence.

### Child isolation / IPC / timeouts

- Patch producers run in a dedicated Bun child (`producer-child.ts`) spawned by `producer-isolate.ts` with minimal env (`TZ`, `NO_COLOR`, `OCX_FABRIC_SCRATCH_ROOT`).
- Parent↔child protocol is newline-delimited JSON on stdout only (`activity`, `result`, `error` in `producer-protocol.ts`). Arbitrary logging is not mixed into protocol output.
- Parent owns **both** total and inactivity timeouts; both terminate the child via `SIGKILL`. Classification: `timeout` vs `inactivity_timeout`.
- Child stdout is capped at 64 KiB protocol bytes; stderr diagnostic capture capped at 4 KiB. Exceeding protocol limits → `budget_exhausted` and child kill.
- `lastActivityAt` is authoritative in the parent; child `reportActivity()` emits `activity` IPC messages that reset the inactivity deadline.
- `infinite_sync` harness disables inactivity ceiling extension so synchronous CPU spin is classified under total timeout.

### Sandbox enforcement (honest scope)

- Scratch containment, symlink/path-traversal/special-file rejection, byte/file limits, and cleanup are enforced in the parent via `scratch.ts`, `patch.ts` (`assertSafeRelativePosixPath`), and `applySyntheticPatch`.
- Child isolation strips proxy env vars on the parent path and runs producers in a separate process with minimal env — **not** an OS-level network/shell sandbox.
- Host-issued executor modules may still perform direct host filesystem operations outside the scratch tree; that is outside the scratch-apply boundary and is not claimed as blocked.
- Declared deny flags (`fabricDeclaredSandboxPolicy`) document intent; runtime enforcement matches the scratch/patch/verifier containment above.

### Failure attribution

- Semantic verifier mismatch → `fail` / `behavioral_failure` / `route`.
- Sandbox/containment (`FabricTaskError` from scratch/verifier/patch infrastructure) → `blocked` or `inconclusive` / `sandbox_violation` / `harness` or `environment` — never route-attributed `behavioral_failure`.
- Timeouts / budget exhaustion → `blocked` / `environment`.
- Harness defects → `inconclusive` / `harness`.

### Inactivity accounting

- `inactiveMs` = `completedAt - lastActivityAt` where `lastActivityAt` is updated only from parent-received `activity` IPC (or initial start).

### Local validation (blocker fix head)

- `bun x tsc --noEmit`: passed
- `bun test tests/lab-fabric-task.test.ts`: 46/46 passed
- `bun run privacy:scan`: passed
- Windows sqlite projection flakes in `lab-evidence-ledger.test.ts` (EBUSY) — environmental, not CL-07
- CL-08: **not started**
