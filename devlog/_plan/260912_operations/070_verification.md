# Final tips and handoff

Dependency: each implementation. No new behavior by default; append a separate PABCD repair cycle when actual final-tip CI failure identifies a necessary delta.

For each independently mergeable branch: record git rev-parse HEAD, original source PR disposition, included commits, gh pr view headRefOid/baseRefName, successful native-membership read (or unknown), and gh run view for the exact Cross-platform CI run. Manual chains only when later work consumes earlier code; verify lower SHA ancestry at the final tip and record bottom-to-top order. Do not cancel auto-CI or change workflow/protection. No merge/auto-merge, closure, release or user service operation.

A local receipt may run git diff --check and read-only hosted-result assertions; it is not a local test result. Local suites, typecheck/build/install are NOT RUN. Final behavior acceptance comes from GitHub-hosted test runs at the final SHA and independent review; author reports/old green CI are not substituted.

Update ignored .tmp/operations/handoff.md as soon as each artifact exists. Include outstanding issue acceptance, original author trailers, unresolved maintainer objections, exact run links/conclusions and cycle ledger pointers. Publish template-complete PR bodies with truthful verification, screenshots for changed dashboard UI and no private investigation notes. Parent owns all integration decisions.
