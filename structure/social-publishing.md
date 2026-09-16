# Social Publishing Control Plane

Phase 20.60 introduces the Social Publishing Control Plane into Pao-hubPro (OpenCodeX), integrating with separately deployed OpenPost instances (`https://github.com/getopenpost/openpost`, AGPL-3.0-only).

Pao-hubPro owns orchestration, policy, approval, workflow context, agent intelligence, observability, and cross-system automation. OpenPost owns provider OAuth connections, provider-specific transport, and native publishing execution.

## 1. Product Boundary

The Social Publishing Control Plane:
- Registers external OpenPost instances and checks connectivity.
- Discovers connected social accounts and syncs platform capabilities.
- Creates master publications and generates destination-specific renditions.
- Evaluates policy (account readiness, content length, media formats, scheduling, and anti-spam rules).
- Requires human approval bound to a deterministic content hash before mutations.
- Manages durable delivery jobs with bounded backoff and idempotency.
- Reconciles remote publication state and ingests normalized analytics.
- Protects secrets: provider OAuth tokens remain within OpenPost and are never returned to Pao-hubPro agents or stored in the database.

## 2. Invariants

| ID | Statement | Enforcement |
| --- | --- | --- |
| `INV-SOC-01` | Provider OAuth credentials never enter Pao-hubPro database or agent context. | OpenPost architecture boundary, `src/social/db.ts` |
| `INV-SOC-02` | Human approval is required by default before publishing or scheduling mutations. | `src/social/policy.ts`, `src/social/service.ts` |
| `INV-SOC-03` | Approval binds to a deterministic content hash; material changes invalidate approval. | `src/social/content-hash.ts`, `src/social/service.ts` |
| `INV-SOC-04` | Delivery operations require deterministic idempotency keys to prevent duplicate posting. | `src/social/content-hash.ts`, `src/social/service.ts` |
| `INV-SOC-05` | Account readiness is verified; degraded accounts require reauth or intervention. | `src/social/policy.ts` |
| `INV-SOC-06` | Feature flag `SOCIAL_PUBLISHING_ENABLED` defaults off; mutations refuse when disabled. | `src/social/enabled.ts`, `src/social/service.ts` |
| `INV-SOC-07` | Frozen GUI NAV is unchanged; Social is hash-routable only (`#social`, `#social/accounts`, ...). | `gui/src/App.tsx`, `gui/src/app-routing.ts` |

## 3. Architecture

```text
PAO-HUBPRO CORE
  ↓ Master Publication & Rendition Planning
  ↓ Capability Check & Policy Evaluation
  ↓ Human Approval Gate (Content-Hash Bound)
  ↓ Durable Delivery Job (Idempotent)
  ↓ OpenPost Client (HTTP API)
OPENPOST SERVICE (AGPL-3.0-only)
  ↓ Durable Queue & Account Tokens
  ↓ Social Provider APIs (X, Mastodon, Bluesky, LinkedIn, etc.)
```

## 4. Local State Ownership

Under `$OPENCODEX_HOME` (`~/.opencodex`):
- `social.sqlite`: instances, accounts, publications, assets, renditions, policy evaluations, approvals, delivery jobs, analytics snapshots, and audit events.
- Optional `PAO_SOCIAL_DB_PATH` overrides the database path for isolated test runs.

Management API prefix: `/api/social/*`.
CLI command: `ocx social` (alias `openpost`).

