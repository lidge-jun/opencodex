# O8 — a refused disconnect rolls back its `prepared` receipt

## Cause

`disconnectClient` (src/client/connect.ts) writes `desktop-remote/disconnect.json` with phase `prepared`, then runs `restoreConnectedCodex` outside the lifecycle lock. A throw there leaves the receipt. Every non-`complete` receipt makes `observeClientRotationRecovery` (src/client/state.ts) answer `client_disconnect_pending`, and client startup refuses (src/cli/index.ts). A retry repeats the same Codex restore and fails the same way.

## Decision

`desktop_restored` is the commit point. Before it, the receipt records intent only: the Claude Desktop store, the catalog, the service token and the connection are untouched. So a failure before `desktop_restored` aborts: the receipt is removed (compare-and-delete against the receipt this run read), and the `desktop-remote` folder is removed too when the receipt was the only thing in it. At or after `desktop_restored` a retry must finish, as today.

What a partial Codex journal restore leaves behind: the journal (recovery evidence), config.toml as it was, possibly the generated profile already reverted. The connection stays `connected`; the client runtime's next sync re-injects routing and regenerates the profile.

The startup refusal names its fix: run `ocx disconnect` again (same `--keep-catalog` choice) to finish or roll back.

## Tests (fail on base first)

- refused disconnect: receipt gone, folder gone, connection connected, rotation gate `clean` (startup would pass), journal kept.
- upgrade path: a `prepared` receipt written as 2.100.2 left it; `ocx disconnect` on the new build either completes (Codex side now restorable) or rolls back (still refused), never needs a folder moved.
