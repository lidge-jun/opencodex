# 030 — Make the Windows replace-with-retry a shared primitive (F4)

**Depends on:** nothing structural. Sequence after 020 only to keep two people
out of the same files at once.

## Change

New module `src/lib/windows-atomic-replace.ts`. It must be a **new neutral
module, not an export from `config.ts`**: `src/config.ts:47` already imports
`./lib/config-ownership`, so having `config-ownership.ts` import back from
`config.ts` would close a cycle.

Move the retry loop from `src/config.ts:102-123` into it, keeping the shape
exactly: retry only on `win32`, only for `EBUSY`/`EPERM`/`EACCES`, never
masking another error, and keeping the `AtomicRenameIO` injection point
(`src/config.ts:105-109`) that makes it testable. The async twin at
`src/config.ts:287-299` moves with it. `config.ts` then imports from the new
module.

Convert the raw `renameSync` publishers:

- `src/codex/prompt-journal.ts` — publishes a journal carrying full
  `config.toml` bytes; a failure here is what breaks journal restore.
- `src/lib/config-ownership.ts` — publishes the uninstall ownership manifest.

Then sweep `src/` for remaining `renameSync` calls that publish a durable file
and either convert them or leave a comment saying why the file is transient.

**Do not change the retry envelope.** It stays at two retries / 75ms. Widening
it without evidence is how a 75ms hiccup becomes a 5s stall. 031 measures first.

## Verify

```powershell
bun run typecheck
bun run test
```

The full suite, not a focused run: this touches shared config and the atomic
write path, which AGENTS.md names as the case where repository-wide validation
is required.

Test via the injected `AtomicRenameIO` — a `rename` that throws `EBUSY` twice
then succeeds — rather than trying to produce a real sharing violation.

## Risk

Low-medium. Behavior-preserving for existing callers; new callers gain retries
they lacked, which can only turn a throw into a success. Watch for any caller
that depends on `renameSync` throwing promptly to detect a lock. The import
cycle is the concrete trap — hence the neutral module.
