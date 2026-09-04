# 008 — Residual: one OAuth-lease case still loses a teardown race

Found by confirmation run 1, on a clean tree, after the two fixes landed.

## What happened

Shard 2 of the confirmation run: **4627 pass / 16 skip / 1 fail**, down from 22.
The survivor is the LAST test in the file:

```
error: EPERM: operation not permitted, rm 'C:\ocxwin\repo\tests\.tmp-oauth-store-multi-test'
      at removeTreeWithRetry (tests/helpers/remove-tree.ts:28:83)
      at tests/oauth-store-multi.test.ts:61          (afterEach)
(fail) multi-account auth store > OAuth 30 second wait timeout releases an
       unstarted lease and never enters the chain [2641.81ms]
```

The 21 cases before it pass. That distribution is the finding: this is not the
directory being unusable — it is one specific test leaving something behind.

## Why this is NOT the retracted defect

`007` retracted a 22-failure "ACL seam" diagnosis because the failures were
contamination and `icacls` was never invoked. This one is different on every
axis that matters:

| | retracted (`007`) | this |
|---|---|---|
| failures | all 22, from the first `beforeEach` | 1, the last case only |
| tree state | debris from a killed 1.3.14 run | clean, verified before the run |
| reproduces alone | no — 22 pass in 1.4s | not yet established |

So the ACL analysis stays retracted. What this shows is that removing the
contamination exposed a smaller, real race that the 22 failures had been masking.

## Hypothesis, explicitly unproven

`tests/oauth-store-multi.test.ts:372` drives the OAuth mutation queue: a blocking
mutation holds a lease while a second one is rejected by a `waitMs` timeout. Its
`finally` releases the blocker and awaits both promises
(`allSettled([blocker, timedOut])`), so the JS side settles — but the store's own
lock file (`getAuthStoreLockPath()`, `src/oauth/store.ts:61`) and any fd behind it
are not obviously drained by that await. If a handle survives the test body, the
`afterEach` delete races it, and `removeTreeWithRetry` spends 50×50ms before
rethrowing — consistent with the 2641ms duration.

**That is a hypothesis built from reading, and the last time I did that in this
unit I was wrong** (`007`). It is not a plan until it is measured.

## Measurement 1: it does not reproduce alone

Box idle, suite lock held, pinned runtime, five consecutive runs of the file:

```
run1 exit=0 fails=0
run2 exit=0 fails=0
run3 exit=0 fails=0
run4 exit=0 fails=0
run5 exit=0 fails=0
```

0/5. So the hypothesis above — "this test leaves its own lock behind" — is not
supported: if the test's own teardown were the whole story it would fail alone
too. Whatever holds the directory needs the rest of the shard to be present.

That also means it cannot be fixed by reading the file. The remaining candidates
are load-dependent: another file in the shard touching the same fixture path,
a slower release under 265-file memory pressure that outlasts 50×50ms, or an
external scanner reacting to churn the solo run does not produce.

Note that after the confirmation run the directory was left behind again and
deleted cleanly by hand — so nothing holds it once the suite exits. The window
is inside the run.

## Measurement 2: deterministic within the shard

Shard 2 re-run alone, box idle, lock held:

```
 4627 pass · 16 skip · 1 fail · [1034.21s]
 (fail) multi-account auth store > OAuth 30 second wait timeout releases an
        unstarted lease and never enters the chain
```

Byte-identical outcome to the confirmation run. So:

| context | result |
|---|---|
| the file alone, ×5 | 0 fail |
| the whole shard, ×2 | 1 fail, the same case both times |

Deterministic given the shard, absent without it. Not a flake, and not the test's
own teardown in isolation.

## Measurement 3: it is not a path collision

`rg -l 'tmp-oauth-store-multi-test' tests/` returns exactly one file — the test
itself. No sibling in shard 2 writes that directory, so a second writer is ruled
out. What the shard supplies is load and preceding state, not a competing path.

The three files immediately before it in shard order are
`oauth-login-cli-live-update`, `oauth-open-browser-choice` and
`oauth-refresh-generic-lock` — all OAuth-store adjacent, and the last one drives
refresh locks. That is a lead, not a conclusion.

## Measurement 4: a two-file repro

Bisecting the shard found the minimal pair, which cuts the cycle from 17 minutes
to two:

```
bun.exe test --isolate tests/oauth-refresh-generic-lock.test.ts \
                       tests/oauth-store-multi.test.ts
  → 22 fail   (the SAME 22 the contamination used to produce)
```

On macOS the identical pair is 28 pass / 0 fail, so it is Windows-specific.

Note what this changes about the confirmation run: shard 2 showed only ONE
failure because the shard's file ordering put something between the two that
broke the interaction. The pair is the honest reproduction.

## Measurement 5: the directory is not locked

A preload `afterEach` that inspects the fixture directory before the test's own
teardown:

```
 1 ["auth.json"] -> unlink OK
 5 []            -> unlink OK
```

The file deletes cleanly and the directory is left empty. So no handle is held on
`auth.json`, which kills the "something still owns the file" family of
hypotheses — including the one `008` opened with.

