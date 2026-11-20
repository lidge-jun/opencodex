# 040 #8998: `ocx link status` on a Windows hub with a non-loopback listener

Branch `codex/fb2100-win-link-socket` from `origin/dev` 70c9e2134, second PR (roadmap unit 040).

Problem: #8370 serves `GET /api/link/status` over a private AF_UNIX socket so the CLI's admin token has trusted
ingress on a hub whose public listener is not loopback. `localControlSocketSupported()` is false on win32, so a
Windows hub answers the CLI with `403` on every TCP listener.

Measured on this Windows 11 host, Bun 1.3.14:

| Behaviour | Result |
|---|---|
| `Bun.serve({ unix })` and `fetch(..., { unix })` with a path under 103 bytes | work (200) |
| `lstat` of the socket file and of a hard link to it | `EACCES` (a plain file in the same directory stats fine) |
| `existsSync` on the socket | `false`; `readdirSync` lists it |
| `linkSync` to the socket, then fetch through the link | works |
| unlink of either name while the server listens; rebind after unlink | works |
| `server.stop()` | unlinks its bound name once the stop completes; a killed process leaves it behind |
| `hardenSecretDir` + `verifyWindowsEntriesAcl(private-runtime-directory)` on the run directory | 410 ms + 273 ms once; a repeat harden is memoized (0 ms) |

Design: keep #8370's protocol (private `.c<port>.<token8>`, public hard link `control-<port>.sock`, per-port lease under
the claim mutex) and replace only the parts that read POSIX identity:

- `src/lib/local-control-socket.ts`: supported on win32. `isPrivateSocketDir` on win32 = a real directory (no
  symlink or junction) whose DACL passes the `private-runtime-directory` policy. A socket entry on win32 = listed by
  `readdir` and `lstat` refused with `EACCES` (an AF_UNIX reparse point); a readable regular file is not ours.
  `isLocalControlPrivateSocketName(port, name)` matches exactly `.c<port>.<8 hex>`, so the lease and claim files are
  never cleanup candidates.
- `src/server/index/local-control-listener.ts`: `preparePrivateDir` on win32 creates the directory, refuses a
  symlink/junction or non-directory, hardens it with `hardenSecretDir` (as `src/client/lifecycle-lock.ts` does for its
  runtime directory) and refuses it unless the ACL check then passes. No chmod of the socket on win32. Publication and
  orphan sweep use the win32 socket test. Ownership at release on win32 is "the lease still names this token" checked
  inside the claim mutex (a successor can publish only after it holds the lease), instead of inode identity;
  `abort()` keeps Bun's own unlink, as on POSIX.
- `src/cli/link-local-control.ts`: unchanged flow; `usableLocalControlSocket` now answers on win32 after the same
  directory ACL check, so the token goes to the socket only in a private directory.
- Trusted path (audit round 1, blocker 1): one check, `windowsTrustedRunDir(dir)`, used by the server before it binds
  and by the CLI before it sends the token. The canonical path (`realpathSync.native`) must spell the same path, so no
  junction, symlink or other reparse point sits anywhere on it; then one ACL batch must pass: every ancestor of the
  config home under `trusted-ancestry` (owned by the user or a kernel-equivalent principal, nobody else holding write,
  delete or DACL rights), the config home under `write-private`, and the run directory under
  `private-runtime-directory`. Once no other principal can write anywhere on the path, the path verified before
  connecting cannot be swapped before the connect. Same-user processes and administrators are inside the trust
  boundary, as for every other file in the config home. Any failure (unexpected error, timeout, unverifiable path)
  answers "not trusted": the server serves no socket and the CLI keeps its TCP request.
- Failed publication (audit round 1, blocker 2): `acquireLease` takes a rollback that runs inside the claim mutex
  before the lease is removed. On win32 it stops the bound listener and unlinks the private name this attempt bound;
  the public link is the last, atomic step of publication, so a failed attempt never published it and never touches it.
- A win32 cleanup candidate must be listed, match the exact private-name format and refuse `lstat` with `EACCES`;
  any other error leaves the entry alone, and an unlink error leaves it too.
- The start stays synchronous: the one-time cost (about 0.7 s) applies only to a Windows hub whose public listener is
  not loopback, and an async start would add a new in-flight state to stop and abort.

Tests: `tests/server/local-control-socket-windows.test.ts` (win32 only: TCP 403 vs socket 200, other routes 404,
`ocx link status` over the socket, files and lease removed on stop, a crashed predecessor's socket names replaced while a
decoy and the lease format survive, a loosened directory refused by the client, a loose pre-existing directory hardened,
a config home under a parent other users can write refused by server and client while the token stays protected, a
failed publication that leaves no private name and no lease) and platform-neutral name-matcher cases. Registered in the
test layout.

Verification: that file and `tests/server/local-control-socket.test.ts` on Windows, `bun run typecheck`,
`bun run test:changed`, `bun run structure:check`, and a real `ocx start` with `hostname: 0.0.0.0` plus
`ocx link status --json` on this host. Security review by gpt-6.1-terra.

