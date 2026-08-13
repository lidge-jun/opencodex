# 050 — wp5: #1449 / #1452, ARM64 ACL identity lookup

## The defect (#1449)

On a QEMU ARM64 Windows VM, `ocx start` reports
`ACL hardening failed (EACLIDENTITY) — the effective Windows account SID could
not be resolved`. The bundled Bun Windows-arm64 binary ships without `bun:ffi`
(TinyCC has no aarch64 support), so the FFI path used to resolve the system
directory is unavailable and the effective SID cannot be found.

## What the contributor did (`47271935f`)

`src/lib/windows-user-principal.ts`: adds a fixed
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` ARM64 fallback with
a dependency-injected resolver seam, and routes SID lookup through it.

## Blocker (reviewer, trust boundary): the fallback is a catch-all

`src/lib/windows-user-principal.ts:64-77`:

```ts
try {
  return resolution.resolveTrusted();
} catch (error) {
  if (
    resolution.platform !== "win32" ||
    resolution.arch !== "arm64" ||
    !resolution.pathExists(DEFAULT_WINDOWS_ARM64_POWERSHELL)
  ) {
    throw error;
  }
  return DEFAULT_WINDOWS_ARM64_POWERSHELL;
}
```

On ARM64 this substitutes a hard-coded System32 path for *any* trusted-resolution
failure whenever that file happens to exist: `GetSystemDirectoryW` call failure,
a non-default Windows root, missing trusted PowerShell, containment or integrity
check failure, and any check added later. The selected PowerShell performs
effective SID discovery feeding secret-file ACL hardening, so this converts a
trust-boundary failure into a different identity source. That is the one thing a
fallback here must never do.

The existing fallback test at `tests/windows-user-principal.test.ts:44` throws an
ordinary `Error("bun:ffi unavailable")`, so it currently certifies the unsafe
catch-all rather than a typed contract. The test passes; the contract does not
exist.

## The fix

1. Define and export a typed sentinel, e.g.
   `WindowsSystemDirectoryFfiUnavailableError`, in `src/lib/windows-elevation.ts`.
2. Throw it only at `src/lib/windows-elevation.ts:115-118`, where
   `loadGetSystemDirectoryW()` cannot provide the FFI function.
3. Leave the ordinary errors at 123-138 (API-call failure, unusable directory,
   oversized path) and the validation errors at 154-163 (containment, executable
   existence) exactly as they are.
4. In `resolveWindowsPrincipalPowerShellExecutable()`, allow the fallback only for
   `error instanceof WindowsSystemDirectoryFfiUnavailableError` *and* `win32`
   *and* `arm64` *and* fixed-file presence. Rethrow everything else unchanged.
5. A successfully resolved non-default root keeps returning its authoritative
   PowerShell path and never probes `C:\Windows`.

## Regressions (all in `tests/windows-user-principal.test.ts`)

1. typed sentinel + win32 + arm64 + fixed executable present -> fallback;
2. `GetSystemDirectoryW` call failure -> rethrown, fallback never probed;
3. unusable/invalid non-default system directory -> rethrown;
4. trusted PowerShell missing / validation / containment failure -> rethrown;
5. arbitrary resolver error -> rethrown;
6. successful trusted resolution wins and never probes the fallback;
7. sentinel still fails closed on non-Windows, non-ARM64, or missing executable.

Cases 2-5 are the ablation: each must be red against the catch-all version.

## Platform limitation

Windows-only, and `windows N/4` is SKIPPED (#1059). The resolver seam is
injectable so the tests run on macOS, but no real ARM64 Windows behavior is
exercised here. Recorded as a gap.

## Verification

- `bun test tests/windows-user-principal.test.ts tests/windows-elevation.test.ts`
  (baseline on the contributor head: 23 pass / 0 fail)
- `bun run typecheck`, `bun run privacy:scan`
