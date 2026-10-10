# 261009 N1 — catalog and client sweep lane

Lane N1 of the 2026-10-09 sweep (coordinator chat 01a11fe0). Source worktree
`opencodex-lanes/261009-N1-catalog`, base `origin/dev` `730d898457`.

## Items and disposition

| Item | Status at P | Work-phase |
|---|---|---|
| #6819 / #6817 operator Ultra Fast retention | Squash-merged by a maintainer as `730d898457`; #6817 closed COMPLETED | none (done upstream) |
| #6801 LazyCodex role reasoning effort (LilMGenius) | Open, policy checks green, repository CI never ran (fork approval) | wp1 → [010](010_carry_6801_role_effort.md) |
| #6784 background auto-refresh client fan-out | Open feature issue | wp2 → [020](020_autorefresh_client_fanout.md) |

## Constraints

- One PR per item, both targeting `dev`; carried commits keep their author and the PR names
  `Co-authored-by: LilMGenius <smsmeee@naver.com>`.
- Local proof is focused tests, `bun run typecheck`, and the gates each change touches
  (structure, skill surface, test layout, file-size ratchet, privacy). Full suite is left to
  exact-head hosted CI and recorded as such.
- `src/server/index.ts` sits at 887 of its 893-line cap; neither work-phase touches it.
  `structure/*.md` documents are capped at 600 lines (config 600, runtime 600, catalog 599,
  clients/integrations 598), so contract edits extend existing paragraphs in place.
- Background writes never touch a client file that OpenCodex has not already written, and never
  touch Cline (its unattended-refresh exclusion is an existing contract).
- No merge, no comments on or closing of other PRs/issues, no release.

## Dependency order

wp0 (this roadmap) → wp1 and wp2 are independent of each other. wp1 runs first because it is a
carry with a known diff; wp2 is new design.

## Verification map

| Phase | Local | Hosted |
|---|---|---|
| wp1 | omo-role-models, codex-agent-role-routes, codex-role-auto-assign-routes, codex-agent-role-models, cli agent roles tests, skill-ocx, file-size-ratchet, test-layout; typecheck; skill:surface:check; structure:check | Cross-platform CI on the PR head |
| wp2 | new client-fanout scheduler test, new unattended sync test, sync-client-integrations, catalog-auto-refresh-scheduler, core-lab-boundary, test-layout, file-size-ratchet; typecheck; structure:check; privacy:scan | Cross-platform CI on the PR head |
