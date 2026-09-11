# Release operation

1. Pin candidate `7797586a8899c673eab48886a490e85b480c6d72` and record its CI witness `9ad218a9bdd34ee33004c35706d78396bf02eef2` (runtime-identical; devlog-only delta). Confirm published baseline tags and that `v2.48.0` and `v2.48.0-preview.*` are unused.

2. Regression review of `origin/main..origin/dev`: 70 commits, 162 changed files, 25 under `src/`. Read the delta for release-blocking risk in routing, auth, credentials, release automation, and workflows. Hosted CI on the witness SHA is the mechanical evidence; the local suite is NOT RUN by owner instruction.

3. Create two independent promotion branches from `origin/preview` and `origin/main`, merge the frozen candidate into each, resolve only the channel version conflict, and set `package.json` to `2.48.0-preview.20260908` on the preview branch and `2.48.0` on the main branch. The runtime tree on each branch must equal the candidate exactly apart from that one version line; prove it with `git diff` restricted to non-version paths.

4. Push both branches with `--no-verify` (owner instruction), open template-complete PRs, and wait for each merge SHA's own push-event Cross-platform CI and Service lifecycle. `enforce-target` will fail on both by design; record it as the authorized promotion exception.

5. Dispatch `release.yml` with `expected-sha` equal to the branch tip: dry-run first, then preview, then stable, serialized. Verify `npm view @bitkyc08/opencodex dist-tags`, published `gitHead`, tarball SHA-512, provenance, and the GitHub tag and release. Run a published-package smoke in an isolated home.

6. Record the outcome in `090_delivery.md`, confirm `dev` remains ahead of both channels, and leave unrelated dirty files in the primary checkout untouched.

Activation scenarios: a moved branch means refuse the dispatch and repin; a failed CI job means inspect and repair rather than rerun blindly; a post-publish smoke failure means inspect registry metadata before any retry, and never republish blindly. Rollback artifact `v2.47.0` stays published; no destructive rollback is planned.

