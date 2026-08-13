# CL-09 - Passive Production Evidence / Exact-Route Correlation

## Programme position

**Repository:** `lidge-jun/opencodex`
**Integration target:** `dev`
**Branch:** `feat/cl-09-passive-production-evidence`
**Starting SHA:** `3b8f9487676fe258d76295e49e7db75aca26a4cb`
**CL-08 merge prerequisite:** satisfied by #1447 at `3b8f9487676fe258d76295e49e7db75aca26a4cb`

CL-08 is merged and closed. This document defines the next Compatibility Lab boundary.

The CL-09 contract was frozen first on this branch. Runtime implementation is now complete on this branch and remains subject to independent final review before merge.

---

# 1. Goal

CL-09 answers:

> How can already-completed production requests contribute privacy-safe, exact-route operational evidence to Compatibility Lab read surfaces without issuing extra provider requests, ingesting user content, changing canonical compatibility verdicts, or creating a routing feedback loop?

The V1 architecture is deliberately passive:

```text
Production request
      |
      v
Existing route decision + per-attempt outcome + final usage row
      |
      | capture exact local Lab route-subject ID only
      v
Bounded passive-signal adapter
      |
      v
Read-side production-signal projection
      |
      +--> Lab CLI/API/UI correlation
      |
      X--> no CL-02 canonical observation in V1
      X--> no Routing Profile / Router Intelligence input in V1
      X--> no CL-08 scheduling trigger
```

CL-09 V1 observes work that already happened. It does not create work.

---

# 2. Naming boundary

OpenCodex already has a feature called **Shadow Call Intercept** in `src/lib/shadow-call.ts` and `docs/shadow-call-intercept.md`. That feature rewrites specific Codex helper-model requests.

CL-09 is unrelated.

CL-09 must not:

- change `shadowCallIntercept` matching or rewrite behavior;
- use helper/shadow model detection as an evidence source;
- route production requests to a second model;
- duplicate a production request for comparison;
- overload the existing Shadow Call Intercept configuration.

Within implementation code and APIs, prefer `passive production evidence`, `production signal`, or `passive signal` over the ambiguous term `shadow call`.

---

# 3. Chosen V1 approach

Three approaches were considered.

## 3.1 Chosen: passive correlation only

Use metadata already produced by normal request execution and add only the minimum exact Lab subject linkage required for deterministic correlation.

Benefits:

- zero extra provider traffic;
- no duplicate quota/cost;
- no user request replay;
- no new prompt/response retention;
- no compatibility self-reinforcement in routing;
- no CL-02 event-schema change required for V1.

## 3.2 Deferred: direct passive observation promotion

A future phase may define scenario manifests whose assertions can be evaluated entirely from a closed, privacy-safe production metadata contract and may add a distinct passive execution mode or event schema version.

That work is not CL-09 V1 because current `ObservationEvent` semantics are scenario/fixture execution semantics and current execution modes are `fixture`, `live`, and `fabric`. Arbitrary user traffic is not equivalent to a reviewed Lab-owned synthetic scenario.

## 3.3 Rejected: duplicate shadow execution

CL-09 must not replay, fork, mirror, sample, or duplicate user requests to another route. That would add provider traffic, copy user content, complicate consent and credential boundaries, and violate the no-production-path-execution invariant.

---

# 4. Hard V1 invariants

CL-09 V1 must guarantee:

```text
0 extra provider requests
0 duplicated user requests
0 outbound production request or user-payload mutation
0 new routing candidates
0 Routing Profile changes
0 Router Intelligence score changes
0 CL-08 scheduling decisions from passive signals
0 canonical Lab verdict changes from passive signals
0 prompt or conversation ingestion
0 response-body ingestion
0 tool-payload ingestion
0 credential/account identity ingestion
0 public publishing
```

A failure in passive evidence capture must never fail or delay the production request.

The invariant against production-request mutation applies to outbound request bytes and user payloads. The metadata-only addition of `labRouteSubjectId` to the existing attempt record is explicitly allowed.

---

# 5. Existing authorities remain unchanged

CL-09 must reuse rather than replace:

