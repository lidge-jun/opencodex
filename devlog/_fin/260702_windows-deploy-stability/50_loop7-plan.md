# Windows/Linux Deploy Stability — Loop 7 Plan (P)

- **Date:** 2026-07-02 · **Branch:** cursor-fixes · **Class:** C3
- **Input:** loop-6 audit backlog — the three deferred findings (F5/F6/F8), all re-verified
  against source this session.

## Findings in scope

| # | Sev | OS | Defect | Evidence |
|---|-----|----|--------|----------|
| F5 | med | win primarily | OAuth callback advertises `localhost`, binds IPv4, then best-effort binds `::1` and swallows ALL failures. If `::1:<port>` is held by another process (EADDRINUSE), a browser resolving `localhost`→`::1` first delivers the OAuth callback (auth code) to the foreign listener. | `src/oauth/callback-server.ts:147-160` |
| F6 | med | all | Proxy port selection is check-then-bind: `chooseListenPort` probes with a throwaway net.Server, then `startServer` binds later. Two concurrent `ocx start`/`ensure` see the same free port; the loser dies with an unhandled bind error instead of retrying. | `src/cli.ts:102-136`, `src/ports.ts:3-29` |
| F8 | med | win | `installWindows` rewrites the service `.cmd` script and task XML BEFORE ending a running scheduled task. cmd.exe reading the script mid-rewrite executes a torn script; open handles can throw EBUSY/EPERM on the in-place `writeFileSync`. | `src/service.ts:399-409` |

## Diff-level changes

**MODIFY `src/oauth/callback-server.ts`** (F5)
- `#createServers`: extra-host (IPv6 loopback) bind failure is no longer always swallowed.
  New module-scope helper `isAddrInUse(err: unknown): boolean` (checks `code === "EADDRINUSE"`
  or message containing `EADDRINUSE`/`address in use`, case-insensitive).
  When the advertised hostname is ambiguous (`localhost` — i.e. `extraHosts` is non-empty by
  construction) and the extra bind fails with EADDRINUSE: stop the primary listener and
  rethrow — the port is compromised, `#startCallbackServer` falls back to a random port
  (or fails loudly when `redirectUri` pins the port). Non-EADDRINUSE failures (IPv6
  unsupported: EAFNOSUPPORT/EADDRNOTAVAIL) keep today's IPv4-only degradation.

**MODIFY `src/ports.ts` + `src/cli.ts`** (F6)
- `ports.ts`: export `isAddrInUse(err: unknown): boolean` (shared with callback-server —
  single owner in ports.ts, callback-server imports it).
- `cli.ts` `handleStart`: bind-retry loop around `startServer` (max 3 attempts):
  on `isAddrInUse` error, log one line and re-run `chooseListenPort(requestedPort)`;
  non-EADDRINUSE errors propagate unchanged.

**MODIFY `src/service.ts`** (F8)
- `installWindows`: move `try { stopWindows(); } catch {}` BEFORE the two `writeFileSync`
  calls; write both assets via new local `writeServiceAssetWithRetry(path, content, encoding)`
  — up to 3 attempts with `Bun.sleepSync(150)` between, retrying only EBUSY/EPERM/EACCES.
  (In-place write keeps the same inode semantics as today; retry covers transient handles
  from the just-ended task.)

## Tests

- `tests/oauth-callback-binds.test.ts`: `isAddrInUse` truth table (code, message, foreign
  errors) — imported from ports.
- `tests/ports.test.ts` or nearest: `isAddrInUse` cases if not covered above.
- F8: extract/verify via existing service test seams if present; otherwise source-shape
  assertion (stop-before-write ordering) in `tests/service.test.ts` mirroring the repo's
  established source-contract test style (see tests/update-stop-first.test.ts).

## Verification gate (C)

`bun test ./tests/` (0 fail) + `bun x tsc --noEmit` (0 errors).
