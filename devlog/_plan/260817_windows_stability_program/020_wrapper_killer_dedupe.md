# 020 — Collapse the duplicated scheduler-wrapper killer (F2)

**Depends on:** nothing structural. Either order works with 010: doing 020 first
moves one flawed implementation and 010 then fixes it once. Prefer 010 first
only because it is trivial. Both touch the same files, so sequence to avoid
collisions (see `002`).

## Change

New shared helper, `src/lib/windows-service-wrappers.ts`:

```ts
export function killWindowsSchedulerWrappers(opts: {
  scriptPath: string;   // ...\opencodex-service.cmd
  launcherPath: string; // ...\opencodex-service-launcher.vbs
}): void
```

Take the `src/service.ts:2330` implementation as the base — it is the correct
one. It builds canonical paths for *this* OpenCodex home and requires each to
appear as a complete command-line token, checking that the characters on either
side of the match are whitespace or a quote (`src/service.ts:2351-2356`).

Then:

- `src/service.ts` — `killWindowsServiceWrapperProcesses()` becomes a call into
  the helper with this home's paths.
- `src/update/job.ts:1373-1392` — delete the bare-substring implementation
  entirely and call the helper. The updater knows its target home; pass it.

## Verify

```powershell
bun run typecheck
bun test tests/service.test.ts
bun test tests/windows-deploy-close-regressions.test.ts
bun test tests/update-job.test.ts
```

Add a case asserting that a command line containing `opencodex-service.cmd` as
a *substring of a different absolute path* does not match. That is the exact
cross-home kill F2 describes, and it fails against today's `update/job.ts`.

## Risk

Medium — this is the phase that can regress `ocx stop`. The updater currently
kills more broadly than it should, so anything relying on that over-broad
behavior to clean up a stale wrapper will now leave it running. Check that the
updater passes the home it is actually updating, not the home of the process
doing the updating; on the dashboard path those can differ.
