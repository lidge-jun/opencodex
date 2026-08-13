# 070 — wp7: #1439 / #1441, mise launcher shim recursion

## The defect (#1439)

`installCodexShim()` accepts the first non-OpenCodex `codex` on `PATH`, renames it
to `codex.opencodex-real`, and writes the OpenCodex shim at the original path.
That is safe for a concrete executable or symlink, but not for a dynamic launcher:

```sh
#!/bin/zsh
exec "$HOME/.local/bin/mise" exec -- codex "$@"
```

After the rename, the backed-up launcher asks `mise` to resolve `codex` again, and
with no separate concrete binary in the active toolset, resolution returns to the
newly installed shim. The loop keeps the same PID while replacing its process
image forever.

## Head discrepancy, resolved first

The reviewer's latest review names head `a8087d350`. The actual current head is
`aa256f6d3` — `gh pr view` and the local `pr/1441` ref agree, and `a8087d350` is
an older head that was subsequently replaced. **The three blockers must be judged
against `aa256f6d3`, not against the review's head.** This distinction decides the
whole work-phase, so it is checked first rather than assumed.

## What the contributor did (`aa256f6d3`, +1859/-26)

`src/codex/shim.ts` (+778/-11) adds Unix shim revision 2 with runtime recursion
guards, bounded behavioral probing, detached process-group supervision,
descendant lease markers, fingerprinted fresh-install and refresh journals,
ownership-aware rollback, and obsolete-shim upgrade/removal.
`tests/codex-shim.test.ts` (+1039/-12) covers recursion, timeout, descendants,
dash, native executables, probe errors, partial writes, concurrent updaters,
direct refresh, auto-restore, obsolete upgrade, and rollback. Two adjacent test
files get timeout bumps; five locale lifecycle pages document the probe.

Transaction flow: refuse an existing backup, rename the launcher to
`.opencodex-real`, fingerprint it, write and fingerprint the shim, probe the shim
with `--version` under `OCX_SHIM_BYPASS=1`, supervise a detached `/bin/sh` and
record its process-group id, classify the outcome
(`recursive` / `timeout` / `descendants` / `failed` / `cleanup`), re-fingerprint
the wrapper, commit only on an exact match, otherwise roll back in reverse
journal order. On Unix the wrapper is created as its own inode and renamed into
place, so "ours" means the inode we wrote rather than whatever occupies the path
when we look — see the ownership section below for why that distinction matters.

## The three blockers, all addressed on the current head

**1. P1 probe isolation (`set -m` job control in non-interactive `/bin/sh`).**
Addressed. `src/codex/shim.ts:176-184` now spawns detached and records the group:

```ts
launcher = spawn(launcherShellPath, [wrapperPath, "--version"], {
  detached: true,
  stdio: ["ignore", "ignore", "pipe", "pipe"],
});
writeExclusive(groupPath, String(launcher.pid) + "\n");
```

and 778-788 signals `process.kill(-groupId, "SIGKILL")`, waiting until the group
returns `ESRCH`. That is explicit Unix process-group isolation; the shell
job-control dependency is gone. Regression at
`tests/codex-shim.test.ts:424-455` selects `/bin/dash` explicitly. This machine
has `/bin/dash` (its `/bin/sh` is bash 3.2.57 in sh mode), so the dash path was
reproduced faithfully and passed; the Ubuntu shard passed it too.

**2. P1 post-probe wrapper ownership.** Addressed. Guarded refresh fingerprints
the generated wrapper at 1425-1429, revalidates it after the probe at 1444-1449,
and gates commit on no mismatch at 1452. Rollback at 1349-1374 unlinks only an
exact owned fingerprint; when another launcher occupies the path it preserves
that file and discards the transaction's staged replacement instead of deleting
the updater's newer launcher. Fresh install applies the same design at
1751-1755 and 1787-1794 with ownership-aware rollback at 799-842. Regressions at
`tests/codex-shim.test.ts:829-857` (fresh install preserves the concurrent
launcher, removes the owned backup, writes no state, reports
`installed: false`) and 1331-1353 (guarded restore returns `deferred`, preserves
the concurrent launcher, old backup and exact old state, leaves no
`.autorestore-*`).

