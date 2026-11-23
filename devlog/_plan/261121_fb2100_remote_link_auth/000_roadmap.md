# 261121 fb2100 Remote Link: Child auth and Windows

Lane fb-remotelink. Base `origin/dev` d61cca122, branch `codex/fb2100-remote-link-auth`.
One branch, ordered commits, one PR into `dev`; #8998 may split to `codex/fb2100-win-link-socket`
if it outgrows a clean change.

| Unit | Issue | Change | Proof |
|---|---|---|---|
| 010 | #8972 | `WINDOWS_OS_PROBE` uses `cmd.exe /c echo %OS%`; the three `Windows_NT` comparisons in `src/link/remote-platform.ts` accept the stray trailing quote that Win32-OpenSSH's `cmd.exe /c "<command>"` wrapping leaves; `probe_failed` carries a hint when platform detection fails. | Parser tests beside the existing remote-platform tests; local `cmd.exe` quote reproduction on Windows. |
| 020 | #8999 | The link-Child branch of `/api/machine/hub-relay/*` in `src/client/machine-listener.ts` also admits the local admin-token principal for exactly `GET`/`HEAD /api/quota-pool`; the refresh-query block and every other path keep requiring the Child's dashboard session. `structure/quota-pool.md` names the credential. | Listener test: the admin token reads quota-pool and is refused on another allow-listed read and on a refresh query. Security review. |
| 030 | #8985 | The Child's Remote Link page reads `/api/link/status` from the Child machine listener instead of the Home relay, shows the active link, and shows the `ocx` command that disconnects or resets to standalone. No browser disconnect: the Child listener refuses dashboard-session writes by design. | GUI test, `lint:i18n`, GUI build. |
| 040 | #8998 | The #8370 AF_UNIX local control socket also runs on win32. The `run` directory is held to the owner-only `private-runtime-directory` ACL policy on the server and the CLI side, and stale socket files are cleaned up because Bun does not unlink them on Windows. | Unit tests plus a real `ocx link status` against a non-loopback hub on this Windows host. Security review. |

## Audit fold (round 1, gpt-6.1-terra: FAIL, 4 blockers)

- Unit 030, blocker 4: the page gates its status read and its body on `sessionReady` for the shared plane. On a link
  Child the Child's own session must gate the local status read and the command panel; Home operations keep the shared
  readiness. The panel names the link-bound command `ocx disconnect --expect-link <id>` for a full install and the
  `ocx-child` form for a lightweight Child (`src/cli/link.ts`).
- Unit 040, blockers 1-3: the POSIX publication protocol (inode identity, hard-linked public name, `.c<port>.*` orphan
  sweep) does not carry to Windows, where `lstat` cannot read an AF_UNIX reparse point and Bun leaves the file behind.
  Windows gets its own protocol instead: bind only the private `.c<port>.<token8>` name, never publish a hard link,
  record the token in the lease, and let the CLI derive the socket name from the lease. Cleanup removes exact names
  derived from a dead owner's lease token, never a prefix, so the lease and lock files are never candidates. The run
  directory is created and hardened with the existing `hardenSecretDir` machinery, then verified with the
  `private-runtime-directory` policy before bind and before the CLI sends a token; a pre-existing directory that
  fails verification is refused. Directory creation and CLI admission also check trusted ancestry (the existing
  `trusted-ancestry` ACL policy for each existing parent, and no reparse point on the path), and an unsafe path fails
  closed: the runtime serves no socket and the CLI keeps its TCP request. Because hardening spawns `icacls`/PowerShell, the Windows start runs off the
  synchronous `startServer` path and `stop`/`abort` settle an in-flight start.
- Unit 040 is no longer a small change, so it moves to its own branch `codex/fb2100-win-link-socket` and a second PR,
  as the coordinator allowed. Units 010-030 ship first on `codex/fb2100-remote-link-auth`.

Follow-ups outside this lane: the `Claude-3p/configLibrary` leftover that fails Child sync (#8985 item 2)
and a guided Home -> Child setup flow (#8985 item 3).

Roadmap audit: round 1 FAIL (4 blockers), round 2 NEAR-PASS (trusted ancestry), both folded below. Order of record:
010 -> 020 -> 030 on this branch, then 040 on its own branch.

