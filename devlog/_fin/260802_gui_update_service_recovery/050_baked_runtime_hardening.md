# WP5 — Baked-runtime hardening (demoted R1 finding)

Optional. Not a cause of the reported failure; see `003_audit_round1_correction.md`.
Run it only if WP1-WP4 land and the phase budget allows.

## Standing

R1 proposed this as the root cause. It is not: `bundledBunPath()`
(`src/lib/bun-runtime.ts:35-46`) already gates every candidate through
`isRealBunBinary`, so the `bun` postinstall placeholder cannot reach
`ProgramArguments`. What survives is a narrower, genuinely reachable gap.

## The reachable gap

`durableBunRuntime()` (`src/lib/bun-runtime.ts:55-61`):

```ts
export function durableBunRuntime(): DurableBunRuntime {
  const override = overrideBunPath();
  if (override) return { path: override, source: "override", ... };
  const bundled = bundledBunPath();
  if (bundled) return { path: bundled, source: "bundled", ... };
  return { path: process.execPath, source: "process", ... };   // <-- unvalidated
}
```

The first two branches validate. The third does not: when
`require.resolve("bun/package.json")` throws — which happens while npm has the
global package tree transiently renamed to `@bitkyc08/.opencodex-*`, a case
`packageLauncherPath()` (`src/update/job.ts:209-218`) already handles for the
launcher — `process.execPath` is baked verbatim. If the update worker is executing
from that temp tree, the plist freezes a path that will not exist minutes later.

`bakedServicePathsDiagnostic()` (`src/service.ts:1550`) would then report `STALE`
correctly, because the path really is gone. So the existing diagnostic already
covers the *disappearing* case. The uncovered case is narrower still: a baked
`process.execPath` that continues to exist but is not a usable Bun (a `node`
binary, say, if a future call path reaches this from Node).

## Change

```diff
 export function durableBunRuntime(): DurableBunRuntime {
   const override = overrideBunPath();
   if (override) return { path: override, source: "override", overrideEnv: BUN_OVERRIDE_ENV };
   const bundled = bundledBunPath();
   if (bundled) return { path: bundled, source: "bundled", overrideEnv: BUN_OVERRIDE_ENV };
+  // Last resort. Normally Bun (the CLI runs under it), but a caller reaching here
+  // from Node — or from npm's transient @bitkyc08/.opencodex-* rename tree — would
+  // bake a runtime that cannot serve. Flag it so durable-artifact writers can refuse.
   return { path: process.execPath, source: "process", overrideEnv: BUN_OVERRIDE_ENV };
 }
```

plus, in `src/service.ts`'s `cliEntry()`, refusing `source === "process"` when the
path fails `isRealBunBinary`. `durableBunRuntime` is already imported at
`src/service.ts:18`, so `cliEntry()` can switch from `durableBunPath()` to the
richer struct without a new import.

## Mandatory companion edit

If any size-floor validation is added to `bakedServicePathsDiagnostic()`,
`tests/service.test.ts:816-823` **must** change in the same commit. That fixture
sets `bunPath` to `service.test.ts` itself (47,317 bytes) and asserts
`toBeNull()`; a 1MB floor turns it red. The audit caught this in R1, where the
plan had claimed "no behavior change for a healthy install".

Point the fixture at a ≥1MB temp file written in `beforeAll`, not at a source
file whose size is incidental.

## Verification

```
bun x tsc --noEmit
bun test tests/service.test.ts tests/bun-runtime.test.ts
bun run test
```

## Done when

- A baked runtime that is not a usable Bun is refused at install time.
- The `service.test.ts` fixture no longer depends on its own file size.
- No change in behavior for the bundled and override paths, which already validate.
