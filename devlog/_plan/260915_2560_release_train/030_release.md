# wp4 — 2.56.0 release

## Preconditions

- wp2 closed: #4683 on `dev`, Cross-platform CI green at its exact head.
- wp3 closed: no open REGRESSION finding, and a recorded go decision.
- The release candidate SHA is frozen: `2702911708`, which reads 2.56.0 in `package.json`.

## Sequence

The order is forced by `MAINTAINERS.md` lines 84-91 and by three gates in
`.github/workflows/release.yml`. It is written here because the first version of this document
had it backwards.

1. **Freeze the candidate.** `2702911708`. Everything below publishes that tree and nothing else.
2. **Move `dev`'s version line first.** Dispatch `dev-version-bump.yml` with
   `intended-version: 2.56.0`, mode `pre-move`, and merge the pull request it opens. `release.yml`
   ends with `Require dev to be ready for this release`, which runs
   `version-line.ts assert-ahead <dev version> <release version>` and refuses to publish while
   `dev` still reads 2.56.0. Doing this after publication is what left `dev` and every open pull
   request carrying a failure contributors could not fix from their own diff, ten times.
3. **Promote the frozen candidate to `main`.** The promotion branch is cut from `2702911708`, not
   from the post-bump `dev` tip, so `main` receives 2.56.0 rather than the next line. Its
   `enforce-target` check fails with "wrong base (main)" — that gate exists for feature pull
   requests and every promotion carries the same red mark; the 2.55.0 promotion #4619 merged in
   exactly that state.
4. **Prove the release SHA.** `release.yml` requires a successful Cross-platform CI run for the
   dispatched commit, and a successful Service lifecycle run for it as well whenever
   `src/service.ts`, `src/cli.ts`, `src/cli/index.ts`, `src/lib/bun-runtime.ts`, `package.json`,
   `bun.lock` or either of those two workflow files changed since the previous tag. `package.json`
   always changes across a release, so Service lifecycle is always required here.
5. **Dispatch `release.yml`** with `version: 2.56.0`, `tag: latest`, `dry-run: false` and
   `expected-sha` set to the `main` release commit. The workflow refuses any dispatch whose
   `GITHUB_SHA` differs, so the branch must not move between step 4 and here.
6. **Promote to `preview`.** `preview` currently carries `2.55.0-preview.20260914`; bringing it
   onto the released tree keeps the prerelease train from restating a shipped stable.
7. **Verify the publish from the workflow's own conclusion.** Registry metadata can lag a
   successful publish; a lagging read is not a reason to publish again.

## Evidence

Recorded as each step completes: SHA, run id, conclusion.

- Candidate `2702911708`. #4683 landed at head `d8ef6ee9b889e51e5d3e547d60a537b8fbecfb85` with
  Cross-platform CI run `34935526979` success; two earlier heads were superseded, and the last of
  them failed the file-size ratchet on `tests/responses/responses-state.test.ts`, which was fixed
  by removing the three added lines rather than by raising the baseline.
- Pre-move pull request: #4686 (`dev` to 2.57.0).
- Promotion pull request to `main`: #4687, cut from the frozen candidate.
