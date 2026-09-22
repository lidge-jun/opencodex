# 000 — Tidy `structure/`: split oversize docs, claim undescribed source areas

Status: open. Branch `codex/structure-tidy`, stacked on `codex/remove-docs-pr-assets` (PR #5593).

## Problem

`structure/manifest.json` carried two grace lists that `structure/AGENTS.md` defines as debt, not a
parking place. `grace.oversizeDocs` exempted three docs from the 600-line budget:
`transports/responses.md` (1507 lines), `gui-and-management-api.md` (813) and
`providers/openai-tiers.md` (744). `grace.undocumentedSourceAreas` listed six source areas that no doc
named: `src/bridge.ts`, `src/bridge/`, `src/quota/`, `src/service-manager-probe.ts`, `src/sidecar/` and
`src/types/`.

## Change

Split along existing heading boundaries, moving text byte for byte (only `###` → `##` promotion where
a subsection became top level; anchors are unchanged):

| Source doc | Stays | New doc |
| --- | --- | --- |
| `transports/responses.md` | intro, HTTP/SSE endpoint, redirects, fetch helper, progress, key-pool pick, service tier, uploads, core module ownership | `transports/responses-wire-shapes.md` (mixed-wire defaults → passthrough SSE shapes), `transports/responses-failover.md` (phase inference → compaction overrides, replay boundary, output headroom), `transports/responses-spend.md` (credential-hop and durable spend reservations) |
| `gui-and-management-api.md` | serving, auth boundaries, API ownership, runtime provenance, startup safety | `dashboard-and-usage.md` (UX boundary → combo editor routing quota) |
| `providers/openai-tiers.md` | public provider contract incl. quota cache | `providers/openai-accounts.md` (migration → uploaded-file retention) |

172 cross-links, including decision-record owner links, were rewritten to the doc that now holds each
anchor; the `paginated-history-writer` contract dependents follow their links. One source comment
(`src/lib/upstream-retry.ts`) pointed at a moved anchor.

New sections name the six undescribed areas: the adapter-to-Responses bridge
(`transports/responses.md`), quota-reset notifications (`dashboard-and-usage.md`), the service-manager
probe and shared sidecar auth/candidates (`ops/service-and-sidecars.md`), and shared type declarations
(`providers-and-adapters.md`). Both grace lists are now empty.

Out of scope: `grace.unboundInvariants` (needs new tests), decision-record prose, docs-site.

## Verification

- Line conservation: a multiset comparison of non-blank lines (heading level normalized) between each
  original doc and its split set shows 0 missing lines; the only added lines are the new doc headers.
- `bun run structure:check` and `bun test tests/ci-workflows/structure-ssot.test.ts`.
- No test reads the split docs by path (`rg 'structure/' tests`).

## Review

Two read-only `gpt-6-sol` verifiers. Split fidelity found five decision records (ADR-0040..0044)
still naming the old owner section and `responses-wire-shapes.md` missing `src/bridge/` and
`src/codex/` in its manifest mapping; fixed. Records whose owner doc did not move stay untouched.
Prose accuracy found two overstatements (the quota poller arms one dormant unref'd interval even when
disabled; the bridge code allowlist covers `formatErrorResponse` only) and one nit (the seen-store
suppresses repeat attempts rather than guaranteeing delivery); fixed. Both re-verified PASS.
