# Claude Desktop Configuration Reads

Every read of Desktop library configuration — selected-profile inspection, `_meta.json` parsing,
foreign-key preservation during writes, backup creation and rollback, refresh mode re-resolution, the refresh fingerprint hash,
the picker profile's inspection and apply snapshots, and the connection-owned store's metadata and
profile reads — goes through the shared verified regular-file reader in
`src/claude/desktop-3p-library.ts` (`readDesktopLibraryBytes`/`readDesktopLibraryText`). The path
`lstat` must already name a regular file; on POSIX the open is nonblocking and no-follow, so a path
swapped to a FIFO cannot turn an observation into a blocking read and a swapped symlink is not
followed; the opened descriptor must still be a regular file whose bigint device, inode and change
time match the path observation before its bytes are read, and it is always closed. The path is
checked again after reading. Windows keeps the same path-and-descriptor identity check without
the POSIX-only open flags. A non-regular or
swapped path throws `desktop_config_not_regular`, including a swap that surfaces only at open (a
symlink's `ELOOP`, a socket's `ENXIO`, a deletion's `ENOENT`): the failed open re-observes the path
and reports the documented refusal whenever it no longer names the expected file, while a same-path
failure keeps its own errno. Inspection reports the refusal through its existing
`metadata_unreadable`/`broken` outcomes and the writer through its existing refusals; `StoreIO.read`
in `src/claude/desktop-remote-store-io.ts` layers its size cap, private-file mode and post-read
identity contract on top of the same read and reports it as `unsafe`.

Optional metadata and profile reads treat only a missing directory entry as absent. Dangling links
and other read failures refuse before profile publication. A gateway apply captures one profile
snapshot (`readDesktopProfileSnapshot`); those verified bytes supply the preserved foreign keys,
the `.bak` copy, and rollback. Before backup and again in the no-follow writer's pre-rename hook,
the verified optional reader compares the live bytes with that snapshot (including absence).
Drift refuses with `desktop_profile_changed`, without retrying; a non-regular entry still refuses
without opening a FIFO or following a link. Drift detected before backup leaves the backup and
metadata untouched; drift during temp staging leaves the concurrent live profile and metadata
untouched. These are bounded optimistic checks, not a filesystem transaction with external writers.
When metadata publication fails, rollback restores the captured bytes without reopening the
backup; a profile the same apply created is removed instead. Rollback is ownership-aware: the same
compare-and-swap helper (`assertDesktopProfileUnchanged`) checks that the live profile still holds
the bytes this apply published, before acting and again before the restore rename. If another
writer changed it, rollback is skipped, that profile is preserved, and the metadata error is
reported with "profile rollback skipped". A failed rollback keeps the metadata error as the
primary cause and reports that profile rollback also failed. An absent profile does not adopt a
leftover backup from an earlier operation.

The reader defaults to a 4 MiB profile and metadata limit (`MAX_DESKTOP_PROFILE_FILE_BYTES`). It
checks the opened size before allocation and reads no more than the bound plus one sentinel byte;
oversized input raises `desktop_config_too_large`. `StoreIO.read` in
`src/claude/desktop-remote-store-io.ts` passes its tighter limit to the same reader and retains its
private-file mode and post-read identity checks, reporting reader refusals as `unsafe`.

`serializeDesktopLibraryJson` checks the UTF-8 byte length of the formatted JSON, including its
trailing newline, against the same 4 MiB limit. Gateway apply in `src/claude/desktop-3p.ts`
preflights the generated profile and metadata before replacing either; refresh preflights its
generated profile while leaving metadata unchanged. Picker apply in
`src/claude/desktop-picker-profile.ts` preflights metadata before its backup and profile writes.
Gateway and picker removal preflight the pivot and final metadata before creating a standard
profile, changing the selected row or unlinking profiles and backups. A serialization size refusal
therefore leaves the existing library files in place.

Tests: `tests/clients/desktop-3p.test.ts`, `tests/clients/desktop-3p-write-files.test.ts`, `tests/clients/desktop-3p-removal.test.ts`, `tests/clients/desktop-remote-store.test.ts`, and
`tests/claude-integration/claude-desktop-picker-profile.test.ts`.
