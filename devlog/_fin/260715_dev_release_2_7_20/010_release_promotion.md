# 2.7.20 integration, verification, promotion, and publish plan

## Scope boundary

IN:

- merge `origin/dev@a0e910e1` into local `dev@05b0ec81` without rewriting either line;
- repair only verified blockers introduced by the five divergent commits;
- validate the combined GUI and cross-platform candidate;
- push `dev`, fast-forward `main` and `preview`, publish 2.7.20 from `main`, then align `dev` and `preview` to the release commit;
- persist command outputs, workflow URLs, screenshots, registry/tag/release/install evidence.

OUT:

- unrelated cleanup, new dependencies, new UI direction, public tag rewrites, force-pushes, or changing release workflow semantics;
- claiming Windows runtime proof beyond the repository's Windows CI jobs.

## File change map

- MODIFY (expected): Git history only via one merge commit on `dev`, then `package.json` via `scripts/release.ts`.
- MODIFY: `docs/design-system/README.md` — replace the non-existent `Field` entry in the documented `gui/src/ui.tsx` export map with the real `Notice` primitive (audit Low finding).
- MODIFY: `tests/cursor-desktop-exec.test.ts` — make the external-executor JSON fixture use the active platform's shell built-ins; the exact candidate's Windows CI proved the POSIX-only `cat`/`printf` fixture invalid after the intended `cmd.exe` production fix.
- MODIFY: `src/adapters/cursor/native-exec-desktop.ts` — correct the executor contract comment from `sh -c` to the platform shell; no runtime behavior change.
- MODIFY (conditional): only other files in the divergent commit set when audit or QA proves a release blocker; exact file and regression test must be added to this plan before editing.
- NEW (local, ignored): this devlog unit and C4 screenshot/evidence artifacts.
- No new source module, helper, dependency, workflow, or public contract is planned.

## Plan

### P - candidate definition

1. Pin base/local/remote SHAs and verify 2.7.20 is unused across npm, Git tags, and GitHub Releases.
2. Review PR #134's ADR, design-system docs, React/CSS/Vite diff, and every changed file; review the three local commits and their tests.
3. Define the combined candidate as a normal merge of `origin/dev` into local `dev`.

### A - independent audit

1. Independent reviewer validates the history-preservation strategy, changed-file coverage, release sequencing, rollback, and 2.7.20 metadata assumptions.
2. Reviewer specifically checks GUI token-contract drift, accessibility/focus, responsive regressions, Vite proxy safety, suspicious test weakening, Windows shell/path boundaries, and missing activation scenarios.
3. High/Critical findings block Build. Medium findings are repaired or explicitly tracked with rationale before merge.

### B - integrate and promote

1. Run `git fetch origin dev main preview --tags`, confirm `origin/dev == a0e910e1` and `origin/main == origin/preview == d3f299fa`; stop and re-audit any interdiff if one moved.
2. Merge `origin/dev` into local `dev` with an explicit merge commit. Resolve no conflict by discarding either side.
3. Apply only audited blockers, with focused regression evidence and atomic commits.
4. Run focused checks, then push `dev`; resolve the pushed SHA and require `gh run list --workflow ci.yml --commit <dev-sha>` to report success for that exact SHA. The first exact-SHA run, `29420930374`, failed only in three Windows external-executor behavior tests because their fixture still emitted POSIX commands. Preserve all assertions, repair the fixture, and require a new exact-SHA Windows run as the green proof.
5. Re-fetch and verify `origin/main == d3f299fa`, fast-forward local/remote `main` to verified `dev`, push, and require `gh run list --workflow ci.yml --commit <main-sha>` success.
6. Re-fetch and verify `origin/preview == d3f299fa`, fast-forward local/remote `preview` to the same verified code head, push, and verify its exact-SHA CI without substituting another branch's run.
7. On `main`, run `bun scripts/release.ts 2.7.20 --publish`. This performs local typecheck/test/privacy preflight, creates `release: v2.7.20`, pushes `main`, waits for CI, and dispatches/watches Release.
8. After public release success, fast-forward `dev` and `preview` to the release commit and push; stop if either remote moved unexpectedly.

### C - verification matrix

- Static/package: `bun install --frozen-lockfile`; `bun x tsc --noEmit`; `bun run privacy:scan`; `bun run build:gui`.
- Tests: affected GUI/local regression tests, then `bun test --isolate tests`.
- GUI: `cd gui && bun run lint && bun run build`; start the integrated GUI only with a loopback target, `OPENCODEX_PROXY_TARGET=http://127.0.0.1:<port> bun run dev --host 127.0.0.1`; inspect console and screenshots at 1440, 1024, 768, 390, and 320 px; check light/dark, navigation drawer, dashboard, models, providers/add-provider, logs, usage, focus-visible, reduced motion, clipping, and touch targets.
- Token contract: run the design-system contribution scans and classify each remaining literal as token definition or algorithmic/layout exception.
- CI: Cross-platform CI success for exact `dev`, promoted `main`, and release commit SHAs; relevant docs/service workflows reported but not substituted for runtime CI.
- Public artifact: `npm view @bitkyc08/opencodex@2.7.20 version dist-tags --json`; `git ls-remote origin refs/tags/v2.7.20`; `gh release view v2.7.20`; compare all SHAs.
- Install smoke: pack/install through the published npm package in a fresh temporary prefix and run `ocx help` without relying on a globally installed Bun.
- Rollback proof: before publish, rollback is branch reset by revert commit only. After npm publish, npm versions are immutable; rollback is a new patch release, never unpublish/tag rewrite.

## Acceptance criteria

- No changed file is unaccounted for; no unresolved High/Critical/Medium blocker remains.
- The merged candidate preserves all five divergent commits and both parent histories.
- Local full gates and exact-SHA GitHub CI pass with zero failures.
- GUI renders without console/framework errors, overlap, clipping, unreadable focus, or inaccessible navigation at all required viewports; reduced-motion mode removes transitions.
- `main`, `dev`, and `preview` all contain the exact 2.7.20 release commit after publication.
- npm `latest` resolves to 2.7.20; Git tag and GitHub Release exist at the same commit; fresh install smoke exits 0.
- Working tree is clean and the PABCD evidence ledger is closed in D.
