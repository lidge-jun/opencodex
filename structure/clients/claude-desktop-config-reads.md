# Claude Desktop Configuration Reads

Every read of Desktop library configuration — selected-profile inspection, `_meta.json` parsing,
foreign-key preservation during writes, refresh mode re-resolution, the refresh fingerprint hash,
the picker profile's inspection and apply snapshots, and the connection-owned store's metadata and
profile reads — goes through the shared verified regular-file reader in
`src/claude/desktop-3p-library.ts` (`readDesktopLibraryBytes`/`readDesktopLibraryText`). The path
`lstat` must already name a regular file; on POSIX the open is nonblocking and no-follow, so a path
swapped to a FIFO cannot turn an observation into a blocking read and a swapped symlink is not
followed; the opened descriptor must still be a regular file whose bigint device, inode and change
time match the path observation before its bytes are read, and it is always closed. Windows keeps
the same path-and-descriptor identity check without the POSIX-only open flags. A non-regular or
swapped path throws `desktop_config_not_regular`, including a swap that surfaces only at open (a
symlink's `ELOOP`, a socket's `ENXIO`, a deletion's `ENOENT`): the failed open re-observes the path
and reports the documented refusal whenever it no longer names the expected file, while a same-path
failure keeps its own errno. Inspection reports the refusal through its existing
`metadata_unreadable`/`broken` outcomes and the writer through its existing refusals; `StoreIO.read`
in `src/claude/desktop-remote-store-io.ts` layers its size cap, private-file mode and post-read
identity contract on top of the same read and reports it as `unsafe`.

Tests: `tests/clients/desktop-3p-removal.test.ts`, `tests/clients/desktop-remote-store.test.ts`, and
`tests/claude-integration/claude-desktop-picker-profile.test.ts`.
