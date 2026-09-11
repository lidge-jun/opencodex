# 2.50.0 regression audit and release — scope

## Baseline and candidate

- Released baseline: `v2.49.0`, `main` at `2f3f736299dca38861f8fb9c4326a4b4d7c664bc`.
- Audit candidate: `origin/dev` at `12c248f52bed88ea13be5b284c79a238feb592d1`, `package.json` version `2.50.0`.
- Delta: 127 commits (`git rev-list --count 2f3f73629..origin/dev`), 1066 changed files
  (`git diff --name-only 2f3f73629...origin/dev | wc -l`).

### File counts, by `git diff --name-only 2f3f73629...origin/dev | cut -d/ -f1 | sort | uniq -c`

| Group | Files | Note |
| --- | --- | --- |
| `devlog` | 885 | No runtime. Not audited. |
| `src` | 62 | Audited: L1-L6 (L4 owns `src/server/management/*`, `src/server/{management-api,auth-cors,index}.ts`, `src/service.ts`) |
| `tests` | 42 | Read as evidence by every lane, not a lane of its own |
| `docs-site` | 28 | Not release-blocking on its own |
| `gui` | 27 | Audited: L4 |
| `readme` + root docs | 13 | `readme/` 8, plus `README.md`, `AGENTS.md`, `AGENTS_INSTALL.md`, `SECURITY.md`, `package.json` |
| `skills` | 3 | Audited: L6 (`skills/ocx` surface map) |
| `.github` | 3 | PR assets only, no workflow change |
| `structure` | 2 | Maintainer invariants |
| `scripts` | 1 | `scripts/test-layout/layout.json` |

`git diff --shortstat 2f3f73629...origin/dev -- src gui docs-site scripts .github` is
121 files / +3322 / -280. That figure excludes `tests` and `package.json`; the full
non-`devlog` set is 181 files. An earlier revision of this doc attributed 121 to a
different folder set and derived the devlog count by subtraction; the reviewer
contradicted both with the commands above.

## What this unit does

Audit the product delta for release-blocking regressions, remediate anything blocking,
then run the 2.50.0 train: pre-move `dev`, promote the frozen candidate to `main`,
publish to npm, and verify the artifacts independently.

## Authorization in force

The user authorized parallel `xai/grok-4.6` subagents, a regression-audit PABCD cycle,
and the release itself. Subagents are read-only verifiers; the main session owns every
PABCD transition, every write, and every external action.

## Out of scope

- Landing unrelated open pull requests. 74 are open against `dev`
  (`gh api "repos/lidge-jun/opencodex/pulls?state=open&base=dev&per_page=100" --jq 'length'`);
  none is a release prerequisite, and pulling one in moves the candidate mid-audit.
- Re-auditing anything already released in 2.49.0.
- Any change to `devlog/` history or to third-party accounts.

## Terminal outcomes

- `DONE` — 2.50.0 on npm `latest` with `gitHead` matching the promoted `main` SHA, a
  git tag, a GitHub release, and a recorded triage for every audit finding.
- `BLOCKED` — a release-blocking regression that cannot be fixed inside this scope,
  or a missing external permission (npm trusted publishing, workflow dispatch).
- `NOOP` — the candidate is already published and verified.
