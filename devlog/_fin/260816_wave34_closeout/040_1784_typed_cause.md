# 040 — #1784: stop manufacturing `reason: "disk"`

## Verified defect

There is no exception type to propagate — failures are DATA. `CatalogDisposition` carries `reason: provider-auth | provider-network | disk` plus `phase`, `retryable`, `partialWrite`, and **no cause field** (`src/codex/convergence-types.ts:160`).

The cause is discarded twice:

1. `createManagementConvergeCodex` catches, inspects two message substrings for busy/database admission, and otherwise returns hard-coded `failed/disk` without storing the caught error (`src/codex/management-convergence.ts:52`, `:62`, `:107`).
2. `src/server/management-api.ts:177` catches without binding the error at all, and again manufactures `reason: "disk"`, choosing gather-vs-commit purely from whether invocation had begun.

Tests pin both collapses (`tests/codex-management-convergence.test.ts:67`, `tests/codex-convergence-contract.test.ts:303`).

So a malformed request and a genuine ENOSPC are indistinguishable to the operator, and both are reported non-retryable.

## Fix

Extend the disposition rather than inventing the roadmap's `CatalogConvergenceError`:

```diff
 type CatalogDisposition = {
   ...
   reason: "provider-auth" | "provider-network" | "disk"
+        | "request-invalid" | "admission" | "internal";
+  /** Allowlisted cause summary. Closed vocabularies only -- never message text. */
+  cause?: { name: string; detail: string };
 };
```

- `request-invalid` for programming/shape errors (malformed scope, bad factory input).
- `admission` for lock/contention/database-busy, which IS retryable.
- `internal` for anything genuinely unclassified — explicitly not `disk`.
- `disk` narrows to real filesystem failures.

### The normalization boundary must be updated too

`normalizeCatalogDisposition` (`src/codex/catalog-refresh-status.ts:42`) is an explicit privacy boundary: it rebuilds the disposition from an allowlist of own data properties precisely so a malformed callback cannot smuggle provider or account detail into a management response. Adding `reason` values or a `cause` field without updating that allowlist means the new information is silently dropped — the plan would look implemented and change nothing.

So: extend the allowlist with the new reasons AND with `cause`, and update its exhaustive disposition matrix plus `tests/codex-catalog-refresh-status.test.ts`.

### `cause` must be a bounded summary, not an error message

Passing `Error.message` through `redactSecretString` is NOT sufficient. That helper masks token-shaped values; it does not remove filesystem paths, home directories, account ids or hostnames, all of which routinely appear in an error message and all of which this boundary exists to keep out.

Build `cause` from bounded, non-sensitive parts instead:

Both fields are allowlists, because neither is a fixed vocabulary in practice:

- `name`: map onto a closed set — `"invalid-request" | "lock-busy" | "io" | "unknown"`. An arbitrary `Error.constructor.name` is dependency- or input-influenced (any thrown custom class names itself), so it is not safe to echo.
- `detail`: only a recognized `errno`/`code` token from a closed set (`ENOSPC`, `EACCES`, `EPERM`, `SQLITE_BUSY`, ...), or a fixed per-branch phrase. Never `Error.message`, never a path, never an interpolated identifier.

If a branch cannot produce a safe summary, omit `cause` entirely. The point of the change is that `request-invalid` is distinguishable from `disk`; the free-text message is not required for that.

## Tests

Update the two pinning tests to assert the NEW classification rather than `disk`, update the disposition matrix in `tests/codex-catalog-refresh-status.test.ts`, and add: a malformed scope yields `request-invalid`; a simulated lock-busy yields `admission` with `retryable: true`; a simulated write failure still yields `disk`; and an error whose message embeds a home path plus a token-shaped string produces a response containing neither.
