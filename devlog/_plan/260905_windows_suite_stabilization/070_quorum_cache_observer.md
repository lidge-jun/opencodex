# 070 — wp4: the quorum-cache test observes file reads through atime, which NTFS does not update

Implementation phase. Independent of the three landed fixes (disjoint write set:
one test file). Three failures on windows 2/4, present on `dev` since #3533.

## Measured, not read

A scratch step on `windows-latest` (run 33929916059, keyring windows job), the
exact operation the test performs:

```
$ fsutil behavior query DisableLastAccess
DisableLastAccess = 3  (System Managed, Last Access Time Updates DISABLED)

PROBE {"before":1788564769875,"after":1788564769875,"moved":false,"storeWasRead":false}
```

`readFileSync` does not move `atimeMs` on the hosted Windows runner. The
hypothesis in `060` is confirmed on the platform where the failure occurs.

## What the test does

`tests/routing/anthropic-quorum-cache.test.ts:70-77`:

```ts
function markStoreUnread(): void {
  utimesSync(storePath(), new Date(Date.now() - 60_000), stats.mtime);   // pin atime into the past
}
function storeWasRead(): boolean {
  return statSync(storePath()).atimeMs > Date.now() - 30_000;              // did it move?
}
```

Four of the seven cases use this observer (`:87`, `:112`, `:154`, `:166`). The three that assert `storeWasRead() === true`
("rotation / removal / manual selection invalidate immediately") fail on
Windows because the read leaves atime where `utimesSync` put it. The one that
asserts `false` ("a burst shares one read") passes there **vacuously** — it
would pass even if the cache were broken and read the file 25 times, which is
the worse of the two outcomes: a green test that cannot fail.

The comment on the observer says why it was chosen: "without stubbing the
module … a direct observation of the syscall this cache exists to avoid." That
is a good instinct on POSIX. On NTFS the syscall leaves no trace to observe.

## Fix: observe the syscall with a path-filtered spy — no `src/` change

An earlier draft added a guarded read counter to `src/oauth/store.ts`. The audit
rejected it, correctly: the guard only stops production from READING the
counter, the increment itself still executes on every production store read,
and that is process-global test instrumentation inside a credential module.
The repository already observes filesystem calls from tests without touching
`src/` — `tests/claude-integration/claude-system-env-auto.test.ts:76` spies on
`node:fs` `readFileSync`. The same instrument, filtered to the one path that
matters, is the observation the atime trick was reaching for.

What the spy has to see: `hasAnthropicFailoverQuorum` → `getAccountSet` →
`loadAuthStoreInternal` → `readFileSync(auth.json)` (`src/oauth/store.ts:344`).
The refresh-intent reads at `:166`/`:177`, the lock snapshot at `:404` and
`peekAuthStore` at `:383` are other files or other callers and never satisfy
this cache, so the filter must be the exact `auth.json` path — not "any read".

### MODIFY `tests/routing/anthropic-quorum-cache.test.ts` (the only file)

```ts
-import { afterEach, beforeEach, describe, expect, test } from "bun:test";
-import { mkdtempSync, statSync, utimesSync } from "node:fs";
+import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
+import * as fs from "node:fs";
+import { mkdtempSync } from "node:fs";

 const originalHome = process.env.OPENCODEX_HOME;
 let home: string;
+let readSpy: ReturnType<typeof spyOn> | undefined;
+let authReadsBefore = 0;

+/**
+ * Count readFileSync calls against THIS home's auth.json. The previous observer pinned
+ * atime and checked whether readFileSync moved it; on windows-latest NTFS last-access
+ * updates are disabled (fsutil DisableLastAccess = 3, measured in run 33929916059), so
+ * the read left atime untouched, the three "invalidates immediately" cases could never
+ * see the read they assert on, and the "shares one read" case passed vacuously. The
+ * spy observes the same syscall where the platform cannot hide it.
+ */
+function authReadCount(): number {
+  const target = join(home, "auth.json");
+  return (readSpy?.mock.calls ?? []).filter(([p]) => String(p) === target).length;
+}

 beforeEach(() => {
   home = mkdtempSync(join(tmpdir(), "ocx-quorum-cache-"));
   process.env.OPENCODEX_HOME = home;
+  readSpy = spyOn(fs, "readFileSync");   // pass-through: no mockImplementation
   clearAnthropicAccountPoolState();
   forgetAnthropicFailoverQuorum();
 });

 afterEach(() => {
+  readSpy?.mockRestore();
+  readSpy = undefined;
   clearAnthropicAccountPoolState();
   …
 });

-function storePath() … markStoreUnread() … storeWasRead()   // atime versions, deleted
+function markStoreUnread(): void { authReadsBefore = authReadCount(); }
+function storeWasRead(): boolean { return authReadCount() > authReadsBefore; }
```

