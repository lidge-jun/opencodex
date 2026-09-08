# 040 — Delivery record: code-mode host contract

Recorded 2026-09-07 from GitHub PR and Actions API responses. This records the delivery requested
by [030_docs_and_delivery.md](030_docs_and_delivery.md#d-record).

## Delivered revision and CI identity

- [PR #3854](https://github.com/lidge-jun/opencodex/pull/3854) is merged into `dev`;
  GitHub records `merged_at: 2026-09-07T06:41:03Z`.
- Final PR head: `6bdcba5bff4196debf3cd159c7af3d34e35a24e0`.
- Merge commit: `ece556a6ed32dc811bd660ddd8ef9e829512457a`.
- [Pre-merge CI run 34090946313](https://github.com/lidge-jun/opencodex/actions/runs/34090946313),
  attempt 1: `event: pull_request`, `head_sha: 6bdcba5bff4196debf3cd159c7af3d34e35a24e0`,
  `status: completed`, `conclusion: success`; updated `2026-09-07T06:39:04Z`.
- [Merge-head CI run 34091933836](https://github.com/lidge-jun/opencodex/actions/runs/34091933836), attempt 1:
  `event: push`, `head_sha: ece556a6ed32dc811bd660ddd8ef9e829512457a`,
  `status: completed`, `conclusion: success`; updated `2026-09-07T06:50:18Z`.

The pre-merge run matches the final PR head; the later push run matches the merge commit.
These are distinct CI records. This API check does not attest that the separate local receipt
required by 030 was recorded.

## Per-job results

Each run has 21 completed jobs: 19 success, 2 skipped. Every job has the same conclusion in both
runs. Names below are the literal Actions job names; each evidence link identifies its own run.

| Job | Conclusion in both runs | Pre-merge evidence | Merge-head evidence |
|---|---|---|---|
| `select windows runner` | success | [job 101644191502](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644191502) | [job 101647069433](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647069433) |
| `changes` | success | [job 101644191303](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644191303) | [job 101647069779](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647069779) |
| `windows ${{ matrix.shard }}/6` | skipped | [job 101644212182](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644212182) | [job 101647096144](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647096144) |
| `macos 1/2` | success | [job 101644233998](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644233998) | [job 101647111898](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111898) |
| `api usage` | success | [job 101644234038](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234038) | [job 101647111914](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111914) |
| `storage policy` | success | [job 101644234034](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234034) | [job 101647111922](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111922) |
| `docker smoke` | success | [job 101644234277](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234277) | [job 101647111928](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111928) |
| `keyring ubuntu` | success | [job 101644234063](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234063) | [job 101647111929](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111929) |
| `test 3/4` | success | [job 101644234103](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234103) | [job 101647111932](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111932) |
| `test 4/4` | success | [job 101644234047](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234047) | [job 101647111936](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111936) |
| `keyring macos` | success | [job 101644233982](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644233982) | [job 101647111942](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111942) |
| `test 1/4` | success | [job 101644234139](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234139) | [job 101647111951](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111951) |
| `gates` | success | [job 101644233985](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644233985) | [job 101647111970](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111970) |
| `keyring windows` | success | [job 101644234037](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234037) | [job 101647111972](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111972) |
| `macos 2/2` | success | [job 101644234066](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234066) | [job 101647111974](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111974) |
| `npm-global ubuntu-latest` | success | [job 101644234059](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234059) | [job 101647111980](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111980) |
| `npm-global windows-latest` | success | [job 101644234098](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234098) | [job 101647111990](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647111990) |
| `test 2/4` | success | [job 101644234167](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234167) | [job 101647112003](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647112003) |
| `npm-global macos-latest` | success | [job 101644234033](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644234033) | [job 101647112012](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647112012) |
| `macos control` | skipped | [job 101644235362](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101644235362) | [job 101647112696](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101647112696) |
| `ci` | success | [job 101646588871](https://github.com/lidge-jun/opencodex/actions/runs/34090946313/job/101646588871) | [job 101649082610](https://github.com/lidge-jun/opencodex/actions/runs/34091933836/job/101649082610) |

The Windows full-suite matrix was **SKIPPED in both runs**. Windows keyring create/read/delete smoke and
npm-global packaging/install/help smoke passed; those focused passes do not establish Windows
full-suite coverage. The `ci` aggregate accepts successful or skipped prerequisites, so its green
result does not turn skipped jobs into passes. On the merge-head run, `gates` includes successful Typecheck, GUI tests,
Privacy scan, skill-surface check, release-helper syntax check, and CLI help smoke; its GUI lint,
GUI build, and dashboard-preview steps were skipped.

Evidence retrieval (read-only):

```sh
gh api repos/lidge-jun/opencodex/pulls/3854
gh api repos/lidge-jun/opencodex/actions/runs/34090946313
gh api 'repos/lidge-jun/opencodex/actions/runs/34090946313/jobs?per_page=100'
gh api repos/lidge-jun/opencodex/actions/runs/34091933836
gh api 'repos/lidge-jun/opencodex/actions/runs/34091933836/jobs?per_page=100'
```

## Limits and residuals

The delivered scope is the pre-call guidance and post-hoc recovery annotations described in
[030](030_docs_and_delivery.md). Guidance cannot force model compliance, repair the model's
JavaScript or patch payload, or replace the host's validation. The effect on the live Grok defect
rate remains **unmeasured** until a live re-probe; CI success is not a defect-rate measurement.

Anthropic, Google, OpenAI-chat, and command-code tool-result paths still lack exec-result
annotation seams and do not annotate these host failures. Existing coverage is limited to native
routed Responses, Kiro, and Cursor.

Two public review threads were **OPEN / UNRESOLVED in the recorded 2026-09-07 audit snapshot**: GitHub's review-thread API returned
`isResolved: false` for both on 2026-09-07. The merge and green CI do not resolve these findings.
Source inspected for that snapshot was read at worktree HEAD `0fd3408b99994f74bd509975df7ee89823ddfecd`:

- [discussion_r3947178410](https://github.com/lidge-jun/opencodex/pull/3854#discussion_r3947178410):
  `src/adapters/exec-tool-result-normalize.ts:196` searches arbitrary output for a marker substring.
  Successful output from a command such as `rg` or `cat` can therefore receive a misleading
  recovery hint when it quotes that phrase, even though the command did not fail. The requested
  host-error status/envelope or exact diagnostic check remains unimplemented at this anchor.
- [discussion_r3947178418](https://github.com/lidge-jun/opencodex/pull/3854#discussion_r3947178418):
  `src/adapters/cursor/tool-result-normalize.ts:114` gates annotation on tool name/namespace
  without request-catalog or freeform provenance. A structured tool named `exec` can receive
  unrelated host guidance. The requested code-mode provenance check remains unimplemented at
  this anchor.

These limitations were also recorded in [000](000_plan.md). Recording them here is not a fix,
review resolution, or claim that successful output is left byte-identical.

Local runtime, tests, typecheck, build, and install: **NOT RUN** by instruction. No live model
re-probe was performed for this record. The remote results above belong to the recorded PR head
and merge commit and do not validate later candidate documentation or test patches.
