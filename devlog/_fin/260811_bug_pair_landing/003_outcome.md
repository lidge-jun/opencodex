# 003 — Outcome

All seven pairs landed on local `dev`. Nothing was pushed, no PR was merged
remotely, no issue was closed, and no comment was posted — those remain the
maintainer's decisions.

## Commits, in landing order

SHAs below are the **rebased** ones on `dev` after integration onto
`origin/dev` `9ec2e2d94`. The pre-rebase SHAs survive only on
`backup/pre-rebase-260811` and are given for cross-reference.

| WP | Pair | Contributor commit | Our correction |
|---|---|---|---|
| — | plan | — | `847c63f8e` devlog unit (was `cd4660ed9`) |
| wp1 | #1459/#1460 | `c7eec01ca` (tlsdnwn55, was `95d50b95d`) | `af80bb69a` byte compare (was `450bcbf66`) |
| wp4 | #1453/#1461 | `e1b511e29` (Ingwannu, was `4eaa4dda6`) | none needed |
| wp7 | #1439/#1441 | 15 commits (comfuture), merge `5cf00287a` flattened by the rebase | none needed |
| wp6 | #1429/#1434 | Yuxin-Qiao's commits, merge `0e0f7d58e` flattened | `d065fd0ad` flush + cap (was `88e31a989`) |
| wp3 | #1454/#1465 | `1fa020a90` (Ingwannu, was `4ed84d81d`) | `6312aef83` rollback ownership (was `86ce5f450`) |
| wp5 | #1449/#1452 | `fcb337a18` (Ingwannu, was `71ebada71`) | `4368bb352` typed sentinel (was `6e220125b`) |
| wp2 | #1273/#1462 | `022cbd21e` (Yuxin Qiao, was `137334db4`) | `1b655b74c` deletion wins (was `1c71b591a`) |
| — | full-suite fallout | — | `d6e4545b2` disk-only key rebase (was `d26cff553`) |
| — | flake | — | `f43110286` convergence timeout (was `f3a2698eb`) |

Every contributor commit kept its original author. Corrections are separate
commits so the contributor's work and ours stay distinguishable in `git log`.

## Defects we found that no reviewer had filed

Four, and three of them were in PRs whose own tests were green:

1. **#1462 delete-vs-live-edit resurrection.** The rebase only protected rows
   untouched in memory. Probed at the contributor head: a provider and a custom
   model deleted on disk while edited in memory both came back. Fixed in
   `1c71b591a`; the persisted deletion now wins.
2. **#1465 unproven rollback ownership.** Rollback deleted the scheduler task by
   name, with a non-atomic absence probe, so a concurrent registration could be
   destroyed by our cleanup. Fixed in `86ce5f450`: an attempt nonce rides in
   `RegistrationInfo/Description`, is verified before deletion, and residual
   scheduler state is reported when ownership cannot be proven.
3. **#1462 disk-only key resurrection.** Found only by the full suite:
   `PUT /api/grok/selection` with an empty list stopped clearing the field. The
   live baseline is armed once, so a key that appears on disk afterwards is
   missing from both baseline and live config, and the rebase reads that as
   "live never changed this key." Bisected to `137334db4` and reproduced on the
   untouched head `2f9225915`; clean `87e3ff9f6` passes 10/10. Fixed in
   `d26cff553`.
4. **#1441 stale review.** The three filed blockers were already closed on head
   `aa256f6d3`; the reviewer had judged the replaced head `a8087d350`.

Item 3 is the one worth remembering. The contributor's CI was green because
`tests/grok-management-api.test.ts` runs in a different shard than the new
tests, and their focused run never touched it. A focused suite proves the fix;
only the full suite proves the absence of collateral damage.

## Red CI, resolved as infrastructure

#1461 and #1441 both arrived red. Neither had a regression:

- Bun 1.3.14 `panic: Segmentation fault` (exit 132) with no assertion failure;
- Bun 1.3.14 Linux `epoll_ctl EEXIST` followed by `Cannot call describe()/test()
  after the test run has completed`;
- the #1302 shard hang: silence for ~14m44s in `tests/cli-models.test.ts`, then
  cancellation at the 15-minute cap;
- a 10s timeout on a `cursor-blob` assertion neither PR touches, which runs in
  ~170ms locally.

All re-ran green locally on the merged tree. Two of our four categories of CI
red are our own toolchain, which is worth its own unit.

## Ablations

Every correction was driven red before it went green:

| Correction | Red evidence |
|---|---|
| `450bcbf66` | regression fails against the string comparison; `decodedEqual=true bytesEqual=false`, `corruptedRewritten` false → true |
| `1c71b591a` | 34 pass / 2 fail without the fix |
| `86ce5f450` | matching-nonce rollback test 0 pass / 1 fail without the fix |
| `6e220125b` | 4 fail without the sentinel gate; each returned the fixed System32 path |
| `88e31a989` | cap test `Expected: <= 1122, Received: 1151`; flush test resolves instead of rejecting |
| `d26cff553` | `Received: [ "a" ]` — the deleted field comes back |

## Full-suite result

Two runs on the final tree.

**Run 1** — `11035 pass / 8 skip / 1 fail` across 680 files (529s). The failure
was `PUT /api/grok/selection with an empty list removes the field`, bisected to
the contributor commit and fixed in `d26cff553` (see item 3 above).

**Run 2** — `11036 pass / 8 skip / 1 fail` (578s). The Grok failure is gone. The
remaining failure is a timeout, not an assertion:

```text
(fail) retained sync and convergence produce identical canonical bytes in either order [5709.86ms]
  ^ this test timed out after 5000ms.
```

Measured rather than assumed:

| Condition | Duration | Result |
|---|---|---|
| isolated, our tree | 2459ms | pass |
| isolated, clean `87e3ff9f6` | 2450ms | pass |
| alongside 6 sibling suites (414 tests) | 2519ms | pass |
| inside the full 680-file run | 5709ms | timeout |

Our changes did not make it slower — the clean baseline runs it in the same
~2.45s. The test sits at roughly half of bun's 5s default and only crosses the
line under full-suite parallelism. It is a latent flake in the same family as
#1302, not a regression from this unit, so `f3a2698eb` raises that file's
default the way the heavier management suites already do.

**Run 3** — `11037 pass / 8 skip / 0 fail` across 680 files (549s). Clean.

Three full-suite runs were needed, and they earned their cost: run 1 found a
real regression in a contributor commit whose own CI was green, and run 2 found
the latent timeout. A focused suite would have shipped both.

## Verification gaps, stated plainly

- **wp3 and wp5 are Windows-only** and `windows N/4` is SKIPPED (#1059). Both
  test through injected seams on macOS. No real `schtasks` call and no real
  ARM64 `bun:ffi` absence was exercised anywhere in this session.
- wp7 writes and deletes files on the user's `PATH`. Its dash regression ran for
  real here (`/bin/dash` exists on this host), but the Windows half of that
  surface is untested for the same reason as above.

## Still open, deliberately

The four bug-labelled PRs with no linked issue (#1464, #1448, #1412, #1380) were
out of scope for this unit. Of the 21 bug issues, 14 remain without a paired PR —
including both U+FFFD investigations (#904, #417), both CI issues (#1302,
#1059), and #1395, whose per-app-server attribution problem is adjacent to the
catalog work landed here.