Then the decisive one. The same preload, but calling `rmdirSync` on the now-empty
directory before the test's `removeTreeWithRetry` runs:

```
FAILS=0     (from 22)
28 readdir failed: ENOENT ... procs=13
```

**Removing the directory with `rmdirSync` succeeds every time, and the whole
failure disappears.** The directory is not locked by anything. What fails is
`rmSync(path, { recursive: true, force: true })` — the default remover inside
`removeTreeWithRetry` (`tests/helpers/remove-tree.ts:17`) — on this Windows host,
against a directory a plain `rmdirSync` deletes.

## Measurement 6: `rmSync` is not broken, and the repro is load-dependent

Both follow-up questions were answered, and both answers were negative.

A standalone probe on the box exercising the exact removal shapes:

```
empty-rmSync:            OK
empty-rmdir:             OK
file-rmSync:             OK
file-unlink-then-rmdir:  OK
```

So `rmSync(recursive)` is fine here in isolation — measurement 5's conclusion
("the removal call is the cause") was too strong.

Then the pair itself, on a now-idle box:

| run | fails | wall |
|---|---|---|
| bare ×3 | 0 | 5.4-5.6s |
| with the leftover directory pre-created | 0 | 5.5s |
| bare ×5 more | 0 | 5.5-5.8s |

**8 consecutive clean runs.** Meanwhile every run that DID fail took ~119s —
22× longer — and its slowest cases were all ~5.2s, which is exactly
`removeTreeWithRetry`'s 50 × 50 ms budget plus overhead. So in the failing runs
something really did hold the directory for the full retry window; in the passing
runs nothing does.

What separates them is not the code. Every failing reproduction ran while the box
was busy — during or immediately after a full shard, or while my own
(lock-blocked) probe workers were alive. The passing ones ran on an idle machine.

## Status: NOT diagnosed

Honest summary of what is known:

- Real: it happened twice in full shard-2 runs, deterministically, and 22×
  in the two-file pair while the box was loaded.
- Not the file alone (0/5 solo), not a path collision (single writer), not the
  retracted ACL mechanism (0 runner invocations), not `rmSync` itself
  (isolated probe passes), not the leftover directory (pre-creating it passes).
- The failing signature is a genuine 2.5s+ hold on the directory, seen only under
  load.

That is a load-dependent Windows filesystem hold whose owner has still not been
identified — the same gap `007` had, and I have not closed it here either. The
one measurement that would close it is a handle-owner snapshot taken WHILE the
failure is happening (`handle.exe` / `openfiles` from a second shell during a
loaded run), which requires reproducing under load on purpose.

## Recommendation

Do not patch this now. It is one case out of 17807, it does not reproduce on an
idle machine, and the two previous attempts to name its cause from reading were
both wrong. The defensible next step is the handle-owner snapshot under load; the
defensible interim position is to report the suite as **1 failure remaining,
cause unidentified**, rather than to ship a speculative teardown change to a
helper the whole suite shares.

## Measurement 7: the handle-owner snapshot, and why it failed

I tried the snapshot anyway: a background watcher polling once a second for the
fixture directory and, when present, listing candidate processes through
`powershell.exe`, while shard 2 ran as the load.

It destroyed the experiment. Five minutes in, the shard had **72 failures across
ten unrelated suites** — `Codex catalog sync hardening` (25),
`020 coverage completions` (17), `ocx models` (7), and others that have never
failed in any run of this unit. The watcher's own per-second `powershell.exe`
spawns were the new load, and child-process-spawning tests started failing on
`r.status`. The watcher never captured a single sample: the directory exists for
milliseconds at a time, so a 1 Hz poll missed every window, and `watch.log` was
empty when I killed it.

So the run is discarded — it measured my instrument, not the defect. Worse, it is
the same class of mistake as `007`: I added a process to the box and then read
the resulting failures as if they were properties of the code.

What this does establish, accidentally but usefully: **these Windows failures are
load-sensitive across the board.** Adding one poll-per-second process was enough
to break 72 cases in ten suites. That is context for the 1 remaining failure —
and a warning that any future "flaky on Windows" claim from this box needs the
box's own load accounted for.

A correct snapshot needs an instrument that does not compete: an ETW/Sysmon trace
or a `handle.exe` invocation triggered by the failing `afterEach` itself, not a
polling loop. That is a real piece of work and it is not justified by one failing
case out of 17807.

## Final position for this cycle

**1 failure remaining, cause unidentified, no fix attempted.** The two defects
this unit set out to fix are fixed and verified. This one is documented to the
limit of what was measured, including the two dead ends and the instrument that
contaminated its own experiment.

## Process note

While diagnosing this I started a repeat-run loop on the box **while the
confirmation run still held `/c/ocxwin/.suite.lock`** — the exact parallel
execution this unit is required to avoid. It did no damage (the repo's own
test-run lock blocked my workers: *"bare Bun worker 8876 is waiting for test run
pid 424"*), and the shard-2 failure timestamp precedes my first probe, so the
result stands. The workers were killed and only the confirmation run left
running. Recorded because the guard that saved it was the repository's, not mine.
