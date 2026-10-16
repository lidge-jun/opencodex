# Remote validation and delivery

Depends on all accepted implementation slices. Class C3 integration; any admission changes require independent security review.

## Delta

- MODIFY only this unit's outcome/evidence record after source review.
- Publish ordinary branches using git push --no-verify. Native stack registration and repo-wide workflow edits are excluded.
- Final integration branch contains all accepted layers and current dev. Dispatch existing .github/workflows/ci.yml lane=all at its exact SHA; inspect every expected Linux/macOS/Windows shard and supporting gate. No local tests, typecheck, builds or install.
- If final CI fails, inspect log/artifact and then use lower-head or bounded remote cases to isolate it. Never claim skipped/cancelled checks passed or silently weaken assertions. Existing automatic PR jobs may run; no fabricated status.
- Open template-complete ordinary parent/child PRs; preserve contributor trailers. Record local NOT RUN, final integration proof, independently verified issue scope and explicit maintainer integration.
- Merge accepted work through dev PRs with admin authority. Refresh actual base/head and maintainer objections before each write, retain parent refs while children target them, and prove each final merge is an ancestor of fetched dev. If dev changes in another track, review integration delta and refresh final proof where needed.
- Close only fully resolved issues and superseded source PRs with attribution and replacement links; partial/deferred issues remain open with precise status.

No source test is executed merely to verify that its command exists. CI workflow and package scripts are the source-inspection evidence of coverage. Report what each remote job actually did.
