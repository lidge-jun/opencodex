# OpenCodex Compatibility Lab / EvalGrid

Status: CL-00 architecture authority
Authority baseline: `upstream/dev` at `3ad5bb6bd3f76f6879d84b78ea39edd3e01ec296`
Package/runtime at baseline: OpenCodex `2.10.2`, Bun `1.3.14`

## Purpose

Compatibility Lab turns compatibility claims into bounded, reproducible
evidence. It tests OpenCodex protocol behavior, exact configured routes, and
later execution-grounded task outcomes without becoming a provider registry, a
user-policy system, or a production router.

This directory is the programme authority. The contracts frozen by CL-00 are:

- [Architecture and evidence](./010_architecture_and_evidence_contract.md)
- [Scenario model and initial catalogue](./020_scenario_contract_and_catalogue.md)
- [Protocol V1 manifest authority](./021_protocol_v1_manifest_authority.md)
- [Protocol V1 canonical cases](./022_protocol_v1_cases.json)
- [Historical incident corpus](./030_incident_corpus.md)
- [Security and privacy](./040_security_and_privacy.md)
- [CL-00 independent acceptance review](./050_cl00_acceptance_review.md)
- [PR stack status](./001_pr_stack_status.md)

Later phases may add implementation detail, but must amend these contracts
explicitly rather than silently changing their meaning.

## Live repository truth

CL-00 audited the live `dev` tree before defining new authority.

### Shipped and authoritative

- Provider declarations and model metadata:
  `src/providers/registry.ts`, `src/providers/derive.ts`, `src/types.ts`;
  route-time claimed capability assembly in `src/routing/capability.ts` also
  consumes provider config, cached Codex catalog rows and native metadata.
  Generated fallback metadata lives in `src/generated/model-metadata.ts` and is
  sourced by `scripts/model-metadata.source.json`.
- Routing Profile public/config types: `OcxRoutingProfileConfig` in
  `src/types.ts`; validation, normalization, revision hashing, persistence and
  resolution in `src/routing/profile.ts`.
- Deterministic profile evaluation and route traces:
  `src/routing/evaluator.ts`, `src/routing/trace.ts`, and
  `src/router.ts`.
- Profile management CRUD and dry-run:
  `src/server/management/routing-profile-routes.ts`.
- Dashboard profile editor, dry-run and routing analytics:
  `gui/src/pages/RoutingProfiles.tsx`, mounted under Models -> Routing.
- Canonical append-only request/usage evidence and rebuildable history
  projection:
  `src/usage/log.ts`, `src/routing/history/indexer.ts`, and
  `src/routing/analytics.ts`.
- Why-this-route evidence:
  `RouteDecisionTraceV1`, request-history explain endpoints in
  `src/server/management/request-history-routes.ts`, and CLI explain support.
  The GUI Logs modal renders only a compact route summary through
  `gui/src/pages/log-route-decision.ts`; there is no GUI request-history browser
  or full trace + attempts + outcome view on this baseline.
- Existing diagnostics are narrower than Compatibility Lab:
  the default `ocx doctor` path is observe-only environment/OAuth/runtime
  diagnosis; explicit `--fix-codex-runtime` may persist a repair. In contrast,
  `POST /api/providers/test` performs a bounded live `/models` connectivity
  check only when applicable; forward providers return configured status and
  static catalogues return not-applicable without network access.
- Protocol behavior is already covered by many focused tests under `tests/`,
  but those tests are not a versioned scenario catalogue or evidence ledger.

### Not shipped

- No Compatibility Lab runner, scenario registry, evidence ledger, SQLite
  projection, CLI, management API, or UI exists.
- Generated Cursor agent protobufs include task/grind/subagent message types,
  but OpenCodex has no native Agent Fabric task persistence, harness handoff,
  portable task-state model, or management API. Router Intelligence's own
  master plan explicitly excluded Agent Fabric.
- No Routing Profile compatibility fields exist.

Current routing nuances that later phases must preserve rather than
over-describe:

- selection traces and execution attempts are separate; the explain API merges
  trace + `attempts[]` + final outcome at read time;
- `optimize.latency` is currently a declaration-priority share, while observed
  latency contributes through health evidence rather than an independent
  top-level score;
- cost evidence is commonly unknown on the live pre-dispatch path because
  request usage is not yet available;
- profile dry-run is evaluation-only and never dispatches upstream;
- an unknown canonical `policy/<id>` currently falls through to ordinary model
  routing rather than failing closed.

Consequently, CL-00 defines future contracts and integration seams only. It
does not rename existing Router Intelligence concepts or describe speculative
Agent Fabric endpoints as current behavior.

