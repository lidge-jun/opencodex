# Config Ownership Manifest

`src/lib/config-ownership.ts` keeps the owner marker (`.opencodex-owner.json`) and the uninstall
manifest (`.opencodex-uninstall.json`) that bound what `ocx uninstall` may remove from the
OpenCodex state root. The removal rules themselves are in [Config Surface](config.md).

## One lock for every manifest update

Every manifest read-modify-write holds one cross-process lock, `.opencodex-uninstall.lock` in the
same root. It is a `BEGIN IMMEDIATE` SQLite transaction on that file, the OS-held primitive the
config mutation lock in `src/config/mutation-lock.ts` uses: closing the handle releases it, also at
process exit or crash, so there is no stale owner to recover. That module cannot be reused directly,
because it records its own database through `recordOwnedConfigPath`.

- `recordOwnedConfigPath` re-reads the manifest from disk under the lock, never from its process
  cache, and replaces it atomically. Processes that share a home therefore keep each other's entries
  (#8093). A path the cache already lists returns after one `lstat` only while the manifest is still
  the file this process last saw under the lock; any other process's write, including a tombstone,
  sends it through the locked check.
- A lock still busy after a two-second wait throws `ConfigOwnershipLockError`; nothing is written.
- A registration that would push the manifest past 1,024 paths, or past the 64 KiB metadata limit
  less room for the tombstone, records nothing and warns once, so the manifest always stays one
  uninstall accepts. Writers keep working, and uninstall reports such files as residual paths.
- The lock file is created only while the owner marker exists, so a refused uninstall of a home
  without metadata leaves that home untouched. A holder that finds the metadata gone removes the
  lock file, and a waiter whose lock file was unlinked under it retries against the current path.

## Uninstall tombstone

Uninstall takes the lock, validates every manifest path, writes an `uninstallStartedAt` tombstone
into the manifest and snapshots the paths in the same hold. It removes the snapshot without the lock,
then deletes the manifest and owner marker under the lock and removes the lock file.

- A registration that acquires the lock after the tombstone throws
  `ConfigUninstallInProgressError` and writes nothing. A racing registration is therefore either in
  the snapshot and removed, or refused; one that arrives after the metadata is gone records nothing
  and its file is reported as a residual path.
- An interrupted uninstall (a crash, or a path it could not remove) leaves the tombstone. Registrations
  keep refusing, and the next `ocx uninstall` finishes from the same manifest.
- Uninstall deletes the manifest before the owner marker. If it stops after that (a crash, or a lock
  file Windows keeps because another process holds it open), a rerun that finds only a valid owner
  marker and lock files removes them and the root. Any other file next to them is still refused.
- Callers that create a file only after registering it skip that file on a refusal: the restart
  handoff log is not opened, and service log rotation registers its generations before every
  rotation, so a tombstone written while the service runs stops it.
- The guarantee covers manifest entries. A process that recorded a path before the snapshot can still
  create that file after uninstall removed it, which is why uninstall stops the service first.

`tests/config/config-ownership-concurrent-record.test.ts` covers concurrent registrations, a
registration racing uninstall, the tombstone refusal for cached paths, a rerun after an interrupted
uninstall or a leftover lock file, the busy lock, a home without metadata, and log rotation.
