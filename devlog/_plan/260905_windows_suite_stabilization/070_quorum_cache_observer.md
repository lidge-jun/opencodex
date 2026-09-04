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

Six cases use this observer. The three that assert `storeWasRead() === true`
("rotation / removal / manual selection invalidate immediately") fail on
Windows because the read leaves atime where `utimesSync` put it. The one that
asserts `false` ("a burst shares one read") passes there **vacuously** — it
would pass even if the cache were broken and read the file 25 times, which is
the worse of the two outcomes: a green test that cannot fail.

The comment on the observer says why it was chosen: "without stubbing the
module … a direct observation of the syscall this cache exists to avoid." That
is a good instinct on POSIX. On NTFS the syscall leaves no trace to observe.

## Fix: observe the read at the store's seam, not the filesystem's

`loadAuthStoreInternal` (`src/oauth/store.ts:338`) is the single function every
store read goes through, and it is the exact thing the cache exists to avoid
calling. Count it.

### MODIFY `src/oauth/store.ts`

```ts
+/** @internal Test-only: how many times the auth store file has been read this process. */
+let authStoreReadCountForTests = 0;
+export function authStoreReadCountForTestsOnly(): number {
+  if (process.env.OCX_TEST_HOME_GUARD !== "1") {
+    throw new Error("auth store read counter is available only under the repository test preload");
+  }
+  return authStoreReadCountForTests;
+}

 function loadAuthStoreInternal(): { store: AuthStore; hadLegacy: boolean } {
   const path = getAuthStorePath();
   hardenConfigDir();
   hardenExistingSecret(path);
   if (!existsSync(path)) return { store: {}, hadLegacy: false };
+  authStoreReadCountForTests += 1;
   try {
     return normalizeAuthStore(JSON.parse(readFileSync(path, "utf-8")));
```

The increment sits immediately before `readFileSync`, so it counts exactly the
syscall the atime observer was trying to see. The guard follows the pattern the
repository already uses for test-only seams (`reset-credit-operation-ledger.ts:488`,
`reset-credit-recovery.ts:638`): it cannot be reached from production because
only the test preload sets `OCX_TEST_HOME_GUARD`.

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

### Why not spy on `readFileSync`

A module-level spy on `node:fs` sees every read in the process — config, lock
files, hardening probes — and the test would have to filter by path, which is
the fragile part. The counter sits on the one function whose call count IS the
property under test.

## Acceptance

1. **Ablation first, on macOS**: temporarily make `hasAnthropicFailoverQuorum`
   skip its cache (return `computeQuorum()` unconditionally). The "burst shares
   one read" case must go red on `storeWasRead() === false` — proving the
   counter observes what atime could not. Reverted before commit.
2. macOS: `bun test tests/routing/anthropic-quorum-cache.test.ts` 7/7.
3. `bun run typecheck` clean; `bun run privacy:scan` unchanged (the counter
   holds a number, never content).
4. CI dispatch on the stacked head: windows 2/4 SUCCESS, the three cases
   green in the log.

## Stack position

PR 4 on top of #3550, against `codex/win-3-k-owner-budget`. Touches one
`src/` file for a guarded test seam — the first product-side edit in this unit,
and the guard is what keeps it out of any production path.

## Corpus

New `fuck-powershell` case `ntfs-atime-disabled-by-default` with the
`fsutil` output and the probe as its repro.