Every call site of `markStoreUnread` / `storeWasRead` is unchanged; only the
helpers' bodies move. `spyOn` without `mockImplementation` records calls and
passes through to the real `readFileSync`, so the store behaves exactly as in
production.

The spy is installed AFTER `mkdtempSync` (which does not read) and restored in
`afterEach` before the sandbox is removed, matching the claude-system-env
pattern.

## The "one read" oracle, stated precisely

The burst case's name says "shares one store read", but a cache FILL is not one
read: `hasAnthropicFailoverQuorum` calls `getAccountSet` (one `auth.json` read)
and then `isPoolCredentialUsable` → `getAccountCredential` for up to two
accounts (`src/oauth/anthropic-routing.ts:222,294,300`) — each of which goes
through `loadAuthStore` again. So a fill is one-to-three reads.

What the case actually proves — and what `markStoreUnread` AFTER the prime
call measures — is **zero additional reads while the cache is warm**. That is
the property that matters (the cache exists to keep reads off the request
path), it is exactly what the original atime version was asserting, and it is
what the spy version asserts. The case name is kept; a one-line comment in the
test says "zero reads during hits, not one read per fill", so nobody later
tightens it to `=== 1` and discovers the fill count the hard way.

Refactoring the fill to a single read is a product change outside this
unit's scope and is not needed to make the observation honest.

### MODIFY `tests/routing/anthropic-quorum-cache.test.ts`

```ts
-import { mkdtempSync, statSync, utimesSync } from "node:fs";
+import { mkdtempSync } from "node:fs";
-import { getAccountSet, markAccountNeedsReauth, saveCredential } from "../../src/oauth/store";
+import { authStoreReadCountForTestsOnly, getAccountSet, markAccountNeedsReauth, saveCredential } from "../../src/oauth/store";

-/** Observe the store read without stubbing the module: … atime … */
-function storePath(): string { … }
-function markStoreUnread(): void { … }
-function storeWasRead(): boolean { … }
+/**
+ * Observe the store read at the store's own seam. An earlier version pinned atime and
+ * checked whether it moved; NTFS on windows-latest has last-access updates disabled
+ * (fsutil DisableLastAccess = 3), so readFileSync left atime untouched and the three
+ * "invalidates immediately" cases could never see the read they assert on — while the
+ * "shares one read" case passed vacuously. Counting loadAuthStoreInternal is the same
+ * observation, made where the platform cannot hide it.
+ */
+let readsBefore = 0;
+function markStoreUnread(): void { readsBefore = authStoreReadCountForTestsOnly(); }
+function storeWasRead(): boolean { return authStoreReadCountForTestsOnly() > readsBefore; }
```

Every call site of `markStoreUnread` / `storeWasRead` is unchanged; only the
two helpers' bodies move. The six assertions keep their exact shape.

### Why the path filter is not the fragile part

The earlier draft worried that a filesystem spy "sees every read and has to
filter by path". It does — and the path is `join(home, "auth.json")`, the same
expression the test already used for `storePath()`. An exact-string match on a
path this test itself created is not fragile; it is the most specific
observation available, and it needs no seam in `src/`.

## Acceptance

1. **Ablation first, on macOS**: temporarily disable the cache-hit return at
   `src/oauth/anthropic-routing.ts:291` (make the `if` condition `false`). The
   burst case must go red on `storeWasRead() === false` — proving the spy sees
   the reads atime could not. Reverted before commit; `git diff --stat` shows
   only the test file.
2. macOS: `bun test tests/routing/anthropic-quorum-cache.test.ts` 7/7.
3. `bun run typecheck` clean. No `src/` change, so `privacy:scan` is untouched.
4. CI dispatch on the stacked head: windows 2/4 SUCCESS, the three cases
   green in the log.

## Stack position

PR 4 on top of #3550, against `codex/win-3-k-owner-budget`. One test file; no
product source touched, which keeps this unit's record intact.

## Corpus

New `fuck-powershell` case `ntfs-atime-disabled-by-default` with the
`fsutil` output and the probe as its repro.
