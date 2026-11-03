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
- SQLite's own busy wait is off: a lock still held after a 50 ms bounded retry throws
  `ConfigOwnershipLockError` and nothing is written. The retry is synchronous, so a held lock blocks
  the calling thread (and the event loop) for at most those 50 ms, never indefinitely. A
  path the manifest already lists is still accepted while the lock is busy: the manifest is replaced
  atomically, so an unlocked read is a consistent version, and the path is refused only when that
  version carries an uninstall tombstone. Only a new path needs the lock.
- A registration that would push the manifest past 1,024 paths, or past the 64 KiB metadata limit
  less room for the tombstone, records nothing and warns once, so the manifest always stays one
  uninstall accepts. Writers keep working, and uninstall reports such files as residual paths. A
  tombstoned manifest may use that reserve when it is read, so a home whose older manifest already
  sits at the limit still resumes an interrupted uninstall; without a tombstone the limit is unchanged.
- The lock file is created only while the owner marker exists, so a refused uninstall of a home
  without metadata leaves that home untouched. A holder that finds the metadata gone removes the
  lock file, and a waiter whose lock file was unlinked under it retries against the current path.

## Uninstall tombstone

Uninstall holds the lock for its whole run: it validates every manifest path, writes an
`uninstallStartedAt` tombstone, removes abandoned metadata temp files, removes the snapshot,
rewrites the owner marker with `uninstallSnapshotRemovedAt`, and deletes the manifest and then the
owner marker. It removes the lock file after releasing it. While the run holds the lock, a second
uninstall is refused as busy, a new path cannot be registered, and a listed path read without the
lock sees the tombstone, so nothing can be recorded or recreated behind the snapshot.

- A registration that acquires the lock after the tombstone throws
  `ConfigUninstallInProgressError` and writes nothing. A racing registration is therefore either in
  the snapshot and removed, or refused. One that arrives after the metadata is gone while the root
  still holds other files records nothing, and its file is reported as a residual path if it exists
  when uninstall lists what remains (a file created after that point is not seen by that run). One
  that arrives when the root is missing or empty creates new metadata and records its path there.
  Between the two final unlinks only the flagged owner marker remains; a registration that finds it
  is refused as an uninstall in progress, not treated as an unowned home. A home cached as unowned is
  re-read on later registrations, so an owner marker another process writes late is picked up.
- An interrupted uninstall (a crash, or a path it could not remove) leaves the tombstone. Registrations
  keep refusing, and the next `ocx uninstall` finishes from the same manifest. The rerun's own cleanup
  steps (Desktop picker, disconnect, integrations) run inside `beginConfigOwnershipTeardown`, where this
  process's registrations skip the tombstone check: its remover snapshots the manifest under the lock
  afterwards, so whatever they add is removed in the same run. Under the lock it also
  removes manifest and owner-marker temporary files a stopped write left behind.
- Creation writes the manifest before the owner marker and uninstall deletes them in the reverse
  order, so a root holding only the owner marker is always a stopped uninstall, never a home being
  created. If uninstall stops after deleting the manifest (a crash, or a lock
  file Windows keeps because another process holds it open), a rerun that finds only a valid owner
  marker and lock files removes them and the root. Only an owner marker carrying
  `uninstallSnapshotRemovedAt` lets a rerun also remove
  top-level names every manifest starts with, which the rerun's own cleanup (the config mutation
  lock) can recreate first. A home whose manifest is missing for any other reason keeps them and is
  refused. Any other file next to them is still refused.
- Callers that create a file only after registering it skip that file on a refusal: the restart
  handoff log is not opened, and service log rotation registers its generations before every
  rotation, so a tombstone written while the service runs stops it.
- The guarantee covers manifest entries. A process that recorded a path before the snapshot can still
  create that file after uninstall removed it, which is why uninstall stops the service first.

`tests/config/config-ownership-concurrent-record.test.ts` covers concurrent registrations, a
registration racing uninstall, the tombstone refusal for cached paths, a rerun after an interrupted
uninstall or a leftover lock file, the busy lock, a home without metadata, and log rotation.
