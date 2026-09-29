# 000 Plan: integrate six reviewed PRs and release 2.71.0

Six open pull requests were reviewed as ready or nearly ready, and dev already carries eight
commits since v2.70.0. This unit lands the six PRs on dev through one integration PR, fixes the
small findings left on them, removes the Windows timeout that turned the dev tip red, and publishes
2.71.0 (stable and preview). Users get the Claude picker CA hardening, the requestPacing
concurrency cap in the GUI, the Cursor Private Inference installer link, the Windows /healthz
priority fix and the cross-home ownership proof; maintainers get a green dev tip.

## Loop spec

- Archetype: satisfy-spec, HOTL multi-cycle (cxc-loop), one integration lane.
- Trigger: owner request on 2026-09-29 to fix and merge the six PRs recommended by the Kimi
  release triage, then prepare and deploy the next release; cross-platform CI only at the end;
  Kimi subagents may be dispatched without limit.
- Goal: #6201 #6206 #6094 #5905 #6209 #6198 on dev with author credit, 2.71.0 and
  2.71.0-preview.20260929 on npm and GitHub.
- Non-goals: every other open PR (#6204 #6161 #6157 #6192 #6205 #6203 #6200 #6152 #6151 #6188 ...),
  raising any file-size cap, weakening CI/release gates, updating the installed proxy/service/app on
  this machine, touching real accounts or keychain.
- Verifier: local gates in 020 (typecheck, full test, lint:gui, build:gui, privacy:scan,
  structure:check, skill:surface:check, focused per-PR tests) before the single push; then
  exact-head Cross-platform CI + Service lifecycle on the integration PR head; then push-event CI +
  Service lifecycle on each promotion SHA; then release.yml runs and npm/GitHub read-back.
- Stop condition: 090 outcome on dev with npm latest=2.71.0 and preview=2.71.0-preview.20260929.
- Memory artifact: this unit (000-040 plans, 090 outcome), goalplan
  `.codexclaw/goalplans/release-opencodex-2-71-0-after-integrating-six-r`.
- Terminal outcomes: DONE as above; UNSAFE drops a PR that shows a security defect and continues;
  BLOCKED when a secret/permission/CI gate fails twice for a non-code cause.
- Escalation: a required approval GitHub will not accept from an admin merge, or a release
  workflow failure after npm acknowledged publication (use resume-after-npm-publish, never
  republish).
- Resource bounds: tools = gh (owner token), git, bun; write scope = branch
  codex/release-2-71-0, dev/preview/main via PRs, pr-assets; no token/time budget set by the user.

## Baseline

- v2.70.0 = 53834ff47b; dev = 37ad7e771b (version sources 2.71.0).
- dev tip Cross-platform CI run 36499924172 failed only `windows 8/9`:
  `native main profile transactions > allows 32 profiles ...` timed out at 30s (35.0s). The test
  normally runs 0.45s on Windows; dev dispatch history shows 2.7s, 3.6s, 6.9s, then 35s. Code
  under test last changed 2026-09-09. Classified as runner I/O contention (Kimi flake report).

## Source PRs (heads pinned 2026-09-29)

| PR | head | author | review state | Kimi verdict |
|---|---|---|---|---|
| #6206 | 46bf1c9931 | Ingwannu | APPROVED (luvs01) | merge with doc fixes |
| #6201 | 986f9a0c99 | luvs01 | APPROVED (Ingwannu, security maintainer) at head | merge |
| #6209 | 8fb990dab0 | MeroZemory (Jio Kim) | draft, no human review | merge with doc fix |
| #6094 | de9880f75a | bradhallett | APPROVED at head | merge |
| #5905 | 2b3dacdde5 | halysondev | APPROVED at head | merge |
| #6198 | 8dbb264300 | luvs01 | CHANGES_REQUESTED on 3cff6018; all items fixed by later commits | merge with comment fix |

Sequential 3-way application of each PR's merge-base..head diff onto dev in the order above is
conflict-free (tree 4d81bf2856). None of the 58 touched files is tracked in
tests/fixtures/file-size-baseline.json, and none crosses the 2000-line new-file threshold
(largest: src/cli/index.ts at 1979 after both #6209 and #6198).

## Work-phase map (dependency order)

1. wp0 — this roadmap (docs only).
2. wp1 — 010: integration branch, six author-preserving commits, four fix commits.
3. wp2 — 020: local regression gates and independent Kimi review of the integrated diff.
4. wp3 — 030: single push, integration PR, exact-head CI, admin merge, close source PRs.
5. wp4 — 040: dev pre-move, preview/main promotion, release.yml, verification, 090 outcome.

## Architect consultation

Recorded in 001_consultation.md.
