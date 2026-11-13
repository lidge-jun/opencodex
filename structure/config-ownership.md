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
- `configPathOwnership` is the read-only check: it reports whether the manifest lists a path or one
  of its ancestors, lists neither, or the home has no ownership metadata, writes nothing, and throws
  `ConfigUninstallInProgressError` under a tombstone like a registration. A writer that must not adopt
  existing data (the ocx-child cache fill, `src/link/child-binary-cache-start.ts`) creates its directory
  first and registers it only then (removing it again, only if it created it, when the registration
  fails, and stopping when the home's metadata vanished meanwhile), adopts an unlisted
  one only when it is empty, owned by this user and writable by nobody else, and leaves any other alone.
- A registration that would push the manifest past 1,024 paths, or past the 64 KiB metadata limit
  less room for the tombstone, records nothing and warns once, so the manifest always stays one
  uninstall accepts. Writers keep working, and uninstall reports such files as residual paths. A
  tombstoned manifest may use that reserve when it is read, so a home whose older manifest already
  sits at the limit still resumes an interrupted uninstall; without a tombstone the limit is unchanged.
- The lock file is created only while ownership metadata exists, so a refused uninstall of a home
  without metadata leaves that home untouched. A holder that finds both metadata files gone removes
  the lock file only if the path still names the file it locked; a new installation may already
  have created its own lock there. A waiter whose lock file was unlinked under it retries against
  the current path.

## Uninstall tombstone

Uninstall holds the lock for its whole run: it validates every manifest path, writes an
`uninstallStartedAt` tombstone, removes abandoned metadata temp files, removes the snapshot
(a listed symlink is unlinked even when its target is gone),
and deletes the owner marker and then the manifest. It unlinks the lock file while still holding
it, so a process that takes the old file afterwards sees the path change and retries instead of
working beside a new installation's lock; Windows refuses to delete a file any handle has open, so
there the unlink is retried after release and succeeds only when no other process has it open.
Only an empty, single-link lock sidecar is removed after release. SQLite manages the `-journal`
and `-wal` names of the lock database itself (opening the empty lock database removes them, as
any lock acquisition does); a `-shm` holding data stays and is reported.
While the run holds the lock, a second uninstall is refused as busy and a new path cannot be
registered. A listed path read without the lock is refused by the tombstone, except inside a
process's own uninstall teardown scope (described below), where it is accepted as recorded. So
nothing new can be recorded behind the snapshot by another process. (A writer that registered
before the tombstone can still create its file afterwards; see the last item below.)

- A registration that acquires the lock after the tombstone throws
  `ConfigUninstallInProgressError` and writes nothing. A racing registration is therefore either in
  the snapshot and removed, or refused. One that arrives after the metadata is gone while the root
  still holds other files records nothing, and its file is reported as a residual path if it exists
  when uninstall lists what remains (a file created after that point is not seen by that run). One
  that arrives when the root is missing or empty creates new metadata and records its path there.
  Between the two final unlinks only the tombstoned manifest remains; a registration that finds it,
  including one from a process that cached the ownership earlier, is refused as an uninstall in
  progress, not treated as an unowned home. A home cached as unowned is re-read on later
  registrations, so an owner marker another process writes late is picked up, and a root that has
  become empty is claimed like an absent one. An uncached or previously unowned registration with a
  manifest but no valid matching ownership pair waits up to 100 ms for publication to finish, including when the owner
  file exists but its JSON is still being written. A complete pair loads immediately; a tombstoned
  manifest without an owner is not treated as creation. Expiry records nothing, and damaged or
  mismatched metadata never grants ownership; uninstall reports an unrecorded file as a residual.
- An interrupted uninstall (a crash, or a path it could not remove) leaves the tombstone. Registrations
  keep refusing, and the next `ocx uninstall` finishes from the same manifest. The rerun's own cleanup
  steps (Desktop picker, disconnect, integrations) run inside `beginConfigOwnershipTeardown`, where this
  process's registrations skip the tombstone check: its remover snapshots the manifest under the lock
  afterwards, so whatever they add is removed in the same run. Under the lock it also
  removes manifest temporary files a stopped write left behind, but only one whose content is a
  manifest with this home's owner id and root; any other file with such a name is kept and
  reported. Under the tombstone (with or without
  the owner marker) the same scope records a path that does not exist yet, such as the config
  mutation database an older snapshot lacks, and never adopts an existing entry the snapshot does
  not list. An initially owned name may use a fixed recovery reserve past the usual caps, so an
  older full manifest cannot strand the files the rerun's own cleanup creates.
- Creation writes the manifest before the owner marker, and uninstall deletes the owner marker
  before the manifest. Both pass through a manifest without an owner marker; only uninstall's carries
  the tombstone, so a home being created is never taken for a stopped uninstall. A run that stops
  after deleting the owner marker leaves the tombstoned manifest, which still holds the owner id,
  the root and the exact snapshot: the rerun resumes from it and removes only the paths it lists. A
  name every new manifest starts with but this one omits is never removed. A home with an owner
  marker and no manifest is refused untouched. A root holding nothing but the empty lock file and
  empty lock sidecars (Windows keeps a file another process holds open; the lock never writes data)
  is cleared once the lock can be taken, and refused while it is held. Without ownership metadata,
  any lock-named file that holds data, a sidecar without the lock file, or any other file makes the
  home refused untouched.
- Callers that create a file only after registering it skip that file on a refusal: the restart
  handoff log is not opened, and service log rotation registers its generations before every
  rotation, so a tombstone written while the service runs stops it. Any other failed registration
  (a busy or broken ownership lock) skips at most three rotations in a row; then the log rotates
  unrecorded, as on a full manifest, so a lasting lock fault cannot let it grow without bound. The OAuth store's one-time
  legacy backup is registered before it is copied (`registerOwnedConfigPath` tells an unowned home
  from a full manifest): a thrown registration defers the migration so the legacy store stays for a
  later attempt, and a full manifest skips the copy rather than leave credentials uninstall cannot
  remove.
- The guarantee covers manifest entries. A process that recorded a path before the snapshot can still
  create that file after uninstall removed it, which is why uninstall stops the service first. A run
  removes whatever is at a listed name when it gets there, and a resumed run does the same; it keeps
  no per-file identity.

## Removal stays inside the root

`removeOwnedConfigState` resolves the config root to its realpath once, at the start, and every later
step of the run (the lock, metadata, temp files, entries and the final rmdir) uses that canonical
path and never resolves it again. It records the root's device and inode at that point; before the
lock, before the tombstone, before each entry, before temp cleanup, before the metadata unlinks and
before the final rmdir it confirms the root is still that directory, real and resolving to itself.
A change found before the tombstone is refused without changing owned state (a change found under
the lock can leave the ownership lock file in place); one found later ends the run partial. Residual
paths are reported in the spelling the caller passed. A root reached through an
aliased ancestor, such as macOS `/var` for `/private/var`, therefore still works, and a root that is
itself a link is refused as before. `src/lib/config-ownership-removal.ts` resolves every manifest
entry from that root. Immediately before
each unlink, directory listing and rmdir it lstats every directory from the root down to the entry's
parent. Each must be a real directory, not a symlink, junction or other reparse point, and the
root must still resolve to itself while the parent's realpath stays inside it (names are not compared
as strings, so a case- or normalization-insensitive volume may store them in another spelling). An entry that fails stays in
place and is reported as the residual path; the run ends partial with the tombstone kept, so a rerun
resumes once the directory is fixed. A link on the way to an entry, or a lookup that fails for any
reason other than absence, is reported the same way. Links are never followed, even toward a location inside the
root. A final-component link is unlinked itself, never its target. Inside an owned directory every
child repeats the check, and so does the final rmdir.