## Architectural invariant

```text
Provider Registry
        ↓
Compatibility Lab
        ↓
Compatibility Graph / Verified Evidence
        ↓
Routing Profiles
        ↓
Router Intelligence
        ↓
Selected Model / Route
        ↓
Agent Fabric / Real Execution
        └──────────────→ execution-grounded outcomes back to Lab
```

The arrows are data dependencies, not ownership transfers.

### Provider Registry

The Provider Registry declares what a provider/model is believed to support and
supplies defaults used to construct an effective route. The shipped
`candidateCapabilityEvidence()` also combines explicit provider config, cached
catalog rows, adapter-level inference and native-model metadata. These local
declarations are claims. They may seed `CLAIMED`; they cannot by themselves
produce `PROBED`, `VERIFIED`, `DEGRADED`, or `UNSUPPORTED`.

The Lab may snapshot a registry claim with its source revision for
reproducibility. It must not create a parallel provider catalogue or write
provider declarations back into the registry.

Registry-owned runtime defaults such as model wire selection, discovery policy,
upstream streaming, reasoning replay, service-tier support, and item-ID repair
are intentionally not all persisted to `config.json`. Claim snapshots capture
the effective sources; they do not freeze runtime defaults into user config.

### Compatibility Lab

The Lab owns versioned scenarios, immutable compatibility evidence, failure
attribution, freshness, derived verdicts, and regression history. It may
project evidence into a compatibility graph keyed by exact route subject and
evidence layer.

The Lab never chooses a production candidate, mutates a Routing Profile,
changes provider metadata, or turns a probe result directly into a route.

### Routing Profiles

Routing Profiles remain the sole compatibility-policy surface. Future
compatibility requirements extend `OcxRoutingProfileConfig`, its
normalizer/revision, the existing evaluator, the existing management
CRUD/dry-run endpoints, and the Models dashboard editor. Existing combo and
account-pool controls retain their separate non-compatibility responsibilities.
There will be no compatibility-specific profile store, evaluator, or editor.

### Router Intelligence

Router Intelligence combines the selected profile with current capability,
compatibility, health, quota, cost, and latency evidence and makes the
deterministic route decision. Its existing `RouteDecisionTraceV1` remains the
authority for explaining that decision. Compatibility inputs will later add
bounded evidence to that trace rather than introduce a second explanation
record.

### Agent Fabric

Agent Fabric is a future producer of task-effectiveness observations. It owns
real task execution and its sandbox. The Lab accepts only structured outcome
data and sanitized content-addressed artifact references; it does not copy task
repositories, prompts, worktrees, or hidden reasoning.

Because a native Agent Fabric is not present on the CL-00 baseline, this
programme freezes the consumer semantics, not a fictitious production API. A
later producer contract must identify its schema version, task class, exact
route subject, deterministic verifier results, timing, resource limits,
outcome, and sanitized artifact references. Existing request-grounded evidence
may be linked through `RouteDecisionTraceV1`, `PersistedUsageAttempt`, and the
final request outcome; prompt-bearing `responses-state.json` and generated
Cursor task protobufs are not Lab feeds.

## Evidence-layer invariant

Every scenario and observation has exactly one layer:

1. `protocol_conformance`: whether OpenCodex translates and preserves a
   protocol contract correctly.
2. `live_route_compatibility`: whether an exact
   provider/model/adapter/configuration route works now.
3. `task_effectiveness`: whether that route produces verifier-confirmed
   outcomes for a versioned class of coding work.

Verdicts are projected per `(subject, layer, suite)`. Evidence from one layer
may be shown as a prerequisite or correlated signal, but cannot promote or
degrade another layer's verdict. There is no universal compatibility score.

## Persistence authority

Future implementation uses the existing OpenCodex config root returned by
`getConfigDir()` (`OPENCODEX_HOME`, default `~/.opencodex`) and owns:

```text
~/.opencodex/lab/
    compatibility.jsonl
    compatibility.sqlite
    artifacts/
```

- `compatibility.jsonl` is the canonical append-only evidence/event ledger.
- `compatibility.sqlite` is a disposable query projection rebuilt from JSONL.
- `artifacts/` contains bounded, sanitized, content-addressed artifacts.
- Scenario/suite manifests and synthetic fixture/source anchors are
  content-addressed contract artifacts retained with the observations that
  reference them.
- Verdicts are derived projections, never mutable canonical booleans.
- Corrections append invalidation events or a new claim snapshot with explicit
  `supersedes[]`; prior bytes are not edited.
