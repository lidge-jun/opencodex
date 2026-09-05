> **RETRACTED — see 007_acl_defect_retracted.md.** The defect described here does
> not exist. The icacls runners are never invoked by this fixture (measured: 0
> invocations with both runners stubbed), and the 22 failures came from a Windows
> handle held by a process I killed. Kept as the record of a diagnosis that matched
> a corpus case exactly and was still wrong.

# 010 — Defect 2: the ACL stub seam can be installed half-way

Implementation phase. Independent of `020` and `030` — no shared file, no
shared API. 22 of the 25 failures.

## Failure

```
error: EPERM: operation not permitted, rm 'C:\ocxwin\repo\tests\.tmp-oauth-store-multi-test'
      at removeTreeWithRetry (tests/helpers/remove-tree.ts:28:83)
      at tests/oauth-store-multi.test.ts:44 (beforeEach) / :61 (afterEach)
(fail) multi-account auth store > … [5274.25ms]
```

Evidence: `.tmp/win/v140-2.log` (gitignored), 22 cases, all this signature.

## Reachability, verified rather than assumed

`getCredential()` / `saveCredential()` → `loadAuthStoreInternal()`
(`src/oauth/store.ts:338`) or `persist()` → `hardenConfigDir()`
(`src/config/paths.ts:31`) → fire-and-forget `hardenSecretDirAsync()` →
`asyncIcaclsRunner` (`src/lib/windows-secret-acl.ts:373`). `store.ts` calls
`hardenConfigDir` at seven sites. The fixture creates the directory before
exercising this, so the harden is not short-circuited by the `existsSync` guard
at `paths.ts:35`.

`tests/oauth-store-multi.test.ts:48` stubs `setIcaclsRunnerForTests` and there is
no `setAsyncIcaclsRunnerForTests` and no `flushConfigDirHardeningForTests` in the
file. So the async runner is the real one.

## What is NOT yet proven

That the `icacls.exe` child is the specific handle causing each EPERM. The code
path is proven reachable; the holder is inferred. The 5.2s case duration is
consistent with 50×50ms of retries plus work, and `removeTreeWithRetry` only
retries `EPERM`/`EBUSY`/`ENOTEMPTY`, but neither fact identifies the handle.

**Therefore this phase's first step is a Windows red/green A/B**, before any
committed change:

1. Instrument a scratch copy to log each `asyncIcaclsRunner` invocation with its
   target path. Confirm it fires for `.tmp-oauth-store-multi-test`.
2. Confirm the failure reproduces (red).
3. Apply dual stubbing + flight flush in the scratch copy. Confirm green.
4. Revert one of the two (stub only / flush only) and confirm it is still red,
   so the fix is not over-determined.

If step 1 shows no invocation for that path, this analysis is wrong and the
phase restarts from the log rather than from the patch.

## Why pairing the setters is not sufficient

Teardown that restores the real runner while a flight is still awaiting
principal resolution hands the continuation the real `icacls.exe`. Ordering is
part of the contract, not an implementation detail.

## NEW `tests/helpers/windows-secret-acl-stubs.ts`

`IcaclsRunner` and `AsyncIcaclsRunner` are NOT exported
(`src/lib/windows-secret-acl.ts:285-286`), so the helper derives its parameter
types from the setters rather than importing names that do not exist:

```ts
import {
  resetHardenedStateForTests,
  setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests,
} from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";

type SyncRunner = NonNullable<Parameters<typeof setIcaclsRunnerForTests>[0]>;
type AsyncRunner = NonNullable<Parameters<typeof setAsyncIcaclsRunnerForTests>[0]>;

/** Same shape the already-correct fixtures use (tests/codex-account-store.test.ts:18). */
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" } as const;

export function installWindowsSecretAclStubs(
  runners: { sync?: SyncRunner; async?: AsyncRunner } = {},
): { restore(): Promise<void> } {
  setIcaclsRunnerForTests(runners.sync ?? (() => ICACLS_OK));
  setAsyncIcaclsRunnerForTests(runners.async ?? (async () => ICACLS_OK));
  let restored = false;
  return {
    async restore() {
      if (restored) return;                      // idempotent
      restored = true;
      await flushConfigDirHardeningForTests();   // 1. settle WHILE stubbed
      setIcaclsRunnerForTests(null);             // 2. restore both
      setAsyncIcaclsRunnerForTests(null);
      resetHardenedStateForTests();              // 3. clear memo
    },                                           // 4. only now may the caller
  };                                             //    delete its temp home
}
```

`resetHardenedStateForTests` is exported at `src/lib/windows-secret-acl.ts:415`.

The helper lives in `tests/helpers/`, not in `src/lib/windows-secret-acl.ts`:
`src/config/paths.ts` already imports the ACL module, so having the ACL module
import the flight flusher inverts the dependency.

## MODIFY `tests/oauth-store-multi.test.ts`

`beforeEach` calls `installWindowsSecretAclStubs()`; `afterEach` awaits
`restore()` BEFORE restoring `OPENCODEX_HOME` and before the final
`removeTreeWithRetry`. The `afterEach` becomes `async`.

## Migration scope — narrowed by the audit

