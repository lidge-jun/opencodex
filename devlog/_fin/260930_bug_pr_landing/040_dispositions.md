# Dispositions

## wp2: the ten target PRs

| PR | Outcome | Landed as | Notes |
|---|---|---|---|
| #6319 | merged | b933aa2923 | security PASS (installer manifest bounds) |
| #6308 | merged | 2713b60e32 | security PASS (config-write, marker ownership) |
| #6315 | merged | 57fc9cc57e | |
| #6324 | merged | 8326838e1d | |
| #6325 | merged | f5e9fdabaa | security PASS (redaction) |
| #6326 | merged | b0d275dc79 | security PASS (account pool); follow-up noted: `src/codex/quota.ts:294` legacy provenance default |
| #6281 | carried by #6328 | 662dfe170e | maintainer test fix; original re-drafted by the readiness gate after the maintainer push |
| #6316 | carried by #6329 | 6c32c4da36 | test-layout registration added; stale base had failed release-version-line |
| #6295 | carried by #6330 | 87e182f110 | privacy rework: stored reason limited to status plus allowlisted error type |
| #6260 | carried by #6331 | f9bfca0d0a | config-integrity fix: stale file-backed discovery refused |
| (union) | #6332 | 4f3182292d | five PRs together pushed `structure/providers-and-adapters.md` to 601 lines |

Per-PR merge gate after the user's steering: reviewer evidence, local integration merge onto the
current `dev` with `bun x tsc --noEmit` and the PRs' own test files, no local full suite, and one
Cross-platform CI run on the final `dev` tip.

Process miss: #6331 was merged while its `structure gate` check had failed; the merge helper
checked the maintainer-integration snapshot but not the rollup. The failure was the union budget
overflow above, fixed in #6332.

## wp3: backlog hygiene

Read-only triage by an independent `gpt-6.1-sol` explorer over all open issues and PRs, with
main checking the cited evidence before acting.

Closed:

- #6282 (PR) superseded by #6284 (7904af5db8): `src/codex/shim-templates.ts` builds the standalone
  `ensure` call through `selfLaunchArgv`; `tests/codex-integration/codex-shim-standalone.test.ts`
  covers Unix, CMD and PowerShell.
- #6281, #6316, #6295, #6260 (PRs) closed as carried by #6328, #6329, #6330, #6331 (wp2).

No open issue met the bar for closure: no exact duplicate among open issues, and none is fixed by
a merged PR. The PRs landed in wp2 fix no linked issue.

Left open, uncertain or waiting on an open PR:

- #6275 vs #6302 (self-hosted JEV for #6268): #6302 is broader; keep #6275 until #6302 is decided.
- #6143 vs merged #6285: similar goal (catalog refresh) with a different mechanism (Desktop cache watcher).
- Issues with an open draft fix: #6291 (#6296), #6290 (#6298), #6231 (#6233), #6220 (#6254), #5270 (#6289).
- #6297 is the canonical report for the already-closed #6292; the rate-limit headers are still
  dropped at `src/server/claude-messages.ts`.

## wp4: final dev-tip Cross-platform CI

One run per the user's instruction; the first exposed a regression, so it ran once more after the fix.

- Run 36734548914 (`workflow_dispatch`, `dev` 4f3182292d): failed on Linux shard 3/4, Windows 3/9,
  macOS 1/2 and macOS control, all with the same test,
  `tests/codex-integration/model-visibility-management-api.test.ts` "manual models replace management
  rows…". Cause: #6331 refused discovery publication for any file-backed config that differed from
  disk, so management reads answered `catalog_busy`.
- Fix #6333 (349588e2f1): read consumers apply the new-arrival policy to a detached projection when
  a file-backed config has already drifted; writers still refuse stale publication. An independent
  post-merge review passed with no blockers.
- Run 36737139561 (`workflow_dispatch`, `dev` 349588e2f1, attempt 1): **success**, 38 jobs
  succeeded, 1 skipped (`privacy gate`, skipped by design on dispatch).
