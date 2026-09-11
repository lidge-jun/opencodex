# Release 2.48.0 plan

Owner-authorized HOTL release train for OpenCodex 2.48.0. The owner asked for a regression check of `dev` against `main`, two promotion pull requests, merges into `main` and `preview`, and npm publication. The owner also forbade running the local test suite and required `--no-verify` for any push, so every verification claim in this unit rests on hosted CI at an exact SHA. Local typecheck, local `bun run test`, and local privacy scan are NOT RUN by instruction and are labeled that way wherever they would otherwise appear as evidence.

## Candidate

Release candidate: `7797586a8899c673eab48886a490e85b480c6d72` (`origin/dev` tip, 2.48.0 in package.json).

Published baseline: `@bitkyc08/opencodex` `latest=2.47.0`, `preview=2.47.0-preview.20260908`. `origin/main` is `f7f890ff7` at 2.47.0; `origin/preview` is `3bef20677` at 2.47.0-preview.20260908. `dev` is 70 commits ahead of each.

The candidate tip itself has no Cross-platform CI run because its only delta against `9ad218a9bdd34ee33004c35706d78396bf02eef2` is under `devlog/`, which the workflow's push path filter excludes. `git diff --name-only 9ad218a9b 7797586a8 -- . ':(exclude)devlog'` returns zero files, so `9ad218a9b` is the runtime-identical CI witness for the candidate: 19 successful check-runs, two deliberately skipped (`macos control`, the Windows shard placeholder). That equivalence is stated explicitly rather than assumed, because the promotion merge SHAs will carry their own push-event CI regardless.

## Scope

In scope: version metadata on the two promotion branches, promotion PRs into `preview` and `main`, merges, `release.yml` dispatch for preview and stable, and registry/tag verification. Also in scope: a PABCD repair cycle merged into `dev` if regression evidence shows a defect, followed by a repeat of the release verification.

Out of scope: unrelated open PRs and issues, dev-version bumping beyond what the release requires, installed-service upgrades, account settings, and any change to branch protection or CI gates.

## Work phases

- wp1 — this roadmap. Pin the candidate, record the CI-equivalence argument and the promotion procedure. No product change.
- wp2 — regression verification of the candidate against `main` using hosted evidence only.
- wp3 — promotion branches and PRs, merged with exact-head CI.
- wp4 — npm preview and stable publication with registry verification.

## Verification and outcomes

Each promotion SHA needs its own successful push-event Cross-platform CI and Service lifecycle before any publish dispatch. Publication proof is npm dist-tags, the published `gitHead`, tarball integrity, provenance, and the GitHub tag and release. `enforce-target` is expected to reject both promotion PRs because its allowed bases contain only `dev`; that is the established authorized promotion exception and is reported as failing, never as passing.

DONE requires both channels published and verified with `dev` still ahead. BLOCKED is a concrete external prerequisite or a failed gate with no safe remedy. A failing gate is repaired or remains a blocker; it is never weakened, and no check is disabled to hide it.

