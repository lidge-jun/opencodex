# Codex warmup preview release

Date: 2026-07-10
Target: `@bitkyc08/opencodex@2.7.1-preview.20260710`

## Loop specification

- Archetype: spec-satisfaction release loop
- Trigger: publish the already committed Codex warmup fix and Cursor GPT-5.6 catalog additions after the first release attempt stopped before publication
- Goal: publish the target version with npm dist-tag `preview` and create the matching prerelease GitHub Release
- Non-goals: no additional version bump, no change to npm dist-tag `latest`, no CI timeout increase that masks a hung test, and no code changes outside the web-search timeout and requested injection-effort feature
- Verifier: successful Cross-platform CI and Release workflow runs for the exact release HEAD, followed by npm and GitHub artifact queries
- Stop condition: npm exposes the target version under `preview`, `latest` remains `2.7.0`, and GitHub exposes the matching prerelease tag/release at the release HEAD
- Memory artifact: this implementation unit and its phase document
- Expected terminal outcomes: `DONE` after all public artifacts agree; `BLOCKED` for unavailable credentials or infrastructure; `UNSAFE` if public metadata becomes inconsistent and an automatic retry could duplicate or mispoint a release
- Escalation condition: npm publication succeeds but tag/release creation fails, the release branch moves during verification, or trusted publishing rejects the workflow identity

## Baseline

- Branch: `preview`
- Initial release HEAD: `3ce5f9c0806962037c0458849113b87d7b498c08`
- Package version: `2.7.1-preview.20260710`
- Included commits:
  - `a3cc86e8` sends Codex warmup input as Responses API message items
  - `b46dc824` updates remaining warmup payload regression expectations
  - `3ce5f9c0` adds the requested Cursor GPT-5.6 preview models
- Existing public channels before release:
  - npm `latest`: `2.7.0`
  - npm `preview`: `2.6.31-preview.20260707`
- Target version, Git tag, and GitHub Release were absent at preflight.
- Cross-platform CI run `29037460039` for the initial HEAD was cancelled while the Windows test step was running; completed macOS, Ubuntu, and npm-global jobs passed. A successful run for the final release HEAD is still required.
- Service lifecycle run `29037205875` passed at `aca3219e`, but the release workflow requires a successful run for the exact final release HEAD because `package.json` changed after `v2.7.0`.
- A devlog-only push does not match either workflow's push path filters. Both `ci.yml` and `service-lifecycle.yml` therefore require explicit `workflow_dispatch` runs after the record commit.
- Release-record commit `69d8ec7c` was pushed and Service lifecycle run `29039376904` passed on that exact SHA.
- Cross-platform CI run `29039366674` on `69d8ec7c` timed out in the Windows `Test` step. Its last output entered the existing `loop per-iteration timeout surfaces 504 instead of hanging` regression at `tests/web-search.test.ts:210`; the other five jobs passed. Phase 2 repairs this runtime-specific timeout composition before release.
- The user requested that the concurrent `injectionEffort` feature work also ship in this preview. Its design record is `devlog/260710_injection_effort/000_design.md`; Phase 3 audits and verifies that complete API/prompt/Dashboard slice before the final release HEAD is committed.

## Scope and file map

- NEW `devlog/_plan/260710_codex_warmup_preview_release/000_plan.md`: durable release intent, risks, and evidence ledger
- NEW `devlog/_plan/260710_codex_warmup_preview_release/010_phase1_preview_release.md`: exact release execution and verification procedure
- NEW `devlog/_plan/260710_codex_warmup_preview_release/020_phase2_windows_timeout.md`: Windows CI root-cause hypotheses, diff-level repair, and activation proof
- NEW `devlog/_plan/260710_codex_warmup_preview_release/030_phase3_injection_effort.md`: inclusion map and gates for the concurrent injection-effort feature
- MODIFY `src/web-search/loop.ts`: use the existing `signalWithTimeout` helper for iteration deadlines and clean up its timer/listener deterministically
- MODIFY `tests/web-search.test.ts`: harden the hanging adapter against late subscription and cover parent abort plus one deadline across 429 rotation
- INCLUDE `devlog/260710_injection_effort/000_design.md` and the API/prompt/Dashboard/i18n/test files enumerated in Phase 3
- REMOTE GitHub Actions state: Cross-platform CI rerun/new run, then one real `Release` workflow dispatch from `preview`
- REMOTE npm/GitHub state: publish the target version, move only the `preview` dist-tag, create the matching Git tag and prerelease
- OUT: all other `src/**`, `tests/**`, workflow definitions, dependency files, and unrelated user files

## Dependency-ordered work phase

1. Record this plan and audit it against `scripts/release.ts` and `.github/workflows/release.yml`.
2. Repair the Windows-only iteration timeout hang with the existing cross-platform abort helper; keep the existing 504 regression test as the activation probe.
3. Audit and verify the requested injection-effort API/prompt/Dashboard slice, including atomic validation and rendered UI behavior.
4. Commit and push the audited combined changes and amended release record so the final release HEAD is immutable and known.
5. Manually dispatch both Cross-platform CI and Service lifecycle from `preview`, then require successful runs for that exact HEAD.
6. Dispatch one non-dry-run Release workflow with version `2.7.1-preview.20260710` and tag `preview`.
7. Verify the workflow result, npm version/dist-tags, remote tag target, and GitHub prerelease metadata.
8. Append closure evidence, archive this unit under `devlog/_fin/`, commit, and push the record.

## Risks and recovery

- CI cancellation or failure: inspect the exact latest-HEAD job state before rerunning or editing; do not treat partial green jobs as a successful run.
- Windows timeout repair: preserve the iteration-wide deadline and parent-abort semantics, delegate nested iteration events with `yield*`, and always clear the timer/listener when the async generator completes, throws, or is closed by its consumer.
- Branch drift: abort dispatch if `origin/preview` no longer matches the audited release HEAD.
- Partial npm release: npm versions are immutable. If publication succeeds but GitHub metadata fails, do not republish the same version; repair only the missing tag/release against the published HEAD after confirming npm state.
- Bad preview rollout: restore npm `preview` to `2.6.31-preview.20260707`; leave the immutable published version and release evidence intact.
- Stable-channel safety: verify `latest` remains `2.7.0` after publication.

## Acceptance criteria

- The final release HEAD has a completed Cross-platform CI run with conclusion `success`.
- The final release HEAD has a completed Service lifecycle run with conclusion `success`.
- The existing hanging-adapter regression returns HTTP 504 locally and completes on the Windows CI job instead of consuming the job timeout.
- Injection-model API tests prove model/effort roundtrip, clearing, and atomic rejection of invalid effort; prompt tests prove effort is injected only alongside a model.
- The GUI build passes and the Dashboard's model/effort controls render without clipping or overlap at desktop, tablet, and mobile widths.
- The Release workflow completes successfully for that same HEAD with `dry-run=false`, tag `preview`, and the target version.
- `npm view @bitkyc08/opencodex@2.7.1-preview.20260710 version` returns the target version.
- `npm dist-tag ls @bitkyc08/opencodex` reports `preview: 2.7.1-preview.20260710` and `latest: 2.7.0`.
- Remote tag `v2.7.1-preview.20260710` resolves to the release HEAD.
- The GitHub Release for that tag exists and is marked prerelease.
- The working tree is clean after the closure-record commit and push.

## Evidence ledger

Preflight evidence is recorded above. Final CI, workflow, registry, tag, and release evidence is appended during the D phase before this unit is archived.
