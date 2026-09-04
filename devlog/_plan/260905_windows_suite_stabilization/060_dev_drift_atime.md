# 060 — wp4: dev moved under the stack — the quorum-cache atime observer on Windows

Research doc. Found by the second confirmation run, which happened to be the first
run after rebasing the stack onto current `dev` (`d6b457462`, 36 commits ahead of
the original base).

## The run

Run 33928082123 (head `dc09663cb`, rebased): windows 1/4, 3/4, 4/4 SUCCESS;
2/4 FAILURE with three new cases:

```
(fail) Anthropic failover quorum cache > removing an account invalidates immediately, not after the TTL
(fail) Anthropic failover quorum cache > a rotation invalidates immediately rather than waiting out the TTL
(fail) Anthropic failover quorum cache > a manual account selection invalidates immediately
      at tests/routing/anthropic-quorum-cache.test.ts:154:28
      expect(storeWasRead()).toBe(true)   Expected: true   Received: false
```

Everything this stack touches passed on the same run: `keep-native-v1` 12/12,
the six `retained-root-serialization` cases, `update-notify` with its skip.

## Provenance

`tests/routing/anthropic-quorum-cache.test.ts` reached `dev` today through
#3523 → #3526 → #3530 → #3533 (merged 21:44Z). None of those commits exist on
the pre-rebase stack, and the run before the rebase (33926041666) was all green.
So this is drift under the stack, not a regression the stack introduced.

## Mechanism, from reading — NOT yet measured

The test observes whether `loadAuthStore` hit the file by pinning `auth.json`'s
**atime** 60 s into the past and checking whether it moved:

```ts
function markStoreUnread(): void {
  utimesSync(storePath(), new Date(Date.now() - 60_000), stats.mtime);
}
function storeWasRead(): boolean {
  return statSync(storePath()).atimeMs > Date.now() - 30_000;
}
```

On Windows, NTFS last-access-time updates are **disabled by default** on
client SKUs since Windows 7 (`NtfsDisableLastAccessUpdate`), and on newer
builds they are "system managed" — updated only when the volume is small or
at most once per hour. A `readFileSync` does not move atime there. So the
three cases that assert "the store WAS read" cannot see the read, while the
cases that assert "was NOT read" pass vacuously on the same platform.

That is a hypothesis with a strong prior (it is a well-known NTFS default)
and it explains the exact split — three "invalidates immediately" cases red,
the "shares one read" and "holds no credential material" cases green. But
this unit has been wrong from reading before (`007`), so it is not a
diagnosis until the atime behaviour is measured on the runner.

## Why it is a separate work-phase

- It is not in this stack's write set and not caused by it.
- The fix belongs to the test's author's design: observing a syscall through
  atime is the thing that does not port, and the replacement (an injected
  reader counter, or a `readFileSync` spy) is a design choice in a file this
  stack has never touched.
- The stack's own acceptance — the three defects it set out to fix — is met on
  every surface. Holding #3548-#3550 hostage to a defect that landed on `dev`
  after they were planned would be the wrong coupling.

## Next

A new work-phase, dependency-ordered after this stack lands or independently
as a fourth PR against `dev`:

1. Measure: on windows-latest, does `readFileSync` move `atimeMs` at all?
   A ten-line probe in a scratch `--eval`.
2. If not: replace the atime observer with a direct one (a counting wrapper
   around the store reader injected for the test), keeping every assertion.
3. `fuck-powershell` case: `ntfs-atime-disabled-by-default` if (1) confirms.

Until then, `c-1` ("0 fail twice consecutively") is met for the stack's own
scope at runs 33926041666 and — for the three files it changes — 33928082123,
but NOT for the suite as a whole, because `dev` now carries a Windows failure
of its own.