**3. Medium probe-infrastructure exceptions bypassing rollback.** Addressed.
Guarded refresh catches probe exceptions at 1436-1441 and routes them through
rollback at 1460-1466; fresh install catches at 1772-1778, rolls back at
1779-1784, then surfaces the error. Probe metadata failures are themselves
converted to the fail-closed `cleanup` classification at 735-756. Regressions at
762-782 and 1279-1302, plus equivalents for direct refresh (1421) and
obsolete upgrade (1172).

## CI red, classified

Run `31467064355` tested merge `6552bebe` against the older base `e2f7f2ba`, not
current `dev`. `test 3/4` reported 2276 pass / 3 skip / 3 fail / 6 errors, with
`tests/codex-shim.test.ts` passing completely on Ubuntu. The three failures are
all the same Bun 1.3.14 Linux `epoll_ctl` `EEXIST` crash followed by
`Cannot call describe()/test() after the test run has completed`, in
`tests/cli-ready.test.ts:25`, `tests/desktop-3p-removal.test.ts:20`, and
`tests/process-control-graceful.test.ts:8`. No `expect()` assertion failed, and
clean `dev` passes those exact files (67 pass / 0 fail). Same family as #1302.

## Landing

No correction commit expected. Merge the contributor's 15 commits preserving
`comfuture` as author. This lands last: it writes and deletes files on the user's
`PATH`, so it goes onto the most-verified tree.

Baseline on the contributor head: `tests/codex-shim.test.ts` 66 pass / 0 fail,
`tests/codex-shim-autorestore.test.ts` 8 pass / 0 fail,
`tests/codex-shim-readiness.test.ts` 6 pass / 0 fail, typecheck PASS.

## Ownership now comes from the write, not from looking at the path

An independent audit (see `004`) showed the original design could adopt a wrapper
it never wrote: `writeShim()` wrote straight to `wrapperPath`, and ownership was
then established by `stat`-ing that path, so a replacement landing between the
write and the fingerprint was indistinguishable from our own file — and rollback
would unlink it.

Fixed on this branch, in two rounds. The Unix wrapper is created as its own file
(hidden name, `wx`, mode 0600) and renamed into place; `writeShim()` returns the
`dev`/`ino` of what it created, and each transaction records that identity before
anything can fail. All three rollback paths — fresh install, guarded refresh,
obsolete upgrade — ask only whether the file at the path is the inode we wrote.

The first attempt fixed only fresh install and still deleted the replacement,
because rollback fell through to a marker-text fallback when ownership was unset.
The markers are public: a concurrent updater's wrapper carries them too, so
"looks like a shim" was never evidence of ownership. Both fallbacks are gone.

Three traps this cost us, recorded so the next person skips them:

- Fingerprinting the staged file before the rename does not work. `rename()`
  preserves `dev`/`ino` but updates `ctime`, and the fingerprint comparison is
  exact — a pre-rename fingerprint fails every install. Capture `dev`/`ino` from
  the staged file, then fingerprint the destination.
- A test that "replaces" the wrapper with `writeFileSync` proves nothing: that
  truncates our own inode in place. A real updater writes a new file and renames
  it over ours.
- Consequently the ownership rule needs both halves. A differing inode is
  conclusively not ours; a matching inode must still match the recorded
  fingerprint, which is what distinguishes our own partial write from a
  stranger's in-place overwrite.

One behavioral change worth calling out: when the source path is occupied by a
file we do not own, the moved-aside backup is now kept instead of deleted. It is
the only remaining copy of the user's real launcher, and a stray
`codex.opencodex-real` is recoverable where a deleted launcher is not.

## Note for the maintainer, outside this unit's scope

The reviewer's blockers were filed against a head the author has already
replaced. Nothing in this unit acts on GitHub, but when the publish decision
comes, that stale-review state is what is holding the PR in draft.
