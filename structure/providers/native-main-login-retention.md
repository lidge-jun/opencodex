# Native-Main Login Retention

Codex rewrites auth.json in place (truncate, then write), so a reader can briefly see it empty or
half written. `src/codex/native-main-credentials.ts` classifies every native-main read through the
shared reader as complete, incomplete (empty or unparseable), no-login (well-formed without a ChatGPT
access or refresh token), missing or unreadable, and keeps the last complete login per CODEX_HOME,
auth path and file identity (#7345, owner's second contract). Only an incomplete observation may be
answered from it, and only by `getMainAccountCredentialStatus` and the initial read of
`getValidMainAccountToken` / `forceRefreshMainAccountToken` in `src/codex/main-account.ts`.

File identity is the dev/ino stat'ed before and after the read; if they differ, the identity is null
and nothing is retained or served. On POSIX the retained entry keeps a read-only descriptor open on
the file it came from. That pins the inode number, so a deleted and recreated file always gets a new
one, even on filesystems that reuse numbers (ext4, XFS), and a retained file whose link count reached
zero is never served. Windows holds no descriptor, because an open handle could block Codex's
delete; NTFS file IDs carry a sequence number.

There is no time window for an observed event. Each of these ends retention at once, and the dropped
copy is never revived; only a later complete read retains again:

- a missing observation (a missing file is unavailable unless the Codex RPC confirms a login; see [native-main refresh ownership](openai-accounts.md#native-main-refresh-ownership)),
  a no-login observation, or an unreadable file;
- account replacement: another OpenCodex credential publication (`advanceCodexCredentialMutationEpoch`),
  a different file identity, an unlinked retained file, or a complete file naming another login;
- revocation (`markMainRefreshGrantRejected`, `markAccountNeedsReauth` for `__main__`, a rejected grant
  on the retained login) and pause (`setCodexAccountPaused` for `__main__`);
- a refresh-owner change. A retained entry records the configured `nativeMainRefresh` value. Config
  is loaded only when a new login is retained or a retained one is about to be served, and a
  different configured value ends retention before it is served. A different resolved owner
  reported by `resolveNativeMainRefreshMode` also ends it;
- ownership loss: another home or path, the `src/codex/native-main-owner.ts` lock leaving `held`, or
  native-main traffic blocked by startup or recovery;
- upstream rejecting the retained bearer in a forced refresh.

Retention cannot see what no read observes. If Codex rewrites the same file in place to another
login (for example `codex login` over an existing login) and no read lands between the old login
and the rewrite window, an incomplete read during that window can still return the old login, once,
until the next complete read. A logout that deletes the file always gets a new identity.

Every invalidation bumps a generation. A refresh captures its ticket before the token exchange,
and retains the published login only if no invalidation happened meanwhile, so a completion after
ownership loss cannot repopulate retention. A retained bearer that is expired (or the one upstream
rejected) is discarded before use, and the credential status does not report it usable, so the
selected refresh owner decides exactly as for an unavailable file. The guarded writer cannot refresh
a file mid-rewrite and reports no credential; Codex mode asks the RPC. Write guards (the pre-rename
snapshot check and native device reauth) read the physical file and never retain.
`tests/codex-integration/native-main-credentials-retention.test.ts` pins each fixture and each
invalidation hook, except the traffic-blocked branch, which has no test seam.
`tests/codex-integration/native-main-refresh-mode.test.ts` remains the refresh-owner parity check.
