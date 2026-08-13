# 040 — #557 replacement: npm cache preflight and log sanitization

## Why replace rather than rebase

PR #557 is 18 commits past its merge base; `dev` is 1,220 commits past the same
point. The diff is 24 files, +2351/-64, and mixes one good idea with machinery
that no longer matches the tree. Current `dev` has independently rebuilt the
restart and service-repair paths and absorbed none of #557's modules.

Its CI state confirms it: two branch-owned `update-job` failures on Windows
(`must not spawn`), a macOS hang in `update-npm-cache-preflight.test.ts` until
30-minute cancellation, and a Bun 1.3.14 crash on Ubuntu that looks
environmental. A rebase would carry all of that forward.

## The defect, still live on dev

`ocx` stops the proxy before it knows whether the install can succeed:

- `bin/ocx.mjs:116-138` checks the version, then proceeds to shutdown at
  `:139-258`; installation only starts at `:260-266`. npm cache access is never
  checked.
- `src/update/index.ts:168-179` runs a registry-integrity preflight — not a
  cache-access one — then shuts down at `:188-262`.

So a foreign-owned or unreadable nested cache entry produces a failed install
*after* the proxy is already down.

Second defect, same area: GUI update output is persisted verbatim. The flow —
corrected after audit, because an earlier draft cited the wrong line:

- `src/update/job.ts:269-282` — `updateExecutionCommand` only *builds* the
  command. It does not invoke anything.
- `src/update/job.ts:1469` — the actual invocation:
  `runLoggedCommand(job, cmd.bin, cmd.args, UPDATE_TIMEOUT_MS)`.
- `src/update/job.ts:520-530` — `runLoggedCommand` stores stdout/stderr.
- `src/update/job.ts:241-266` — the write boundary, which does not sanitize.

Local paths and account names end up in stored logs.

## Change

New `src/update/npm-cache-preflight.mjs`: bounded Unix cache inspection
returning structured reason codes. `lstat` nested symlinks and verify ownership,
then **skip traversal** rather than rejecting — normal `_npx`, `node_modules`,
and `.bin` links must not block an update. Never surface arbitrary worker text
into logs.

Call sites:

- `bin/ocx.mjs:138` — run the preflight before any tray or proxy stop.
- `src/update/index.ts:181-188` — same gate on the second entry point.
- `src/update/job.ts` — gate the job path before the stop that precedes
  `runLoggedCommand` at `:1469`, not merely before the command is constructed at
  `:269`. Building a command is free; stopping the proxy is the irreversible
  step, and the preflight must sit ahead of it.
- `src/update/job.ts:241-266` — sanitize every persisted field and log line at
  the write boundary: Windows and POSIX separators, anchorless profile paths,
  multi-word usernames, cache paths, UID/GID.

Windows is an explicit tested skip, not an accidental gap.

Excluded from the replacement: `install-process.*`, the recovery-tree
declarations, the PID/config changes, and the recovery rewrites. #557's process
runner is where its crashes live — missing stream `error` handlers, rejecting
cleanup promises, leaked signal listeners — and none of it is needed for the
preflight.

## Tests

- `tests/update-npm-cache-preflight.test.ts` (new): foreign or inaccessible
  entries abort before stop; normal nested symlinks pass without target
  traversal; timeout and malformed worker output fail closed; the Windows skip
  does not spawn npm.
- `tests/update-stop-first.test.ts:21`: the gate runs before shutdown.
- `tests/update-job.test.ts`: persisted logs contain no profile path, cache
  path, or UID/GID.

Tests must exercise behavior. #557 had source-text assertions that passed
without running the code they described.

## Objections the replacement must satisfy

Carried from the review threads on #557, since a replacement that repeats them
will collect the same objections:

1. Normal npm-cache symlinks must not block updates.
2. Sanitization covers anchorless Windows paths and multi-word usernames.
3. Windows behavior is explicit policy with a tested no-spawn skip.
4. No process-runner crash surface — excluded entirely.
5. No unreachable branches, no source-text-only tests; docs, declarations, and
   runtime behavior agree.

Update the five lifecycle locales only. Do not import #557's ADR or recovery
prose; it describes a tree that no longer exists.

## Security review gate

This phase touches the dependency-install and update path, which requires
explicit security review under `MAINTAINERS.md` — CI green is not sufficient.
Run `bun run privacy:scan` (the sanitization change is exactly what it guards)
and request security review before marking the PR ready.

## Locale-file dependency

Phase 060 also edits lifecycle locale files. Whichever lands first, the second
rebases; note it in both PR bodies so the conflict is expected rather than
discovered.
