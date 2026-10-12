# B4 — SSH Link command and diagnostic boundary

Depends on B2 integration into current `dev` and completion of B3's hold/comment disposition; B3 has no source PR to integrate. Resolve issue #6088 in a lane-owned PR. This is an SSH transport fix, not a redesign of Link join admission (#6076 stays open).

## Exact file map

| Path | Change from current behavior |
| --- | --- |
| `src/link/ssh-argv.ts` | MODIFY `quoteRemote`: validate the first argv token as a conservative command name and emit that name bare so a PowerShell OpenSSH `DefaultShell` can invoke `sh`; continue single-quoting every argument. Reject unsafe command names rather than interpolating them. Preserve NUL rejection and POSIX argument bytes. |
| `src/link/ssh-runner.ts` | MODIFY output decoding by channel: structured stdout stays strict UTF-8, while stderr diagnostic bytes use a replacement decode after the byte cap so `sshFailureHint` can redact/bound the real error. Never log raw stderr, key material or undecoded bytes. |
| `tests/clients/link-ssh-argv.test.ts` | MODIFY: bare validated command name, quoted arguments and metacharacter/NUL rejection; POSIX command execution retains the PATH prelude and arguments. Add direct runner tests for non-UTF-8 stderr, strict stdout rejection, output limit and secret/query redaction. On Windows, a non-skipped case invokes the installed `powershell.exe` parser and asserts command dispatch and arguments. |
| `structure/remote-link.md` | MODIFY the command quoting and diagnostic contract in present tense. Retain host-key, key-stdin and trust-store rules. |
| `docs-site/src/content/docs/guides/remote-link.md` | MODIFY only the troubleshooting text to explain that remote-shell errors surface as sanitized hints. Do not claim general Windows Link support from a local parser test; review maintained locales for contradictory support claims. |

## Security audit and activation

Assets are link keys, host identity and error diagnostics. Entrypoints are locally constructed remote argv plus untrusted SSH stderr. The first command token must remain an allowlisted executable name, while all arguments stay data; reject shell metacharacters and NUL in the command position. A remote PowerShell default shell receiving bare `sh` must dispatch it; arguments are still parsed by the invoked POSIX `sh`. A CP936-like invalid UTF-8 stderr must yield a bounded sanitized hint rather than the runner's generic decode failure; an invalid UTF-8 stdout must still fail. Test `--key-stdin` delivery and no credential disclosure.

The guide currently excludes Windows from the supported end-to-end flow. Confirm any support wording against a real Windows CI parser case and avoid declaring all Windows Link paths supported. Review #6076 separately for old Link/dashboard upgrade compatibility; this PR must not change admission.

## Verification and delivery

A-phase fold (session `01a0e37e`, auditor `01a0e381-33d6`, NEAR-PASS): the command position accepts exactly the constructed `sh` (an allowlist of one), not a character-class grammar. A class such as `[A-Za-z0-9._-]+` admits `1`, `.` and `-x`, which PowerShell does not treat as a command. Any other first token is rejected with a typed error, and the tests cover rejected forms. The exact quoted-output assertions in `tests/clients/link-ssh-argv.test.ts` change from `'sh'` to bare `sh`. Stdout stays strict because callers parse version and link data from it; stderr is decoded leniently only after the byte cap and reaches the user only through the existing bounded redaction in `src/link/ssh-runner.ts`.

Run `bun test tests/clients/link-ssh-argv.test.ts tests/server/link-management-routes.test.ts` (`link-ssh-argv.test.ts` already owns the runner cases; baseline at `24b2f39b77`: 36 pass, 0 fail), `bun run test:changed`, `bun run typecheck`, `bun run privacy:scan`, `bun run structure:check`, and the docs-site build if the guide changes. The PR records an explicit credential/diagnostic security review and exact-head pull-request CI. Before claiming #6088 fixed on Windows, dispatch the Cross-platform CI `all` lane on the B4 branch's exact head, verify the Windows shard completed successfully, and read its test log to confirm the named PowerShell parser assertion actually ran and passed rather than skipped; ordinary PR CI alone does not provide that full Windows proof. Close #6088 only after the merged SHA is on `dev` and post a link plus the observed Windows/POSIX verification scope.
