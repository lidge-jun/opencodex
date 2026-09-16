# Authorized Security Agent Control Plane

Phase 20.58 introduces an authorization-first Security Agent Control Plane into Pao-hubPro (OpenCodeX). It is inspired by Awarexone/Agentic-Bug-Hunter patterns (specialized agents, skill packaging, recon → validate → report, lead board, memory, MCP) without turning the platform into an unrestricted offensive automation system.

## 1. Product Boundary

The Security Control Plane:

- Records organizations, authorizations, and a Scope Registry.
- Freezes an immutable scope snapshot when a campaign starts.
- Evaluates every target-facing action through Policy Engine + Risk Tier + optional human approval.
- Issues short-lived scope tokens. Unknown / excluded / expired assets deny.
- Runs recon and validation only through `SecurityToolGateway`, using local fixtures in this phase.
- Promotes leads to findings only after the seven-question validation gate.
- Stores hashed, redacted evidence and sanitized memory.
- Imports security skill/tool packages as a static inventory. Scripts are never executed.

It does **not**:

- Spray credentials, guess passwords, phish, bypass MFA, replay secrets, or automate account takeover.
- Perform destructive exploitation, persistence, evasion, lateral movement, or data exfiltration.
- Auto-run `install.sh`, `install_tools.sh`, or any imported shell.
- Allow agents to shell out directly to target-facing tools.
- Grant authorization from LLM classification.

## 2. Invariants

| ID | Statement | Enforcement |
| --- | --- | --- |
| `INV-SEC-01` | If scope cannot be proven, execution stops. | `src/security/scope.ts`, `src/security/gateway.ts` |
| `INV-SEC-02` | Security tools are deny-by-default. Unclassified capability denies. | `src/security/policy.ts` |
| `INV-SEC-03` | R3 and blocked action classes are denied. | `src/security/constants.ts`, `src/security/policy.ts` |
| `INV-SEC-04` | R2 requires bounded human approval. Approval expires. Self-approval is rejected when separation-of-duty is on. | `src/security/approval.ts` |
| `INV-SEC-05` | No agent may invoke a target-facing tool except through `SecurityToolGateway`. | `src/security/gateway.ts` |
| `INV-SEC-06` | Imported packages are inventoried, never executed. Compatibility starts `REVIEW_REQUIRED`. | `src/security/importer.ts` |
| `INV-SEC-07` | Exclusions override inclusions. Campaign snapshots are immutable. | `src/security/scope.ts`, `src/security/service.ts` |
| `INV-SEC-08` | Evidence is SHA-256 hashed at ingestion; secrets are redacted from UI previews. | `src/security/evidence.ts` |
| `INV-SEC-09` | Reusable (Tier C) memory must not contain credentials, tokens, or authorization-specific secrets. | `src/security/memory.ts` |
| `INV-SEC-10` | `auth_ref` / MCP `credential_ref` point at Secret Broker (`secret://...`) only. | `src/security/service.ts` |
| `INV-SEC-11` | Feature flag `PAO_SECURITY_CONTROL_PLANE` defaults off. Mutating API/CLI refuse when unset. | `src/security/enabled.ts` |

## 3. Architecture

```text
REQUEST
  → identity / RBAC
  → Scope Registry + Authorization Record
  → Policy Engine + Risk Tier
  → optional Human Approval Gate
  → short-lived scope_token
  → SecurityToolGateway (local fixtures only)
  → evidence (hashed, redacted)
  → leads / seven-question validation / report
  → immutable audit
```

Risk tiers: R0 local/non-targeting; R1 passive/minimal with active scope; R2 active low-impact with human approval; R3 blocked by default.

Campaign lifecycle: `DRAFT → SCOPE_CHECK → READY → RECON_RUNNING → TRIAGE → VALIDATION → HUMAN_REVIEW → REPORT_READY → CLOSED`, plus `PAUSED`, `BLOCKED_POLICY`, `BLOCKED_SCOPE`, `WAITING_APPROVAL`, `CANCELLED`, `FAILED`.

## 4. Local State Ownership

Under `$OPENCODEX_HOME` (`~/.opencodex`):

- `security.sqlite`: organizations, authorizations, scopes, campaigns, snapshots, agents, capabilities, tools, MCP, tasks, executions, approvals, leads, findings, validation, evidence, memory, policy, audit, rate limits, circuit breakers, scope tokens, imported packages.

The GUI page is hash-routable (`#security`, `#security/campaigns`, …) and is **not** a frozen sidebar NAV row. CLI `ocx security` talks to the service/database directly (local-transport), not over HTTP.

Key files:
- Server management API routes: `src/server/management/security-routes.ts`
- CLI command: `src/cli/security.ts` (`ocx security`, alias `sec`)
- GUI page: `gui/src/pages/Security.tsx` (`#security`)

## 5. Safe demo

The seeded local lab (`lab.local`, `app.lab.local`, exclusion `admin.lab.local`) never opens a network socket. Recon reads in-process fixtures. Expired authorization, unknown host, excluded host, R2-without-approval, and R3 are first-class deny paths covered by tests.