The earlier claim of "nine loaded guns" was wrong at call-site level. Several of
those files stub the sync runner deliberately, to test synchronous
`hardenSecretPath` directly, and never start an async config harden:
`tests/config.test.ts:2797`, `tests/lab-public-security-regressions.test.ts:145`,
`tests/windows-tray.test.ts:61`. Forcing an async stub there would add noise, not
safety.

Migration is therefore limited to fixture-lifecycle sites that actually reach
`hardenConfigDir`. `oauth-store-multi` is confirmed. Each other candidate must
show a reaching call path before it is migrated; a file that only exercises the
sync API keeps the individual setter.

## Hygiene rule — replaced

The proposed file-level "every sync setter needs an async setter somewhere in the
file" grep is deleted. It false-passes (one paired call anywhere in a file hides
an unpaired one, which is exactly `tests/windows-secret-acl.test.ts`) and it
false-fails legitimate synchronous unit tests.

### The rule that was proposed here first, and why it was wrong

The previous draft skipped any file that does not mention
`setAsyncIcaclsRunnerForTests`, on the theory that stubbing the async runner
marks a fixture that can start a flight. **It is exactly inverted**, and running
it proved so:

```
BOTH (sync + async): 13 files
SYNC-ONLY:            9 files — including tests/oauth-store-multi.test.ts
```

The rule would have skipped all nine sync-only files — the defect population,
containing the very file whose 22 failures started this phase — and flagged the
13 already-correct ones. It fails RED on the wrong set and green on the bug.

Recorded rather than quietly replaced: the earlier deleted rule and this one
failed the same way, by grepping for a proxy that felt like the property instead
of measuring the property.

### MODIFY `tests/repo-hygiene.test.ts`

The population is "every fixture that stubs the ACL runners at all", and the
exception set is audited by hand, once, with a reason per entry:

```ts
test("an ACL-stubbing fixture installs both runners through the atomic helper", async () => {
  // Any file that stubs the ACL runners for FIXTURE ISOLATION must take both
  // through installWindowsSecretAclStubs, so the flush-before-restore ordering
  // cannot be skipped. Files that drive the setters as their SUBJECT are listed
  // below with the reason each is exempt.
  const EXEMPT = new Map([
    ["tests/windows-secret-acl.test.ts",
      "drives the runners directly; they are the unit under test"],
    ["tests/config.test.ts",
      "injects failing/timing-out sync runners to assert ACL error classification"],
    ["tests/lab-public-security-regressions.test.ts",
      "asserts synchronous hardenSecretPath refusals; starts no config-dir flight"],
    ["tests/windows-tray.test.ts",
      "asserts synchronous tray-directory hardening only"],
  ]);
  const offenders: string[] = [];
  for (const file of await Array.fromAsync(new Bun.Glob("tests/**/*.test.ts").scan())) {
    if (EXEMPT.has(file)) continue;
    const source = await Bun.file(file).text();
    const stubs = source.includes("setIcaclsRunnerForTests")
      || source.includes("setAsyncIcaclsRunnerForTests");
    if (!stubs) continue;
    if (!source.includes("installWindowsSecretAclStubs")) offenders.push(file);
  }
  expect(offenders.sort()).toEqual([]);
});
```

### Measured, not asserted

The scan above was RUN before being written down. Result:

```
offenders: 18
oauth-store-multi RED? true
```

It fails on the bug it exists to prevent, which is the property both earlier
drafts lacked.

### The cost, and how this phase pays it

18 files. That is a mechanical migration far larger than the defect, and folding
it into this phase would produce a PR nobody can review against a 22-failure fix.

**So the rule does NOT ship in this phase.** It splits:

| phase | contents |
|---|---|
| `010` (this one) | the helper + `tests/oauth-store-multi.test.ts` — the fix for the 22 failures |
| `040` (follow-up) | the hygiene rule + the 17 remaining migrations, as its own reviewable unit |

The write set for `010` is therefore back to two files:

| file | change |
|---|---|
| `tests/helpers/windows-secret-acl-stubs.ts` | NEW |
| `tests/oauth-store-multi.test.ts` | MODIFY — adopt the helper, async `afterEach` |

which is what `002` recorded, so that contradiction is gone too.

The alternative — shipping a rule that is green on `oauth-store-multi` so the
diff stays small — is what both previous drafts did, in different ways. A guard
that passes on the defect is worse than no guard, because it is claimed as
enforcement afterwards.

The 18-file list and the provisional four-entry exemption set move to `040`,
where each exemption is re-read at implementation time rather than inherited from
this classification.

### Write set for this phase

| file | change |
|---|---|
| `tests/helpers/windows-secret-acl-stubs.ts` | NEW |
| `tests/oauth-store-multi.test.ts` | MODIFY — adopt the helper, async `afterEach` |
| `tests/repo-hygiene.test.ts` | MODIFY — add the assertion above |
| further fixtures | MODIFY only if the red rule names them |

`002` records the two-file write set from before this rule existed; this table
supersedes it for phase `010`.

## Acceptance

1. The A/B above: red before, green after, and still red with either half alone.
2. `tests/oauth-store-multi.test.ts` green on Windows with the pinned runtime;
   per-case duration back under a second (5.2s today).
3. `bun test tests/oauth-store-multi.test.ts` still 22 pass on macOS.
4. `bun run typecheck` clean.
