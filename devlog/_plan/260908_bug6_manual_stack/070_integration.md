# wp7: hosted verification and integration

Depends on wp1–wp6. The owner explicitly requested a single manual branch chain. This cycle changes only its delivery records and evidence; a discovered product defect is assigned an audited repair cycle before integration continues.

## File changes

- MODIFY this unit's `000_plan.md`: replace in-progress outcomes with exact source commit, PR, run IDs, tested heads and terminal dispositions; record failed/skipped checks separately.
- NEW `071_delivery.md`: six-row original-to-carried PR mapping, attribution, pinned GitHub evidence, active branch/base topology and merge result per layer. Store no account identifiers or private payloads.
- NEW `072_final_proof.md`: fetched dev SHA; per-layer ancestry command results; final candidate tree and landed tree comparison; unchanged pre-existing-file fingerprint verification. If a merge commit contains concurrent changes, isolate and explain each difference rather than claiming whole-tree equality.
- MOVE this completed unit to `devlog/_fin/260908_bug6_manual_stack/` only when all outcomes are terminal. Evidence generated before moving records both paths. Do not move other units.
- GUI screenshot files, if needed, use the existing `.github/pr-assets/` convention after verifying the generated image contains synthetic settings only.

## Exact delivery actions

1. For each nonempty candidate use a new owned `codex/bug6-01a07e9d-*` branch. Bottom base is dev; each upper base is the prior owned branch. Preserve author trailers and satisfy every section of `.github/PULL_REQUEST_TEMPLATE.md`.
2. Commit with `git -c core.hooksPath=/dev/null commit`; push with `git -c core.hooksPath=/dev/null push --no-verify`. No install, test, typecheck or build hook runs locally.
3. Read each PR's current head/base and native `stack` field. A native membership conflict is inspected without mutating membership. Our newly created ordinary PRs must remain manual.
4. Inspect `gh pr checks` and matching workflow runs. Before landing obtain final candidate `ci.yml` `workflow_dispatch` with `lane=all` as well as required PR checks. Bind conclusions to `head_sha`, event and run attempt. Retry failed jobs only after investigating the actual failure and ensuring it does not hide a product regression.
5. For the preset UI, download the hosted `dashboard-preview-*` artifact from the verified head. Verify `build-commit.txt` and `build-gui-tree.txt`; serve the prebuilt bundle with synthetic API fixtures on a disposable loopback port; observe preset activation/restoration and server-switch behavior in a browser; capture/read the screenshot. No local product compilation. Existing browser driver only, no installation.
6. Refresh MAINTAINERS.md, live actor permission, reviewer objections and security evidence. Record maintainer integration in the owned PR body. Land only the bottom PR with `--match-head-commit`; retarget the next child to dev and verify exact resulting integration head/CI. Never merge an upper PR into its parent branch as if that landed it in dev.
7. Fetch dev after each merge and prove the merged commit is an ancestor. At final integration compare actual trees against the final certified candidate, including any explicitly reviewed concurrent dev changes.
8. Refresh each original item and mark closed only if its entire user-visible bug is resolved by the landed tree. Preserve unresolved residuals as open; report the exact residual rather than treating overlap as duplication.

## Activation and observation

- Failed/queued/cancelled hosted job: inspect actual run/head; no merge until required evidence is successful.
- Base advances: recompute integration tree and obtain fresh evidence; old SHA checks are historical.
- A maintainer objection remains: resolve its concrete finding or obtain withdrawal before merge.
- A source PR lands concurrently: verify its actual delta and remaining contract; use an evidence-backed NOOP rather than reapplying it.
- UI stale-server or malformed-recommendation fixture: preset install disabled; custom edit/clear retained; no cross-server write.
- Final condition: all six source contracts mapped to landed results; no destructive changes to user files, service state or credentials.

## Validation limits

Local product tests, installs, typechecks and builds: NOT RUN by owner instruction. Hosted tests and independent source audits provide product evidence; docs-only filesystem/link/whitespace checks provide document evidence. Neither substitutes for the other.
