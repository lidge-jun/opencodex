# CL-03 implementation record

## Branch and revisions

- **Branch:** `feat/cl-03-live-route-probes`
- **Starting SHA:** `4f746d13799888ea0a8c7a111aa2ad61c2126ea0` (upstream `dev` / #1348 merge)
- **Implementation head:** `003f7402f49bfe8dd710a7beba52f717051bfadf`
- **PR:** [#1352](https://github.com/lidge-jun/opencodex/pull/1352) (DRAFT → `lidge-jun/opencodex:dev`)

## Scope delivered

1. Live manifest authority (`023_live_v1_manifest_authority.md`, `024_live_v1_cases.json`, runtime copy)
2. Route subject builder (`src/lab/subject/`)
3. Live sandbox (`src/lab/live/` — destination, credential lease, transport, executor, runner)
4. Persistence seam (`src/lab/observe/from-live.ts`)
5. Projection applicability (`routeSubjectApplicableToRequirements` in `verification.ts`)
6. Tests (`tests/lab-live-sandbox.test.ts`, `tests/lab-live-probe.test.ts`)

## Security design summary

- **Network:** immutable in-memory `LabDestinationV1` snapshot; DNS/policy before credentials;
  connect only to approved address set; redirects rejected; metadata/link-local forbidden;
  private/loopback requires route `allowPrivateNetwork` plus explicit `labRunApproval`;
  inherited proxy env vars rejected.
- **Credentials:** opaque `LabCredentialLeaseV1` bound to destination + transport + budget;
  no secret bytes in Lab code; auth failure → `authentication_blocked` / `BLOCKED`.
- **Tools/MCP:** inert Lab-authored tools; loopback MCP stub only; no user `mcpServers`.
- **Process:** sandbox env `TZ=UTC`, `NO_COLOR=1` only; no child processes; resource ceilings enforced.

## Frozen live scenarios (10)

- `responses-core.live.basic-turn`
- `chat-core.live.basic-turn`
- `anthropic-core.live.basic-turn`
- `tools-core.live.function-round-trip`
- `tools-core.live.custom-freeform-round-trip`
- `codex-core.live.tool-turn`
- `codex-core.live.custom-tool-turn`
- `vision-core.live.synthetic-ocr`
- `reasoning-core.live.replay`
- `mcp-core.live.synthetic-tool`

## Validation (2026-08-09)

| Check | Result |
|---|---|
| `bun x tsc --noEmit` | pass |
| `tests/lab-conformance-harness.test.ts` | 17/17 |
| `tests/lab-evidence-ledger.test.ts` | 37/41 (4 Windows SQLite EPERM flakes; pre-existing) |
| `tests/lab-live-probe.test.ts` | 19/19 |
| `tests/lab-live-sandbox.test.ts` | 17/17 |
| `bun run privacy:scan` | pass |

## Explicitly not started

- CL-04 Lab CLI or management/read APIs
- CL-05 Compatibility Matrix UI
- CL-06 Routing Profile compatibility policy

## Acceptance status

Implementation only — **not accepted**. CL-04 remains blocked until independent CL-03
acceptance and review reconciliation.
