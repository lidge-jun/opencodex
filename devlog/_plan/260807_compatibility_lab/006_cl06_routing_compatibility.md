# CL-06 implementation record — Routing Profile compatibility policy

## Programme position

| Field | Value |
|---|---|
| **Phase** | CL-06 |
| **Starting SHA** | `1072b9c39c48a4982229131613ac300560740742` (CL-05 merge #1384) |
| **Branch** | `feat/cl-06-routing-profile-compatibility` |
| **Target** | `lidge-jun/opencodex:dev` |
| **CL-07** | **Not started** (explicit non-goal) |

## A. Frozen Routing Profile compatibility schema

Compatibility policy extends the existing `OcxRoutingProfileConfig` via an optional
`compatibility` object. There is **no** separate compatibility profile store.

```typescript
interface OcxRoutingProfileCompatibilitySuite {
  /** Lab suite identifier, e.g. "responses-core". */
  suiteId: string;
  /** Evidence layer for this requirement. */
  evidenceLayer: "protocol_conformance" | "live_route_compatibility";
}

interface OcxRoutingProfileCompatibility {
  /** Required compatibility suites (may be empty array → no requirements). */
  requiredSuites?: OcxRoutingProfileCompatibilitySuite[];
  /**
   * Minimum positive compatibility status. Only PROBED and VERIFIED are legal
   * positive thresholds. Omitted = no positive threshold (suites still listed
   * for trace/explainability only when explicitly configured).
   */
  minStatus?: "PROBED" | "VERIFIED";
  /**
   * Profile-level maximum evidence age (ms). Tightens scenario/suite freshness;
   * never extends it. Omitted = no profile tightening.
   */
  maxEvidenceAgeMs?: number;
  /**
   * Behavior for UNKNOWN, CLAIMED, and BLOCKED verdicts on a required suite.
   * Default: "exclude" (fail closed).
   */
  unknownEvidence?: "allow" | "penalize" | "exclude";
  /**
   * Behavior for DEGRADED verdict on a required suite.
   * Default: "penalize".
   */
  degradedEvidence?: "allow" | "penalize" | "exclude";
}
```

### Verdict semantics (CL-00 aligned)

| Verdict | Required-suite treatment |
|---|---|
| `VERIFIED` | Satisfies `minStatus: VERIFIED` and `minStatus: PROBED` |
| `PROBED` | Satisfies `minStatus: PROBED`; fails `minStatus: VERIFIED` |
| `DEGRADED` | Governed solely by `degradedEvidence` (never by `minStatus`) |
| `UNKNOWN` | Follows `unknownEvidence` |
| `CLAIMED` | Follows `unknownEvidence` (not a positive threshold) |
| `BLOCKED` | Follows `unknownEvidence` (environmental; not capability proof) |
| `UNSUPPORTED` | **Always excludes** for a required suite |

There is **no** universal compatibility score and **no** total ordering across all
verdicts. `minStatus` applies only to positive `PROBED`/`VERIFIED` thresholds.

### Freshness composition

Effective max age for a suite requirement:

```text
effectiveMaxAgeMs = min(
  finite scenario.maxAgeMs,
  finite suite.maxAgeMs,
  finite profile.maxEvidenceAgeMs
)
```

`null` at any layer means no bound at that layer. A stale prior `VERIFIED` or
`PROBED` row does **not** satisfy a current requirement.

## B. Backward compatibility and revision hashing

1. Profiles that **omit** `compatibility` entirely retain pre-CL-06 validation,
   eligibility, scoring, and routing behavior.
2. Normalization **does not** inject a default/empty `compatibility` object into
   stored config or revision input.
3. `profileRevision()` includes `compatibility` **only** when the normalized
   profile has at least one effective compatibility control:
   - non-empty `requiredSuites`, or
   - `minStatus`, or
   - `maxEvidenceAgeMs`, or
   - explicit `unknownEvidence` / `degradedEvidence` overrides.
4. Adding CL-06 code to a deployment must not change revisions for profiles that
   never set compatibility fields (regression-tested).

## C. Exact route-subject identity

Compatibility evidence matches the exact Lab `RouteSubjectV1` / `subjectId`, not
`provider/model` alone.

### Production derivation (read-only, no DNS/network)

Shared pure helpers extracted from CL-03 (`src/lab/subject/route-subject.ts`,
`src/lab/live/destination.ts` endpoint fingerprint primitive):

1. **`resolveRoutedProvider(config, provider, model)`** — reuse `routedProviderConfig`
   discipline from `src/router.ts` (registry merge, baseUrl resolution, adapter pin).
2. **`resolveEffectiveWire(config, provider, model)`** — `resolveWireProtocolOverride`
   with policy inbound default `openai-responses`.
3. **`upstreamProtocolForAdapter(adapter)`** — closed map matching Lab conventions
   (`openai-responses`, `openai-chat`, `anthropic-messages`, …).
4. **`surfaceForRoute(inbound, upstream)`** — closed map (`responses-http`, …).
5. **`providerInstanceKey(provider, routed)`** — stable config-owner identity:
   `providerId` + resolved `baseUrl` + effective `adapter` (no secrets).
6. **`endpointFingerprintFromBaseUrl(baseUrl)`** — **DNS-free** URL parse +
   `localFingerprint("endpoint", {scheme, host, port, basePath})` (same algorithm as
   `createLabDestination` snapshot, without address resolution).
7. **`resolveProductionBehaviorValues(...)`** — production resolver emitting closed
   `LabBehaviorValues` with the same keys required by `buildBehaviorFingerprintV1`.
8. **`readOpenCodexCompatibilityVersion()`** — embedded/generated 64-hex manifest
   hash per CL-00 §4 (not package marketing version).
9. **`buildRouteSubjectV1(routeContext, destinationSnapshot)`** — existing CL-03
   builder; routing supplies a frozen `LabDestinationV1`-shaped snapshot with
   `addresses: []` (fingerprint-only; not used for network).

`subjectIdForSubject(subject)` from `src/lab/digest.ts` is the lookup key.

### Identity invariants

- Adapter/config/endpoint/model-behavior changes → new `subjectId` → no evidence reuse.
- Credential rotation alone does not change subject (provider instance key excludes secrets).
- Routing consumption uses the **same** fingerprint algorithms as Lab evidence writers.

## D. No routing-path side effects

Production routing and dry-run **must not** synchronously:

- run Compatibility Lab probes;
- run protocol conformance;
- run live-route tests;
- contact upstream for compatibility;
- perform Lab DNS resolution;
- execute Agent Fabric work;
- rebuild the Lab projection;
- replay the JSONL ledger;
- mutate Lab state.

CL-06 reads an **existing** SQLite projection snapshot only.

## E. Compatibility evidence read path

### Bounded reader (`src/routing/compatibility/reader.ts`)

- One `openLabReadConnection` per policy evaluation.
- One SQL query for all candidate subject IDs:
  `SELECT … FROM verdicts WHERE subject_id IN (…)` (plus optional layer/suite filters).
- Returns a frozen `CompatibilityEvidenceSnapshot` passed into the pure evaluator.
- Fail-safe when projection missing/incompatible/corrupt: treat as **no evidence**
  (follows `unknownEvidence`), never throw through routing.

### Evaluator purity

`evaluatePolicyProfile` remains pure: it receives `compatibility` evidence on each
`PolicyCandidateEvidence` assembled **before** evaluation. It does not open SQLite.

### Missing/malformed evidence behavior

| Condition | Routing behavior |
|---|---|
| Projection available, verdict row present | Evaluate normally |
| Projection missing | `unknownEvidence` policy per required suite |
| Projection incompatible | Same as missing (no rebuild) |
| Subject construction fails | `unknownEvidence` (exclude by default) |
| Suite verdict missing | `unknownEvidence` |
| Corrupt/unusable row ignored by projection | `unknownEvidence` |

## F. Freshness

Implemented per CL-00 §4 and §Freshness above. Reader supplies `asOf` from verdict
row; evaluator compares `now - asOf` against `effectiveMaxAgeMs` loaded from Lab
catalogue metadata (in-memory `queryLabCatalog`, not per-row SQLite).

Stale positive verdicts are treated as **missing positive evidence** → `unknownEvidence`
path (not as current `PROBED`/`VERIFIED`).

## G. Penalty semantics

Penalties are **deterministic, bounded, and explainable** — separate from health/quota/cost.

Constants (mirroring RI-06 unknown floors):

| Policy | Effect |
|---|---|
| `unknownEvidence: allow` | No exclusion; no compatibility score component |
| `unknownEvidence: penalize` | Eligible; `score.components.compatibility = 0.3` |
| `unknownEvidence: exclude` | Hard exclusion `compatibility-unknown` |
| `degradedEvidence: allow` | No exclusion; no penalty |
| `degradedEvidence: penalize` | Eligible; `score.components.compatibility = 0.3` |
| `degradedEvidence: exclude` | Hard exclusion `compatibility-degraded` |

`UNSUPPORTED` always excludes (`compatibility-unsupported`). Failed positive
threshold excludes (`compatibility-insufficient`). Stale positive excludes
(`compatibility-stale`).

Compatibility weight is **not** added to `optimize` — penalty renormalizes like
health/quota unknown penalties (spent weight returns to `configuredPriority` share).

## H. Routing flow (preserved ordering)

```text
Routing Profile
  → configured candidates
  → hard capability gates (existing require + request evidence)
  → compatibility requirements / penalties   ← CL-06
  → eligible candidates
  → health / quota / cost / latency scoring
  → deterministic winner
```

Compatibility never bypasses capability hard gates.

## I. RouteDecisionTraceV1 extensions

Extend existing trace (no parallel Lab routing trace):

```typescript
interface RouteCompatibilitySuiteTrace {
  suiteId: string;
  evidenceLayer: string;
  verdict?: string;          // observed
  minStatus?: string;        // threshold
  fresh?: boolean;           // freshness classification
  unknownPolicy?: string;
  degradedPolicy?: string;
  outcome: "satisfied" | "penalized" | "excluded" | "unknown";
  reason?: string;           // stable wire code, bounded
}

interface RouteCompatibilityEvidence {
  subjectId?: string;        // truncated hash prefix optional for privacy
  suites: RouteCompatibilitySuiteTrace[];  // max 8 suites
}
```

Added to `RouteCandidateTrace` as optional `compatibility?: RouteCompatibilityEvidence`.
Suite rows capped; overflow sets `truncated.compatibility`. Existing 16 KiB / 8 candidate /
16 exclusion bounds remain authoritative.

## J. Dry-run parity

`assembleCandidateEvidence` in `routing-profile-routes.ts` and `router.ts` call the
same `assemblePolicyCandidateEvidence(config, profile, now)` helper that attaches
compatibility snapshots. Dry-run and production evaluation share `evaluatePolicyProfile`.

## K. Routing Profiles GUI

Extend Models → Routing profile editor (`RoutingProfiles.tsx`):

- Compact **Compatibility** section (not a second editor/store).
- Required suites: multi-select from `GET /api/lab/catalog` grouped by layer.
- `minStatus`, `maxEvidenceAgeMs`, `unknownEvidence`, `degradedEvidence` controls.
- Omitting compatibility on save preserves backward-compatible PUT body.

CL-05 Compatibility Matrix tab remains read-only and unchanged.

## L. Explicit non-goals

CL-06 does **not** implement: Agent Fabric, task execution, task-effectiveness
producers, CL-07, automatic/background probing, shadow probes, public evidence
workflows, CL-08.

---

## Implementation readiness review (pre-coding)

Pressure-tested against CL-00/CL-05 codebase at `1072b9c`:

| # | Risk | Resolution |
|---|---|---|
| 1 | Production route subject without DNS | **Accepted** — endpoint fingerprint uses URL parse only; same `localFingerprint` as Lab destination snapshot. DNS results are not part of `endpointFingerprint`. |
| 2 | Fingerprint parity Lab ↔ routing | **Accepted** — reuse `buildRouteSubjectV1`, `buildBehaviorFingerprintV1`, `subjectIdForSubject`; extract DNS-free endpoint helper from `destination.ts`. |
| 3 | Profiles without compatibility unchanged | **Accepted** — guard all CL-06 paths on `profile.compatibility` presence; regression tests required. |
| 4 | Revision backward compatibility | **Accepted** — omit empty compatibility from revision digest; test legacy profiles. |
| 5 | Stale VERIFIED passing | **Rejected risk** — freshness enforced in evaluator before positive threshold check. |
| 6 | Verdict semantics | **Accepted** — table above matches CL-00; CLAIMED/BLOCKED → unknown policy. |
| 7 | Penalize → universal score | **Rejected risk** — bounded per-dimension `compatibility` component only; no cross-layer collapse. |
| 8 | N+1 projection reads | **Rejected risk** — single `IN (subject_ids)` query per evaluation. |
| 9 | Missing projection crashes routing | **Rejected risk** — fail-safe reader returns empty snapshot. |
| 10 | Dry-run vs production divergence | **Rejected risk** — shared assembly helper. |
| 11 | Trace overflow | **Accepted** — suite cap + existing byte budget enforcement. |
| 12 | CL-07 leakage | **None** — no Fabric types, APIs, or task subjects in CL-06. |

### Rejected alternatives

- **Separate compatibility profile store** — rejected; violates CL-00 Routing Profiles boundary.
- **Provider/model verdict lookup** — rejected; weakens exact-route identity.
- **Synchronous projection rebuild on miss** — rejected; violates consumer boundary.
- **Universal compatibility weight in `optimize`** — rejected; not in CL-00 contract.

### Design decisions

- Policy inbound default `openai-responses` for subject construction (policy routes via Responses API).
- Compatibility catalogue metadata loaded once per evaluation for freshness ceilings.
- `compatibility` trace stores suite-level outcomes only (no raw subject JSON).

---

## Implementation status

| Area | Status |
|---|---|
| Plan frozen | ✅ This document |
| Types / profile validation | ✅ |
| Route subject resolver | ✅ |
| Evidence reader | ✅ |
| Evaluator + trace | ✅ |
| Management API + dry-run | ✅ |
| GUI editor | ✅ |
| Tests (25+ cases) | ✅ |
| PR #1394 | ✅ Merged to `dev` at `b66e33ce7207d91014644d99317e456c992a3418` |

## Validation checklist (pre-acceptance)

- [x] `bun x tsc --noEmit`
- [x] `bun test tests/routing-compatibility.test.ts`
- [x] `bun test tests/routing-profile.test.ts tests/route-decision-trace.test.ts`
- [x] `bun test tests/lab-read-surfaces.test.ts`
- [x] GUI lint/build
- [x] `bun run privacy:scan`
- [x] Cross-platform CI on PR #1394

## Acceptance

- **State:** ACCEPTED / CLOSED
- **Merge commit:** `b66e33ce7207d91014644d99317e456c992a3418`
- **Source head:** `b96eae83f2a6d1654472aeeef84799070743aeb8`
- **CL-07:** **ACCEPTED/CLOSED** (merged #1438)
