# 030 — verify, publish, observe CI, report

## Gates on the final head

```bash
bun install
bun run typecheck
bun run test:changed
bun run structure:check
bun run privacy:scan
bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/file-size-ratchet.test.ts tests/lab/core-lab-boundary.test.ts
```

The full `bun run test` runs if the host allows; otherwise the PR records the AGENTS.md resource exception
with a `NOT RUN:` line.

## Publish

`git push -u origin triage/r1-combo-routing`, then `gh pr create --base dev --body-file <tmp>` with the
template sections (Summary, Verification, Checklist), `Supersedes #8563 #8749 #8575 #8857`, `Closes #8759`,
and the `Co-authored-by` trailers repeated in the description. Link the PR with `goat_pull_request_link`.

## CI

Watch the required PR checks on the exact pushed head; fix real failures with new commits. Report the lane
outcome with `origin.report` including the per-item table and NOT RUN items.

