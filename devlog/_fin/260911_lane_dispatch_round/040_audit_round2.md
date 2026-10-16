# Audit round 2 — reviewer verdict and dispositions

Reviewer: a second `xai/grok-4.6` explorer subagent, read-only, fresh context. Verdict: **fail**.

It confirmed that four round-1 findings were actually fixed (the WS split, the #4207 move, the two
PR states, the test-layout rule) and that three were only *described* as fixed. That distinction is
the reason this round exists: a disposition table is not a partition.

| # | Finding | Disposition in revision 3 |
|---|---|---|
| 1 | #4212 also needs `src/server/management/oauth-account-routes.ts`, and its refusal call sites are `core.ts:2243` and `compact.ts:296`, which L1 owns | `oauth-account-routes.ts` is assigned to L3. **Decision: L3 does not change the L1 call sites this round.** Its #4212 scope is the refusal string, the account-health surface, and the management route; call-site attribution becomes a follow-up issue if review asks for it. |
| 2 | `docs-site/src/content/docs/guides/providers.md` was reachable by both L2 (carrying #4210) and L7 | The page belongs to **L7 only**. **Decision: L2 drops that hunk** from anything it carries and reports the needed wording to the orchestrator, who hands it to L7. |
| 3 | The #4203 keep-set was never named, so L4 was told to carry a PR that edits files it must not touch | The keep-set is now enumerated file by file below, and the five files to drop are named too. |
| 4 | L2 was still deciding maintainer policy on #4210 | **Decision: L2 does not build on #4210.** It implements #4201 independently; if its diff would overlap #4210's `quota.ts` hunks, it reports instead of merging the two lines of work. |
| 5 | Territories still used globs while claiming to be explicit lists; bare `plan.ts` matched three files; `src/providers/registry.ts` was unnamed | Ownership is now either an exact path or one named directory, and directories do not overlap. `src/codex/plan.ts` is spelled out; `src/providers/registry.ts` is assigned to L2. |
| 6 | The ledger cited a stale round-PR head and stale lane seed SHAs | The ledger is regenerated from live `git`/`gh` output after every orchestrator commit and carries the capture time. |

## #4203 keep-set for L4

Keep: `bin/ocx.mjs`, `src/cli.ts`, `src/cli/launcher-context.ts`, `src/config/pending-teardown.ts`,
`src/lib/bun-runtime.ts`, `src/lib/package-tree-integrity.ts`, `src/service.ts`, every file under
`src/update/`, the tests `tests/ci-workflows/install-scripts.test.ts`,
`tests/cli/ocx-launcher-runtime.test.ts`, `tests/cli/ocx-launcher-source.test.ts`,
`tests/update/update-badge.test.ts`, `tests/update/update-job.test.ts`,
`tests/update/update-pnpm.test.ts`, `tests/update/update-stop-first.test.ts`, the two test-layout
maps, and exactly one documentation page,
`docs-site/src/content/docs/getting-started/installation.md`.

Drop: `README.md`, `structure/01_runtime.md`, `structure/06_docs-and-release.md`,
`docs-site/src/content/docs/getting-started/for-agents.md`,
`docs-site/src/content/docs/reference/cli/lifecycle.md`.

