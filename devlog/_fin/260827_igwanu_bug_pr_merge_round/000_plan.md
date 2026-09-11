# 000 — igwanu bug-PR merge round: plan

Round base: `dev @ 8b1b65b8d` (local == `origin/dev`, verified 2026-08-27).
Scope: the 13 open **bug**-labelled PRs. Four are Ingwannu's (#2767, #2766, #2764,
#2761); nine are other authors' (#2747, #2745, #2740, #2733, #2729, #2726, #2693,
#2638, #2497).

Enhancement-labelled PRs are explicitly out of scope for this round.

## The finding that orders the whole round

Three PRs (#2767, #2764, #2747) show **failing required CI** — `ci`, `macos`,
`test 3/4`, `gates` — while their own merged trees compile clean. The failure is
not theirs. Every one of them fails the same repository-wide assertion:

```
error: package.json version 2.34.0 equals release tag v2.34.0, but this commit is
not the one that tag names. The tree claims an already-published version.
(fail) release version line > the in-tree version is never behind a released one
```

`dev` still carries `2.34.0` after tag `v2.34.0` shipped, so *every* PR opened
after the release train inherits a red matrix. A second shared failure hits
`gates`: `privacy:scan` reads the scp-style SSH remote principal recorded in
`devlog/_plan/260827_release_train/020_preview_release.md` as an email address.

**#2766 repairs both.** It is the keystone: until it lands, no other PR in this
round can produce a trustworthy green matrix, and re-running their CI is wasted
work. This is the inverse of the previous round's lesson — there, green checks
were not evidence of health; here, red checks are not evidence of harm.

Evidence: run `33081644562` job `98550259965` (#2767), run `33080634739` job
`98546624127` (#2764), run `33059606933` job `98534630924` (#2747) — each shows
`1 fail` and that one failure is `release version line`.

## Merged-tree gate (this round's own evidence, not GitHub's)

Every PR head was fetched, merged against `dev @ 8b1b65b8d` with
`git merge-tree --write-tree`, committed as `mtp/<n>`, checked out to an isolated
worktree sharing this repo's `node_modules`, and compiled.

| PR | ahead | behind dev | merge-tree | tsc on MERGED tree |
|---|---|---|---|---|
| #2767 | 1 | 0 | CLEAN | OK |
| #2766 | 2 | 0 | CLEAN | OK |
| #2764 | 1 | 0 | CLEAN | OK |
| #2761 | 1 | 2 | CLEAN | OK |
| #2747 | 1 | 26 | CLEAN | OK |
| #2745 | 2 | 26 | CLEAN | OK |
| #2740 | 1 | 26 | CLEAN | OK |
| #2733 | 1 | 43 | CLEAN | OK |
| #2729 | 2 | 89 | CLEAN | OK |
| #2726 | 1 | 63 | CLEAN | OK |
| #2693 | 2 | 118 | CLEAN | OK |
| #2638 | 2 | 179 | CLEAN | OK |
| #2497 | 1 | **386** | **CONFLICT** | not reachable |

The typecheck gate was itself verified rather than trusted: 12 runs finishing in
~12s looked like a no-op, so a deliberate `const x: number = 'str'` was injected
into a merged worktree and `tsc` returned `error TS2322`, exit 1. The speed is
real — this repository is on the native TypeScript 7.0.2 compiler (~0.44s full
typecheck). The gate works.

## Cross-PR file contention

`src/server/responses/core.ts` — **#2745, #2638, #2497**. Pairwise
`git merge-tree` required before any second one of those lands; textual
mergeability is not behavioral compatibility on the auth/routing boundary.

`src/adapters/openai-chat.ts` — #2764 only. `src/adapters/openai-responses.ts`
— #2767 only. `src/codex/auth-context.ts` — #2638 and #2497.
No other file is touched by two in-scope PRs.

## Loop-spec

- Loop archetype: verifier-defined (spec-satisfaction repair per PR).
- Write scope: `devlog/_plan/260827_igwanu_bug_pr_merge_round/`, `src/` and
  `tests/` only where needed to land or reimplement a PR, plus PR metadata on
  GitHub and `codex/` topic branches.
- Out of scope: `main`, `preview`, releases, tags, npm publish, docs deploy,
  enhancement PRs, force-push, history rewrite.
- Bounds: `dev` is push-protected — every lane travels a `codex/` branch and a PR
  targeting `dev`. `bun test` takes a machine-wide lock: one suite at a time,
  long suites on `ssh lidge` via `ocx-run`. Never `OCX_TEST_NO_QUEUE=1`.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 000 | Docs-only roadmap: intake, merged-tree gate, contention map, lanes | — |
| wp2 | 010 | **Keystone** #2766 — unblock the repository-wide CI gates | wp1 |
| wp3 | 020 | Ingwannu remainder #2761, #2764, #2767 | wp2 |
| wp4 | 030 | Clean approved lane #2733, #2726, #2747 | wp2 |
| wp5 | 040 | Maintainer changes-requested #2745, #2729 | wp2 |
| wp6 | 050 | Contributor remainder #2740, #2693, #2638 | wp2, wp5 |
| wp7 | 060 | #2497 adjudication + round close-out | all |

## Standing gates (inherited, all mandatory)

1. Compile evidence comes from the MERGED tree, never the PR head alone.
2. Any two PRs touching a shared file get `git merge-tree` before either merges.
3. Green checks are not health unless the list includes `ci` / `test N/4` /
   `macos`. **Corollary discovered this round: red checks are not harm until the
   shared baseline is green.**
4. One `bun test` suite at a time; remove a stale
   `/tmp/opencodex-bun-test.lock` rather than bypassing the queue.
5. Every lane travels a `codex/` branch and a PR targeting `dev`.
6. A safety net that exists in code is not a safety net that functions.

## Accept criteria (mirrored into goalplan criteria[])

- c1 — all 13 PRs carry a recorded terminal disposition with SHA or reason.
- c2 — merged-tree compile gate ran for every candidate (this doc's table).
- c3 — each landed change carries a focused test receipt from the merged tree.
- c4 — `dev` advanced only through PRs targeting `dev`.
- c5 — auth/credential/OAuth surfaces are not landed autonomously.
