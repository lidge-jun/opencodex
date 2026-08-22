# Fork path ownership

Agents read this before resolving sync conflicts. Three-way merge: base = last common ancestor; **ours** = `origin/main`; **theirs** = `vendor/main`.

Do not open this document or the fork overlay as an upstream PR.

## Path classes

### `fork-owned` — default take ours

Files only this fork adds or maintains:

| Path |
|---|
| `src/fork/**` |
| `tests/fork/**` |
| `docs/fork/**` |
| `.cursor/skills/opencodex-fork-sync/**` |
| `scripts/fork/**` |
| `.github/workflows/fork-upstream-sync.yml` |
| `.github/workflows/fork-pr-mergeable.yml` |

### `shared-hotspot` — manual / agent report

Upstream and overlay both touch wire protocol or core request path. Serialize merges on `google` adapters and `responses/core.ts` (never two workers at once).

| Path |
|---|
| `src/adapters/google*.ts` |
| `src/server/responses/core.ts` |
| `src/providers/antigravity-quota.ts` |
| `src/providers/quota.ts` (Antigravity quota probe path) |

Keep upstream control flow; re-fit fork behavior. Never “accept all ours” on these files.

The established shared-hotspot defaults are:

- `src/adapters/google-http.ts`: apply account cooldown first, then host
  failover.
- `src/server/responses/core.ts`: try the Antigravity 429 carousel first, then
  recover the opaque blob.

### `upstream-owned` — default take theirs

Everything not listed above. Re-apply fork intent as a **new small commit** only if still needed after taking upstream.

## Conflict defaults

| Class | Default | Notes |
|---|---|---|
| `upstream-owned` | Take theirs | Re-apply fork intent as a new small commit only if still needed |
| `fork-owned` | Take ours | Files only the fork added |
| `shared-hotspot` | Manual / agent report | Keep upstream control flow; re-fit fork behavior; never “accept all ours” |
| Lockfiles | Take theirs | Regenerate if overlay added deps |
| File deleted by them, edited by us | Decide restore vs abandon | Record in merge message |
| Rename | Follow new path | `--find-renames`; do not keep a zombie old path |
| Upstream shipped the same idea | Drop ours | Duplicate patches cause later impossible conflicts |
| Refactor of a patched function | Port behavior | New `fork:` commit on the new shape; forget the old diff |

Never `git merge -X ours` across the tree.
