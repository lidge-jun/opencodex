# Claude Desktop Integration

## Connected Claude Desktop profiles

Connected `ocx claude desktop apply` reads the hub's Desktop snapshot and writes the hub origin
and exact hub-issued IDs to the local Desktop configuration. Static/hybrid embed the entries;
discovery-only keeps discovery on the hub. The hub owns family assignments and defaults; local
show/edit/import/export operations do not manage that profile. After hub changes or historical
client-only aliases, apply again and reselect the model. Connected `import --apply` is explicitly
unsupported and refuses before saving the import.

`src/claude/desktop-discovery-inputs.ts` owns the shared Desktop discovery projection used by
startup registry initialization and server discovery. `src/server/index.ts` exposes the explicit
`GET /v1/models?ids=desktop&format=desktop-config` snapshot, shaped as `{version:1,models:[...]}`
and sent with `Cache-Control: no-store`. `src/client/hub-client.ts` downloads it with the existing
data credential; `src/cli/claude-desktop.ts` selects connected apply, and `src/claude/desktop-3p.ts`
writes the resulting local Desktop configuration. No admin token, hub-profile upload or local
alias regeneration is part of this flow. Unsupported old hubs, invalid snapshots and unavailable
Desktop models fail apply without a local-catalog or loopback fallback.

Date-shaped Desktop IDs can overlap genuine native model IDs. When available discovery and
mapping evidence cannot resolve one, Messages and count-tokens return HTTP 503 with the fixed
`desktop_model_mapping_unavailable` error rather than classifying it as invalid. Unknown legacy hash aliases
remain HTTP 400; neither case reaches date-stripping or fallback routing. Known/registered IDs,
exact operator mappings and recognized native IDs keep their existing handling. Discovery refresh
or reapplying the connected hub profile may supply the missing mapping; retry alone does not
guarantee resolution.

The remote-alias slice does not change thinking/redacted-thinking replay or prompt-cache
behavior. Those remain the separate request tracked in #3719; proxy admission alone does not
establish native Anthropic passthrough or imply that translated Anthropic caching is disabled.

### Desktop ownership across the connection lifecycle

`src/claude/desktop-remote-store.ts` owns the first protected restoration baseline and the
connection-owned Desktop fields. `src/cli/claude-desktop.ts` handles connected apply, while
`src/client/connect.ts` coordinates key rotation/recovery and disconnect. Reapply and rotation retain the original
baseline. Restoration merges into current user fields, preserves unrelated profiles, and restores
the previous selection only while the managed profile is still selected. A later valid user
selection is not changed. A newly created profile with user additions is retained in readable
standard mode instead of deleting those additions.

A proven legacy current-hub/recognized-key profile without an original baseline can be adopted
by apply, rotation/recovery or direct disconnect without a new flag or prerequisite reapply.
Its explicit standard-fallback outcome is distinct from original restoration: only owned gateway
settings are removed, with user fields and independent valid selection preserved. Unknown keys,
changed managed fields or damaged restoration records remain conflicts, not permission to capture
new originals or overwrite user data.

Rotation changes credentials without changing model IDs, family/default choices or selecting the
managed profile again. The CLI reports `rotation: "committed"` only for the new active generation;
`rotation: "rolled_back"` means the previous generation was retained/restored and must not claim
revocation of that previous key. Incomplete recovery keeps the operation unresolved. Disconnect
restores Desktop even with `--keep-catalog`; retries preserve the original catalog choice and must
not clear a newer connection. Authorized uninstall completes or resumes owned Desktop cleanup
before removing OpenCodex state, and preserves recovery state when cleanup conflicts or fails.

These guarantees concern files on disk. Fully quitting and reopening Desktop is required after
apply, rotation/recovery or restoration; there is no automatic process restart or guarantee that
a running app discarded a key. Local disconnect does not revoke the hub key or remove arbitrary
external copies. Model-list snapshot version 1 remains a read-only contract, not a new lifecycle
or profile-upload API. Thinking replay and prompt caching remain separate in #3719.

## Claude Desktop config-library resolution

The Desktop profile writer and the management status probe share
`resolveDesktop3pConfigLibraryPath`. The resolver reproduces Desktop's own rule rather than a guess:
an explicit `CLAUDE_USER_DATA_DIR` (or the opencodex override) wins; on Windows
`%LOCALAPPDATA%\Claude-3p` wins; otherwise the Electron user-data path gains a `-3p` suffix if it
does not already have one. `configLibrary` is appended to that root.

`Claude-3p` is Desktop's real directory name, assembled at runtime from `"Claude" + "-3p"`, which is
why searching the app bundle for the literal string finds nothing. It is not a legacy path to migrate
away from. Resolution stays a pure function of (env, platform, home) so the Windows branch is
testable on any host: stubbing `process.platform` does not propagate to `os.platform()` under Bun.

> Decision record: [ADR-0046](../decisions/ADR-0046-claude-desktop-config-library-resolution.md)
