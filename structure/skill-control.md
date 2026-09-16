# Universal Agent Skill Control Plane

Phase 20.57 introduces the Universal Agent Skill Control Plane into Pao-hubPro (OpenCodeX). It turns AI-agent Skills from scattered markdown files into governed, versioned, searchable, deployable, and auditable software assets that can be distributed across local agents (Codex, Claude Code, OpenCode), project workspaces, and remote nodes.

Inspired by SkillsGate architectural patterns (browsing, public discovery, per-agent management, remote SSH, and local-first behavior), this system integrates natively into the existing control plane.

## 1. Product Boundary

The Skill Control Plane:
- Discovers public and private skills from local folders, git repositories, skills.sh, and Phase 20.56 generated artifacts.
- Validates packages against directory traversal, path escape, and size budgets.
- Statically scans instructions and bundled files against deterministic security rules.
- Scores risk (0-100) and maps inferred capabilities.
- Enforces policy and binds human approvals to exact content hashes.
- Plans deployments with full dry-run preview before mutation.
- Transactionally deploys skills with pre-deployment recovery snapshots, atomic staging, and post-write verification.
- Detects configuration drift and provides rollback and adoption workflows.
- Coordinates remote nodes over restricted, fingerprint-pinned SSH transports.

## 2. Invariants

| ID | Statement | Enforcement |
| --- | --- | --- |
| `INV-SKILL-01` | Content is data until deployed; import and scanning never execute instructions or scripts. | `src/skills/importer.ts`, `src/skills/scanner.ts` |
| `INV-SKILL-02` | Every deployed mutation must be plannable with dry-run support in API, CLI, and UI. | `src/skills/deployment.ts` |
| `INV-SKILL-03` | Existing unmanaged files on disk are never silently overwritten without explicit adoption. | `src/skills/paths.ts`, `src/skills/deployment.ts` |
| `INV-SKILL-04` | Published versions are immutable; content edits create a new version/draft. | `src/skills/service.ts`, `src/skills/db.ts` |
| `INV-SKILL-05` | Approvals bind strictly to exact content hashes; any content change invalidates prior approval. | `src/skills/approval.ts` |
| `INV-SKILL-06` | Post-write SHA-256 verification is mandatory; verification failure rolls back and fails closed. | `src/skills/deployment.ts` |
| `INV-SKILL-07` | Remote SSH connections enforce strict host-key verification and secret broker credential references. | `src/skills/remote.ts` |
| `INV-SKILL-08` | Ordinary agents have no unrestricted shell or arbitrary filesystem write capabilities. | `src/skills/agent-tools.ts` |

## 3. Architecture

```text
SOURCE (Local / Marketplace / Git / Generated)
  ↓
DISCOVER / IMPORT
  ↓
STATIC SCAN & RISK SCORING
  ↓
POLICY EVALUATION & APPROVAL
  ↓
DEPLOYMENT PLAN (Dry-Run)
  ↓
TRANSACTIONAL DEPLOYMENT & VERIFY
  ↓
DRIFT DETECTION & RECOVERY
```

## 4. Local State Ownership

Under `$OPENCODEX_HOME` (`~/.opencodex`):
- `skills.sqlite`: SQLite database storing skill sources, skills, versions, files, scan findings, agent adapters, remote nodes, deployments, snapshots, drift events, reviews, and audit events.
- `.pao-backups/`: Recovery snapshots taken prior to mutating existing skill deployments.
- Target agent locations:
  - Codex: `~/.codex/skills/<slug>/` or `.codex/skills/<slug>/`
  - Claude Code: `~/.claude/skills/<slug>/` or `.claude/skills/<slug>/`
  - OpenCode: `~/.config/opencode/skills/<slug>/` or `.opencode/skills/<slug>/`
  - Universal: `~/.agents/skills/<slug>/` or `.agents/skills/<slug>/`

Each managed target directory carries a `.pao-managed.json` receipt to distinguish managed assets from unmanaged user files.

Key files:
- Server management API routes: `src/server/management/skill-routes.ts`
- CLI command: `src/cli/skill.ts` (`ocx skill`, alias `skills`)
- GUI page: `gui/src/pages/Skills.tsx` (`#skills`)

