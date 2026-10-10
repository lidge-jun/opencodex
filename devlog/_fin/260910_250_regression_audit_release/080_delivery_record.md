# Delivery record — 2.50.0

Published 2026-09-10. `@bitkyc08/opencodex@2.50.0` is the npm `latest`.

## The chain, end to end

| # | What | Value |
| --- | --- | --- |
| 1 | Released baseline | `v2.49.0`, `main` `2f3f736299dca38861f8fb9c4326a4b4d7c664bc` |
| 2 | Audited freeze SHA | `12c248f52bed88ea13be5b284c79a238feb592d1`, tree `d8f5a7143bcd6cb86185c4e8d4c6a6c4ad0fa822` |
| 3 | Candidate CI | `ci.yml` `lane=all` run 34457689927, success |
| 4 | `dev` pre-move | run 34463313646 -> PR #4194 -> `dev` `cf44f6fe887d19f53ede1e09abfe0fe3cf137059` at 2.51.0 |
| 5 | Promotion commit | `3a3de889b6ef3217497f6c5029acf08aec09c0cf` |
| 6 | `main` merge SHA | PR #4195 -> `2d4d7a22381a2e497c2442902104619e25f937c7`, tree `d8f5a7143bcd6cb86185c4e8d4c6a6c4ad0fa822` |
| 7 | Release-branch gates | `ci.yml` 34464454730 success, `service-lifecycle.yml` 34464454609 success |
| 8 | Dry run | `release.yml` 34465317829 success |
| 9 | Publish | `release.yml` 34465442114 success |
| 10 | Registry | `latest` = 2.50.0, `gitHead` = `2d4d7a223`, tarball sha512 matches `dist.integrity`, SLSA v1 provenance present |
| 11 | Tag and release | `v2.50.0` -> `2d4d7a223`, GitHub release published, not a draft |

**One tree throughout.** The audited freeze tree, the promotion commit's tree, and the
merged `main` tree are the same object, `d8f5a7143bcd6cb86185c4e8d4c6a6c4ad0fa822`, and
three audited source files inside the published tarball hash identically to that tree. What
shipped is what was read.

## What the audit cost and produced

Seven `xai/grok-4.6` subagent runs: one standing reviewer across four rounds, and six
concurrent audit lanes. The reviewer failed the first roadmap outright, and that was the
most valuable moment in the whole unit — it caught that the release order did not match
what `release.yml` gates on, that promoting the 2.50.0 tree onto `preview` would have
broken that branch's version line, and that four `src/cli` files had no lane. The lanes
then returned no blockers, and the fourth round audited the release decision rather than
the code and returned GO.

## What is deliberately unfinished

- `preview` stays at `2.49.0-preview.20260909`, npm `preview` at `2.48.0-preview.20260908`.
  It needs its own `2.50.0-preview.<date>` commit, which is a separate decision.
- Seven non-blocking findings (F1-F7) are recorded but not filed as issues.
- The Windows Log Guard reclaim test remains able to exceed the 60s suite limit on a slow
  runner. It is unchanged since 2.49.0; the mitigation is a job rerun, exercised twice here.