- `PersistedUsageEntry` and `PersistedUsageAttempt` as production execution history;
- `RouteDecisionTraceV1` as why-this-route authority;
- CL-02 JSONL as canonical Lab compatibility evidence;
- CL-02 SQLite as disposable Lab compatibility projection;
- exact `RouteSubjectV1` / `subjectId` construction from the existing Lab subject boundary;
- CL-04 read surfaces;
- CL-05 Compatibility Matrix UI;
- CL-06 compatibility policy and routing consumption;
- CL-08 automation orchestration.

CL-09 creates no second request log, route trace, compatibility ledger, or verdict system.

---

# 6. Exact route correlation

Production outcomes are useful only when they are attributable to the exact route behavior that produced them.

Request-level provider/model fields are insufficient because retries and fallback attempts may execute different routes. Therefore V1 correlation is per execution attempt.

The implementation may extend the persisted attempt metadata with a local-only field approximately like:

```ts
interface PersistedUsageAttempt {
  // existing fields
  labRouteSubjectId?: string;
}
```

The field is captured while the exact attempt route context still exists. It is the existing Lab route-subject digest/ID, not a new identity scheme.

Rules:

- capture the subject ID for each actual attempt independently;
- never infer an old attempt's subject from current config after the fact;
- do not backfill historical rows whose exact route subject was not captured;
- do not assume the initial route-decision candidate is the same route as a fallback attempt;
- a subject-construction failure omits passive linkage and does not affect request execution;
- no Lab SQLite or ledger read is allowed on the production request path.

If the current route behavior fingerprint changes, new attempts receive the new subject ID. Old production signals remain attached only to the old exact subject.

---

# 7. Passive signal model

CL-09 V1 derives a bounded read-only signal from already-sanitized production metadata.

Conceptually:

```ts
interface PassiveRouteSignalV1 {
  schemaVersion: 1;
  subjectId: string;
  source: "production_usage_v1";
  requestRef: string;
  decisionRef?: string;
  attemptOrdinal: number;
  observedAt: number;
  outcome: "success" | "client_cancel" | "route_error" | "environmental" | "unknown";
  httpStatus?: number;
}
```

This is a conceptual contract, not authorization to persist a second copy.

The preferred V1 implementation derives these signals from the existing usage/history authority at read time or in an existing disposable history projection.

The signal must not include:

- `upstreamError` text;
- prompts/messages;
- response text/bodies;
- tool arguments/results;
- headers;
- URLs/IP addresses;
- `apiKeyId`;
- account references or account identity;
- conversation IDs in Lab-facing output;
- reasoning content;
- arbitrary provider diagnostics.

---

# 8. Canonical compatibility boundary

Passive production signals are **not** CL-02 `ObservationEvent` records in V1.

They therefore cannot:

- satisfy a scenario pass;
- refresh scenario freshness;
- make a suite `PROBED` or `VERIFIED`;
- make a suite `DEGRADED` or `UNSUPPORTED`;
- clear a `BLOCKED` verdict;
- participate in CL-06 minimum compatibility thresholds;
- cause CL-08 to enqueue or suppress a Lab run.

The UI and API must label them clearly as **observed production traffic, not Lab verification**.

This avoids claiming that an arbitrary user request exercised the exact synthetic assertions frozen by a scenario manifest.

---

# 9. No routing feedback loop

CL-09 V1 is read-side only from the perspective of routing semantics.

The following components must not consume passive signals:

- Routing Profile evaluator;
- Router Intelligence eligibility;
- Router Intelligence scoring;
- health/quota/cost weighting;
- model selection;
- provider discovery;
- fallback policy;
- CL-08 planner.

The production request path may compute/carry the exact local subject ID for its own attempt log entry, but it must not query passive history or Lab compatibility state as part of CL-09.

Any future use of passive evidence in routing requires a separate reviewed contract because production-observed traffic creates sampling and self-selection bias.

---

# 10. Failure classification

A production request failure is not automatically a compatibility failure.

V1 passive classification is diagnostic only.

Examples:

- client cancellation => `client_cancel`;
- clearly normalized route/upstream terminal failure => `route_error` signal;
- known environment/admission failure => `environmental` signal;
- ambiguous HTTP/user/application outcome => `unknown`;
- completed successful route attempt => `success`.

