# 060 — WP7: verification & close-out

Work-phase: `wp7-verify-close`. Depends on: `030`, `040`, `050`. Execute as one
full PABCD cycle.

## File change map

None planned — fixes only, if a gate fails. Any fix lands in the owning page and
is recorded here before commit.

## Gates (all fresh, all must exit 0)

1. `cd docs-site && bun install --frozen-lockfile && bun run build` — the
   docs-site AGENTS.md validation contract.
2. `bun run typecheck` (repo root; use `node_modules/.bin/bun` on this Mac).
3. `bun run privacy:scan` — reads devlog/ too; the new unit must be clean.
4. `bun run test` — full suite; `tests/repo-hygiene.test.ts` guards the devlog
   invariants this unit touches.

## Content spot checks

- README: the three quick-start elements present (rg checks from `010`), ≤ 250
  lines, no stale pins.
- Docs: each new page reachable from the sidebar; moved sections not duplicated;
  locale file lists match the English tree.
- Render smoke (C-RENDER-GROUNDING-01, docs variant): `bun run preview` the built
  site and load `/guides/combos/`, `/reference/proxy-formats/`,
  `/getting-started/for-agents/`, `/ko/guides/combos/` in the in-app browser;
  read back one screenshot or DOM check per page to confirm content renders
  (not a blank/404 fallback).

## Close-out

- D summary names the terminal outcome (DONE or otherwise) with evidence.
- Goalplan criteria get `capturedEvidence`; `cxc loop validate` must pass before
  `update_goal {status:"complete"}`.
- Commit(s) stay local; no push without explicit user approval.
