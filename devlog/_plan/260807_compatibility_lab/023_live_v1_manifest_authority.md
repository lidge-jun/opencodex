# CL-03 live V1 manifest authority

This document closes the executable semantics for the initial
`live_route_compatibility` scenarios. It is normative for CL-03.

The machine-readable source of truth is
[`024_live_v1_cases.json`](./024_live_v1_cases.json). It contains 10 frozen
live-route scenarios with Lab-authored synthetic fixtures, literal expected
values, row-specific requirements, execution limits from the security contract,
artifact policy, failure rules, and domain-separated fixture digests.

## 1. Manifest expansion

For each entry in `cases`, CL-03 constructs `CompatibilityScenarioV1` using the
same `fixtureRef` contract as protocol V1, with authority
`024_live_v1_cases.json`. Defaults include:

- `evidenceLayer`: `live_route_compatibility`
- `executionMode`: `live`
- `freshness.maxAgeMs`: `604800000` (7 days)
- `failureRuleSet`: `live-v1-default`

Environmental blockers (`authentication_blocked`, `quota_blocked`,
`network_failure`, `provider_transient`, `region_blocked`, `timeout`,
`budget_exhausted`) map to `verdictEffect: none` and never produce compatibility
degradation.

## 2. Live suites

| Suite | Live scenario |
|---|---|
| `responses-core` | `responses-core.live.basic-turn` |
| `chat-core` | `chat-core.live.basic-turn` |
| `anthropic-core` | `anthropic-core.live.basic-turn` |
| `tools-core` | `tools-core.live.function-round-trip`, `tools-core.live.custom-freeform-round-trip` |
| `codex-core` | `codex-core.live.tool-turn`, `codex-core.live.custom-tool-turn` |
| `vision-core` | `vision-core.live.synthetic-ocr` |
| `reasoning-core` | `reasoning-core.live.replay` |
| `mcp-core` | `mcp-core.live.synthetic-tool` |

## 3. Route subject and sandbox

Live evidence uses `RouteSubjectV1` with opaque `endpointFingerprint` and
`providerInstanceFingerprint` derived via `localFingerprint()` from immutable
destination snapshots. Raw URLs, credentials, and DNS results are never
persisted.

The live sandbox rejects proxy environment variables, permits only
`TZ=UTC` and `NO_COLOR=1`, enforces security-contract resource ceilings, and
uses injectable transport in tests.

## 4. CL-03 boundary

CL-03 implements the live runner, sandbox, route subject builder, persistence
seam, and projection applicability for `live_route_compatibility`. It does not
implement CL-04 CLI/API.