Generic 4xx/5xx status alone must not be interpreted as `UNSUPPORTED`, `DEGRADED`, or any other canonical Lab verdict.

No LLM judge or content inspection is allowed to classify passive outcomes.

---

# 11. Privacy and data minimization

CL-00 security/privacy remains authoritative.

CL-09 is specifically forbidden from reading or copying:

- user prompts or conversation history;
- response bodies or generated text;
- user files/repositories/worktrees;
- tool/MCP payloads;
- hidden reasoning;
- raw provider errors;
- credentials, auth headers, tokens, cookies;
- account IDs/emails/aliases;
- raw custom headers;
- arbitrary URLs or filesystem paths.

`requestRef` and `decisionRef` are local correlation references only. They are not public-export fields.

The route subject ID remains installation-local and opaque. CL-09 does not export the subject salt or reverse-map it.

Existing privacy scanning remains defense in depth. Tests must include canary prompt, credential, account, and response strings and prove none appear in passive Lab output.

---

# 12. Persistence and retention

V1 must not copy `usage.jsonl` rows into `compatibility.jsonl`.

Preferred authority:

```text
usage.jsonl / existing routing-history projection
            |
            v
bounded passive read projection
```

Rules:

- no new canonical passive ledger;
- no raw production payload artifacts;
- no passive artifact store;
- retention follows the existing request/usage retention authority;
- when source request history is deleted, the passive signal disappears;
- corrupt or unparseable usage rows fail closed and are skipped;
- historical rows without an exact captured Lab subject ID remain unlinked rather than guessed.

---

# 13. Read surfaces

CL-09 should extend existing Lab read surfaces rather than create a separate product area.

Useful subject-level summary fields are approximately:

```text
recent production attempts
recent successful attempts
recent route-error signals
last observed production attempt
```

Requirements:

- bounded time window and result count;
- deterministic pagination where detail is exposed;
- no network activity;
- no projection rebuild triggered by a read;
- no prompt/body/error-text exposure;
- explicit `not verification` labeling.

The Compatibility Matrix may show a compact production-signal indicator beside canonical Lab evidence. It must not merge the two into one status or score.

CLI/API naming must be audited against the existing CL-04 surfaces before implementation.

---

# 14. Default behavior and configuration

CL-09 V1 requires no new provider-traffic opt-in because it creates no provider traffic.

Do not add a new configuration flag unless implementation audit finds a real retention or resource boundary that cannot be expressed through existing request-history controls.

If usage/history persistence is disabled or unavailable, passive production evidence is simply unavailable.

No configuration may enable direct verdict promotion in CL-09 V1.

---

# 15. Production-path performance boundary

The only CL-09 work permitted on a production attempt path is bounded exact-subject linkage using already-available trusted route context and adding the resulting opaque ID to the existing attempt record.

Forbidden on the production path:

- Lab ledger reads/writes for passive evidence;
- Lab SQLite queries/rebuilds;
- usage-history scans;
- scenario evaluation;
- passive aggregation;
- synchronous disk writes beyond the existing usage logging path;
- network calls;
- retries introduced by CL-09.

Subject-link failure must be best-effort telemetry failure, never request failure.

---

# 16. Backward compatibility

Existing usage rows without passive subject linkage must continue to parse unchanged.

Additive attempt metadata must remain optional.

Do not rewrite existing usage history to invent exact historical subjects.

Existing Lab event schema and execution modes remain unchanged in CL-09 V1.

Existing Shadow Call Intercept behavior must be byte-for-byte semantically unchanged by CL-09.

---

# 17. Adversarial tests

Required coverage includes:

## Zero extra traffic

- enabling/using passive read surfaces does not increase provider send count;
- no duplicate request body is constructed or dispatched;
- CL-08 does not schedule from a passive signal.

## Exact subject attribution

- one attempt records its exact route subject ID;
- fallback attempts record different exact subjects when routes differ;
- a behavior-fingerprint change produces a new subject ID;
- old signals do not attach to the new subject;
- subject construction failure omits the link without failing the request.

## Canonical evidence isolation

