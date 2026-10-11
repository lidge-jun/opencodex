# L4 — platform

Worktree `/tmp/ocx-rt6-l4`. Items: #6238 (merge in place), #6161 (update + fix-up in place).

## #6238

Review plus negative cases: the ownership probe (`src/service-manager-probe.ts:563-564`) accepts the
standalone `"%OCX_BUN%" start` form only when the wrapper has no `OCX_CLI` set line and otherwise
matches the generator exactly; malformed or mixed wrappers and source installs still fail closed.
If negative cases are missing, the worker adds them on lane branch `codex/rt6-l4-6238-negatives` based
on the PR head, pushes that branch, and reports HANDOFF with the commit and the observed PR head. The
coordinator applies it to the contributor branch (maintainers can modify) and re-reads the PR head.
Tests: `bun test tests/codex-integration/codex-service-manager-probe.test.ts`.

## #6161 (in place, branch `fix/6139-packaged-keyring`, head 44751969e0 at survey time)

Bring the branch current by merging origin/dev into it (no force-push), resolve conflicts (notably
`src/cli/index.ts`, file-size ratchet), answer the open symlinked-package-layout review thread with a
test, and run: `bun test tests/ci-workflows/keyring-smoke.test.ts tests/ci-workflows/release-desktop-scripts.test.ts tests/gui/standalone-build-script.test.ts tests/ci-workflows/ci-scope-reduction.test.ts tests/gui/gui-desktop-sidecar-script.test.ts`
and typecheck. Fresh exact-head CI must include the packaged platform jobs. Independent security review
covers the native credential loader and the `ci.yml`/`release.yml` edits.
Packaged evidence is two separate claims: (a) the packaged sidecar, launched from an unrelated cwd,
loads the native addon (CI packaged jobs / verify scripts); (b) an actual OS credential operation
succeeds through it. The lane records which of the two it has. #6139 is closed only with (a) on the
candidate artifact and a written statement of whether (b) was exercised; without (a) it stays open
and the release notes must not claim the repair.