An elevated uninstall (effective uid 0 on POSIX; an elevated token on Windows) runs only when the
directories it touches belong to the running account alone. A Windows token the native probe cannot
read (Bun cannot run `bun:ffi` on ARM64) is checked as elevated, and a refusal then says that
elevation could not be determined.
The config path as given, which the teardown steps before the remover use, must resolve only through
directories no other account can change and links owned by the running account or root, following
each link target the way the kernel does; on Windows it may contain no link at all. A root that does
not exist yet needs its nearest existing directory closed to every other account. Then the canonical
root, its ancestors and every directory in its tree are checked, because teardown steps before the
remover read and write files anywhere in the tree. A link anywhere in the tree, to a file or a
directory, must resolve to the root or inside it through directories and links that pass the same
walk as the given path; on Windows the tree may hold no link at all. On POSIX the root and those
directories must be owned by the effective uid with no group or other write bit, and each ancestor
must be owned by it or by root and not shared-writable unless sticky; on macOS no listed directory
or link, including every one the walk of the given path passed, may carry an ACL allow entry. On
Windows they are read with the `write-private` and
`trusted-ancestry` policies of `src/lib/windows-owner-acl.ts`, in reads of up to 256 paths that each
have their own deadline (above 16 paths the synchronous reader takes them over stdin), so a large tree
costs more reads and is not refused for its size. Link chains are followed up to 40 links, the Linux
limit; a cycle stops there and is refused. Otherwise the run is refused as a whole. `ocx uninstall`
checks this before its first teardown step; the remover checks it again before it takes the lock,
which a refusal there never creates, and once more under the lock before the tombstone, which a
refusal there never writes. During an elevated POSIX run every directory the removal passes through
is held to the same owner and mode rule.

Each check describes the filesystem at the moment it runs. Bun and Node expose no
directory-handle-relative unlink, so the guarantee does not extend to a concurrent change made by the
same account between a check and the removal that follows it.

`tests/config/config-ownership-concurrent-record.test.ts` covers concurrent registrations, a
registration racing uninstall, the tombstone refusal for cached paths, a rerun after an interrupted
uninstall or a leftover lock file, the busy lock, a home without metadata, and log rotation.
`tests/config/config-ownership-removal.test.ts` and `tests/config/config-ownership-uninstall.test.ts`
cover linked and dangling parents, unreadable entries, a directory replaced after it is listed,
final-component links, aliased roots, and the elevated refusal.