- passive success does not change `UNKNOWN`/`CLAIMED`/`PROBED`/`VERIFIED`;
- passive failure does not produce `DEGRADED`/`UNSUPPORTED`;
- passive timestamps do not refresh scenario freshness;
- Routing Profile evaluation is identical with and without passive signals;
- Router Intelligence selection/score is identical with and without passive signals.

## Privacy

Seed canaries in:

- prompt;
- response text;
- tool arguments/results;
- credentials;
- account metadata;
- raw error text.

Assert none appear in:

- passive API response;
- passive CLI output;
- Compatibility Matrix payload;
- Lab JSONL/SQLite/artifacts;
- logs/errors produced by CL-09.

## Compatibility

- old usage rows still parse;
- malformed passive subject IDs are ignored/fail closed;
- bounded pagination cannot scan unbounded history;
- deletion/retention of source usage removes passive visibility;
- Shadow Call Intercept tests remain unchanged and green.

---

# 18. Delivery sequence

## CL-09.0 - Audit and contract

Completed first on this PR:

- record CL-08 closure;
- audit current production usage/route evidence and Lab boundaries;
- freeze passive evidence semantics;
- explicitly reject duplicate shadow execution and direct verdict promotion.

No runtime implementation was part of CL-09.0; CL-09.1 through CL-09.4 are implemented later on this PR.

## CL-09.1 - Exact attempt subject linkage

Implement the minimal optional exact Lab route-subject ID on persisted attempts.

No passive UI/API yet.

## CL-09.2 - Bounded passive query layer

Implement read-side production-signal derivation with strict field allowlists, bounds, and no canonical Lab writes.

## CL-09.3 - Existing Lab surfaces

Expose compact passive summaries through existing Lab management/CLI/UI conventions.

No new dashboard product area.

## CL-09.4 - Adversarial isolation

Prove privacy, zero extra traffic, routing invariance, backward compatibility, and cross-platform behavior.

---

# 19. Explicit non-goals

CL-09 V1 must not implement:

- replayed/duplicated shadow requests;
- A/B production request mirroring;
- user prompt or response capture;
- canonical passive `ObservationEvent` creation;
- new Lab execution mode;
- scenario pass/fail from arbitrary user traffic;
- compatibility verdict promotion/degradation from passive signals;
- Routing Profile mutation;
- Router Intelligence behavior changes;
- CL-08 planner changes based on production traffic;
- provider metadata mutation;
- health/quota scoring changes;
- public export/publishing;
- community leaderboard;
- remote telemetry upload;
- Shadow Call Intercept changes.

Public evidence export/publishing remains a separate later phase, provisionally CL-10, because it has a materially different privacy and trust boundary.

---

# 20. Validation

Contract PR minimum:

```text
git diff --check
repository markdown / hygiene checks
CodeRabbit / independent review
```

Implementation phases must additionally run:

```text
bun x tsc --noEmit
bun run privacy:scan
focused usage/request-log tests
focused Lab query/projection tests
routing/profile regressions
shadow-call regressions
full cross-platform CI
```

---

# 21. Acceptance criteria

CL-09 V1 is accepted only when:

1. CL-08 remains accepted/merged and current `dev` is the base;
2. production evidence causes zero extra provider requests;
3. each correlated attempt uses the exact captured Lab route subject ID;
4. fallback attempts cannot be misattributed to the original selected route;
5. historical rows are never backfilled by guessing current config;
6. user prompts/responses/tool payloads are never read or copied into Lab passive output;
7. credential/account material never enters passive output;
8. passive signals do not write canonical CL-02 observations;
9. passive signals do not change canonical compatibility verdicts/freshness;
10. passive signals do not affect Routing Profiles, Router Intelligence, health, fallback, or CL-08 scheduling;
11. old usage rows remain backward-compatible;
12. passive reads are bounded and do not trigger network/projection rebuild work;
13. existing Shadow Call Intercept behavior is unchanged;
14. privacy scan and focused adversarial tests pass;
15. full CI passes for implementation phases;
16. all valid CodeRabbit Critical/High/Medium findings are resolved;
17. independent final review reports `MERGE`.

Do not start public publishing / CL-10 until CL-09 is accepted and merged.
