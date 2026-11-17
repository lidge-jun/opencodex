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

Amended at wp3 entry by coordinator instruction: this host's GitHub credential cannot push. The lane sends
`origin.report` with READY-TO-PUBLISH, the branch, exact head SHA, base SHA and the full PR title and body
(template sections Summary, Verification, Checklist; `Supersedes` lines for #8563 #8749 #8575 #8857,
`Closes #8759`, `Co-authored-by` credit). The coordinator fetches that SHA from this worktree, pushes it,
opens the PR and replies with its URL. Published history is never rewritten; fixes land as new commits.

The gates above run on the exact head that is handed over, so this unit records no later outcome commit;
the CI result goes into the final `origin.report`.

## CI

Watch the required PR checks on the exact pushed head; fix real failures with new commits. Report the lane
outcome with `origin.report` including the per-item table and NOT RUN items.

