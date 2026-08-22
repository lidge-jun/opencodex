# 260815 dual-lane release train — research

## Question

Is `origin/dev` @ `81ada7cd0` ready to be promoted into both `main` (npm
`latest`) and `preview` (npm `preview`), and what version numbers do the two
lanes take?

## Branch state at audit time

| ref | sha | package.json version | relation to dev |
|-----|-----|----------------------|-----------------|
| `origin/dev` | `81ada7cd0` | `2.18.0` | — |
| `origin/main` | `af737adb5` | `2.18.2` | 17 behind, 3 ahead (release bumps only) |
| `origin/preview` | `a0f5897d4` | `2.17.1-preview.20260814` | 50 behind, 1 ahead (release bump only) |

`main` is "ahead" of `dev` only by `release: v2.18.0/1/2`, three commits that
each change one line of `package.json`. No product code on `main` is missing
from `dev`.

## Why npm says 2.18.2 but the tree says 2.18.0

`gh run list --workflow release.yml` shows three consecutive failures before the
success:

- `7602613f4` (v2.18.0) — failed three times
- `cbc594f3c` (v2.18.1) — failed
- `af737adb5` (v2.18.2) — success, published, GitHub release `v2.18.2` exists

The workflow refuses to publish a version whose git tag already exists, so each
retry needed a fresh version number. The consequence: npm `latest` = 2.18.2
carries the v2.18.0 code, and every commit on `dev` after `ea96fbd5d`
(`release: v2.18.0`) is unpublished. That is 16 product commits.

## Promotion range content (`origin/main..origin/dev`)

21 files, +651/-73:

- `src/server/responses/input-admission.ts` — new module (169 lines): refuse
  input that cannot fit the model context window
- `src/responses/state.ts` (+162) — stop `previous_response_id` replay from
  compounding history
- `src/codex/shim.ts` (+105) — restore an unprobeable launcher on shim rollback
- `src/providers/registry.ts` — MiMo Free reasoning-effort cap
- `src/lib/errors.ts` — Windows ACL hardening failures classified 503 not 401
- `src/vision/index.ts`, `src/adapters/*`, `src/chat/inbound.ts`,
  `gui/src/pages/*` — vision modality detection, GUI V2 mode-switch errors,
  container-query stat rows

## Security-boundary scan

`git diff --name-only origin/main..origin/dev` filtered for
`auth|token|oauth|credential|workflow|release|secret` returns only
`package.json`. No authentication path, no credential handling, no
`.github/workflows/` change, no `scripts/release.ts` change. Per `AGENTS.md`
section "Review guidelines" this promotion needs no separate security review.

## Gate evidence on the exact dev head

- `ci.yml` Cross-platform CI — completed/success @ `81ada7cd0`
- CodeQL — completed/success @ `81ada7cd0`
- `service-lifecycle.yml` — last dev run success @ `875bb70c3`; the release
  bump commit itself touches `package.json`, which is a service-gate trigger
  path, so a fresh run on the release SHA is required and will be produced by
  the promotion push.
- Local: `bun run typecheck` exit 0; `bun test` 11965 pass / 8 skip / 0 fail,
  56382 expects, 739 files, 525.96s; `bun run privacy:scan` passed.

## Release-workflow constraints that shape the plan

From `.github/workflows/release.yml`:

1. Must dispatch from `main` or `preview`; any other ref is rejected.
2. `main` requires a stable semver version plus dist-tag `latest`; `preview`
   requires a `-preview.` prerelease plus dist-tag `preview`.
3. The CI gate accepts only a push-event `ci.yml` success on the release
   branch for the exact release SHA. A PR run for the same SHA does not
   qualify.
4. `expected-sha` is mandatory and must equal the resolved branch head at
   dispatch time.
5. Publishing refuses a version whose `v<version>` tag already exists.

`scripts/release.ts` automates bump, commit, push, wait for both workflows,
dispatch, and watch, and is mutating even without `--publish`.

## Version decision

- Stable lane: 2.19.0. The range adds a new admission module and new
  provider-registry capability fields, which is feature-bearing, not a patch.
  Precedent on this repository: `2.17.0` and `2.16.0` were cut for comparable
  fix-plus-capability ranges.
- Preview lane: 2.19.0-preview.20260815, matching the established
  `x.y.z-preview.YYYYMMDD` train (`2.17.1-preview.20260814`,
  `2.15.1-preview.20260814`).
