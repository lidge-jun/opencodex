# Actual product landing proof

Verified 2026-09-08. Final candidate `5d5d35756b9b672aecf10a64be0db1f7afc144ae` and fetched product dev `9ad218a9bdd34ee33004c35706d78396bf02eef2` have identical tree `5fba579b0d10183e921657dbcf4edbd166c20ec7`. `git diff --exit-code` returned0. Each owned head and actual merge commit is ancestral to fetched dev; #3965's existing402be7c1f merge is also ancestral.

| PR | Actual merge commit |
| --- | --- |
| #3986 | `7b2223776450804a6b8a4509a115dd42ee1b9c40` |
| #3991 | `7730f666ee1acabe2cd7729ec56f4c53149d926c` |
| #3992 | `74292a21e6d504960ef753b403341498fd5bfe30` |
| #3993 | `74f62f9c2914ead2fba474aa97734e322251bd46` |
| #4002 | `9ad218a9bdd34ee33004c35706d78396bf02eef2` |

Before each merge, current head/base, actor admin permission, maintainer roster/reviews, CI, native membership and direct-child inventory were refreshed. The dev-only maintainer-integration decision and exact verification were recorded in each owned PR body. No maintainer change request remained. Independent technical/security review duties were retained; this was not self-approval. Native stack membership was empty.

The first four actual merge trees matched their serial predictions. GitHub's final merge refusal was repaired with an independently audited ancestry merge; the final actual dev tree then matched the newly certified head exactly. Full CI34198186409 attempt2 verified all26 named jobs and mandatory execution steps; PR CI34198172044 attempt1 passed. Earlier failed attempts are recorded in071.

Sources3838/3944/3951 are closed, issue3907 is completed, and3965 was already merged. After actual4002 landing, issue3973 was completed and3995 was closed as consolidated. The scope excludes3997/3996. Thirty original user files matched their pinned SHA-256 values with0 missing and0 mismatched; they were excluded from all commits. Scratch/evidence directories remain untracked.

## Archive-only completion record

This closing change moves exactly this unit from `devlog/_plan/260908_bug6_manual_stack/` to `devlog/_fin/260908_bug6_manual_stack/`, updates its terminal records and adds this proof. Product content is unchanged. The closing PR and session receipt verify the exact old/new paths, regular-file modes and blob IDs against the reviewed delta, plus closing CI/metadata and a remote privacy scan. Documentation-only skipped product jobs are NOT RUN, not passing product executions.

The closing PR's own merge SHA cannot be embedded in the commit that creates it. Its observed post-merge ancestry and exact record-only delta are verified after landing in the final session receipt and delivery report, rather than predicted here.
