> **RETRACTED — see 007_acl_defect_retracted.md.** The defect described here does
> not exist. The icacls runners are never invoked by this fixture (measured: 0
> invocations with both runners stubbed), and the 22 failures came from a Windows
> handle held by a process I killed. Kept as the record of a diagnosis that matched
> a corpus case exactly and was still wrong.

# 040 — Follow-up: make the half-installed ACL seam unrepresentable

Implementation phase, split out of `010` because it is a mechanical migration of
18 files and does not belong in the same review as a 22-failure bug fix.

Depends on `010` — it enforces adoption of the helper `010` introduces. This is
a real dependency, unlike the independence of `010`/`020`/`030`.

## Why the rule exists

`010` fixes one fixture. Nothing stops the eleventh one from stubbing the sync
runner alone and rediscovering the same 2.5-second EPERM. Two earlier attempts at
a guard both failed, in instructive ways:

1. *"Every file with a sync setter must also have an async setter."* False-passes
   (one paired call anywhere in a file hides an unpaired one) and false-fails
   legitimate sync-only ACL tests.
2. *"Skip files that do not stub the async runner."* Exactly inverted: measured,
   it skipped all 9 sync-only files — the defect population, including
   `oauth-store-multi` — and flagged the 13 already-correct ones.

Both grepped a proxy that felt like the property. The rule below measures the
property: a fixture that stubs the ACL runners at all must take them from the
helper, so the flush-before-restore ordering cannot be skipped.

## MODIFY `tests/repo-hygiene.test.ts`

```ts
test("an ACL-stubbing fixture installs both runners through the atomic helper", async () => {
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

Measured before being written down — 18 offenders, and `oauth-store-multi` among
them, so the guard is red on the defect it prevents.

## Migration

17 files after `010` lands (`oauth-store-multi` migrates there):

```
codex-account-store          codex-auth-api               codex-auth-context
codex-prompt-journal         google-antigravity-replay    google-signature-history-roundtrip
oauth-account-id-collision   oauth-manual-code            oauth-public-surface
oauth-reauth-bind            oauth-status-privacy         openai-provider-option-e2e
openai-provider-option-startup  responses-state           server-management-auth
service                      thought-signature-credential-scope
```

Each replaces its paired `setIcaclsRunnerForTests` / `setAsyncIcaclsRunnerForTests`
calls with `installWindowsSecretAclStubs(...)` and awaits `restore()` before its
home teardown. Files passing custom runners keep them: the helper takes
`{ sync?, async? }`.

`tests/responses-state.test.ts` is the hard one — 12 sync and 18 async sites,
several with bespoke gating runners — and if it does not migrate cleanly it gets
an exemption with a written reason rather than a forced rewrite.

## The exemption list is provisional

The four entries above were classified from their call sites and an auditor's
inventory, not from reading each test's intent end to end. **Each is re-read at
implementation time**; an entry that turns out to start a config-directory
flight loses its exemption and migrates instead.

## Acceptance

1. The rule is added FIRST and observed failing with 17 offenders. A guard never
   seen red is not known to be a guard.
2. After migration: 0 offenders, and `bun test tests/repo-hygiene.test.ts` green.
3. Every migrated file still passes on macOS, and the Windows shards stay at 0.
4. `bun run typecheck` clean.
5. Every exemption carries a one-line reason in the map — a bare path is not an
   exemption.
