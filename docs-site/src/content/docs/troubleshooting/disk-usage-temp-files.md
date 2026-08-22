---
title: Disk Usage from Temp Files
description: What responses-state.json.ocx.*.tmp files are, why they could accumulate, and how to reclaim them.
---

Some users found many gigabytes of files named like
`responses-state.json.ocx.<pid>.<seq>.tmp` in their opencodex home
(`~/.opencodex` by default), growing after every reboot.

## What these files are

opencodex keeps a continuation cache so `previous_response_id` chains survive a
proxy restart. It writes that snapshot atomically: content goes to a temp file
first, then replaces the real file in one step. That is what stops a crash
mid-write from leaving a half-written snapshot.

The temp is normally removed the instant the swap completes. If the process dies
between the two steps, the temp survives.

Each file can be up to 24 MB because the snapshot is rewritten whole, not
appended to. A few hundred abandoned files therefore add up quickly.

**They are cache, not durable state.** Deleting them costs nothing except that
in-flight conversation chains may re-send context once. No configuration,
credentials, or history live in these files.

## Why they could accumulate

A cleanup already existed, but it ran at one moment only: when a proxy loaded
the continuation cache for the first time, which happens *before* that process
writes anything. Two consequences followed.

A proxy that crashed and restarted swept too early to see the temp its
predecessor had just left — there is a 15-minute grace period so a file being
written right now is never touched — and it never looked again for the rest of
its life. Each restart then added one more file.

Worse, the cleanup skipped any file whose owning process ID was still alive.
After a reboot the operating system routinely reissues the same process IDs, so
an old file could be permanently mistaken for one belonging to a running
process. That is why the growth tracked reboots.

## What opencodex does now

The cleanup repeats on the proxy's normal background timer instead of running
once at startup, so a running proxy reclaims abandoned files on its own. It also
ignores the process-ID check for files older than the current boot, since no
running process can own those.

The safety rules are unchanged: a file younger than 15 minutes is never removed,
and the proxy never removes a file it is writing itself.

## Reclaiming files that already accumulated

If the proxy runs, this happens automatically within a minute or two.

If the proxy will **not** start — the case where the pile grows fastest — check
and reclaim from the command line:

```bash
ocx doctor
```

The "Response-state temp files" section reports how many files are reclaimable
and how much space they hold. It only reports; it changes nothing.

To actually remove them:

```bash
ocx doctor --reclaim-response-temps
```

Both commands work without a running proxy. Files currently locked by another
process are reported rather than forced. They are retried on the next reclaim —
automatically while the proxy is running, otherwise the next time you run this
command.

If a very large backlog exceeds one pass, the command says how many files remain
so you can run it again.

This covers response-state snapshot temps specifically. Other components write
their own temp files with a similar name, and those are not touched here.