- The Lab does not copy `usage.jsonl` or routing-history rows. When useful, an
  observation references an existing request ID or route decision ID.
- Agent Fabric supplies structured outcome data/references, never repositories
  or prompt transcripts.

This location follows current repository state-root conventions. No filename
or location change from the proposed architecture was justified by the audit.

## Routing Profiles boundary for CL-06

CL-06 must add optional compatibility controls alongside existing capability,
health, quota, cost, and latency policy:

- required compatibility suites;
- minimum compatibility status;
- maximum evidence age;
- unknown-evidence behavior;
- degraded-evidence behavior.

`minimum compatibility status` is not a total ordering across all verdicts.
Only `PROBED` and `VERIFIED` are positive thresholds. `DEGRADED` is governed by
its explicit behavior, `UNKNOWN`/`CLAIMED`/`BLOCKED` by unknown-evidence
behavior, and `UNSUPPORTED` fails a required suite.

The exact future flow is:

```text
Routing Profile
       ↓
Configured candidates
       ↓
Hard capability gates
       ↓
Compatibility requirements / penalties
       ↓
Eligible candidates
       ↓
Health / quota / cost / latency scoring
       ↓
Deterministic winner
```

All compatibility fields are optional. Profiles that omit them retain their
current validation, revision, eligibility and scoring behavior. A profile
evaluation reads an existing projection only. No compatibility probe, network
request, task, or projection rebuild may run synchronously on the production
request path.

## Programme phases

Programme authorization is tracked below. CL-09 contract drafting is authorized by merged CL-08; CL-09 runtime implementation remains gated on acceptance of the CL-09 contract.

| Phase | Purpose | Authorization |
|---|---|---|
| CL-00 | Architecture authority, contracts, scenario catalogue, incident corpus | **ACCEPTED/CLOSED** - merged #1286 |
| CL-01 | Deterministic protocol-conformance runner and fixtures | **ACCEPTED/CLOSED** - merged #1320 |
| CL-02 | Immutable JSONL ledger, artifacts and SQLite projection | **ACCEPTED/CLOSED** - merged #1333 plus hardening/closure |
| CL-03 | Bounded live-route probes | **ACCEPTED/CLOSED** - merged #1352 |
| CL-04 | Lab CLI and management read surfaces | **MERGED** - #1378 |
| CL-05 | Compatibility Matrix UI | **MERGED** - #1384 |
| CL-06 | Existing Routing Profile compatibility controls and Router Intelligence consumption | **ACCEPTED/CLOSED** - merged #1394 at `b66e33ce7207d91014644d99317e456c992a3418` |
| CL-07 | Agent Fabric task-effectiveness ingestion | **ACCEPTED/CLOSED** - merged #1438 at `02e62fc8c7354c544ef71f8bb3db5ebba42cb600` |
| CL-08 | Bounded automatic evidence refresh/orchestration | **ACCEPTED/CLOSED** - merged #1447 at `3b8f9487676fe258d76295e49e7db75aca26a4cb` |
| CL-09 | Passive production-evidence correlation with zero extra traffic and no routing feedback | **CONTRACT DRAFT** - #1489; implementation not authorized |
| CL-10 | Public export/publishing/community evidence | Not started; separate privacy/trust boundary |

The original CL-00 planning bucket combined shadow, automatic, and public evidence workflows. Accepted later plans split that bucket deliberately: CL-08 owns bounded automation, CL-09 defines passive production evidence, and public publishing remains separate CL-10 work.

Phase numbering after CL-01 is programme planning, not implementation
authorization. A later accepted plan may split a phase while preserving these
ownership boundaries.

## CL-00 acceptance criteria

CL-00 is accepted only when:

1. all three evidence layers have separate subjects, scenarios and verdicts;
2. every canonical verdict is reproducible from immutable inputs;
3. environmental blockers cannot poison compatibility conclusions;
4. exact route identity prevents evidence reuse across behavior changes;
5. scenario semantics and initial IDs are implementable without an LLM judge;
6. representative historical incidents map to abstract regression scenarios;
7. future compatibility policy extends existing Routing Profiles;
8. probes and task execution are excluded from production request routing;
9. privacy and sandbox ceilings are explicit;
10. an independent review finds no unresolved Critical, High, or Medium issue.

## CL-00 hard stop

This phase does not implement a runner, mock upstream, persistence code, live
probe, CLI, management endpoint, UI, profile field, routing behavior, shadow
route, Fabric ingestion, automatic routing, or public publisher.

Acceptance of CL-00 authorizes discussion and planning of CL-01; it does not
start CL-01 automatically.
