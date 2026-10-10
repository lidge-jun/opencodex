# 000 — Update and package-replacement continuity (roadmap)

Issues: #5496 (a replaced package tree fences `/healthz`, so `ocx restart` cannot find the proxy it
tells the user to restart) and #5624 (a Windows `ocx update` fails during the npm install, keeps
the old version, and leaves a temp tree behind with a locked `bunx.exe`).

Objective: an installed proxy that is updated or has its package tree replaced ends up on exactly
one healthy new runtime, or keeps the old install and service intact with a clear next step.

## Work phases

| Phase | Doc | Outcome |
|---|---|---|
| wp0 | this unit | Roadmap locked; no production change |
| wp1 | [010](./010_fenced_proxy_identity.md) | A fenced proxy is discoverable through attested identity by `ocx restart`, `ocx stop` and service stop; a real-order test and the structure invariant |
| wp2 | [020](./020_updater_leftovers_and_guidance.md) | Updater-owned staging leftovers are marked, swept and never block; unowned trees are never deleted; every failure names its next step; docs-site troubleshooting page |
| wp3 | — | One PR to `dev`, required CI green on the exact head |

## Constraints for this lane

- Local suite, focused tests, typecheck, build, install and the proxy itself are not run.
  Evidence is static reading plus hosted CI on the exact head.
- File-size: `src/cli/index.ts` sits at 1992 lines against the 2000-line implicit cap and
  `src/update/job.ts` at 1987. Changes there stay inline and near zero net lines; new logic
  lives in sibling modules.
- New tests go in new sibling files registered in `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json`.

## Out of scope

- Redesigning the automatic drain-and-restart guard (`src/server/index/package-tree-guard.ts`).
- Changing the 2.59.0 updater that the #5624 report ran; only the current updater is hardened.
- Source checkouts and standalone binaries remain outside the fence.

## Status

| Phase | State |
|---|---|
| wp0 | Done: roadmap audited (near-pass, no blockers) and locked |
| wp1 | Done: ca7f4e3024 (fenced identity, tests, INV-FENCE-01) |
| wp2 | Done: 91a2f3c47f (owned leftovers, failure guidance) and 9d80cc61ac (troubleshooting page) |
| wp3 | PR #5643; hosted CI on the exact head is the proof (local checks: NOT RUN) |
