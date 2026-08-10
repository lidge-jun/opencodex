# WP4 — Claude Desktop, the hybrid

Direction: `006_replan_semantic_restore.md`. The riskiest phase: it writes into
another application's state directory, there is no removal path in the repo to
start from, and it is the one operation where bytes and semantics are both
required.

## Two mechanisms, one operation

| What | Mechanism | Why not the other |
|---|---|---|
| `<library>/<id>.json`, `_meta.json`, `.bak` | **bytes** | `_meta.json` is Desktop's registry, holds rows we do not own, and records an `appliedId` we never captured at apply time. We cannot re-derive the user's previous selection semantically — the information only exists as those bytes. |
| `desktopAutoApply`, `appliedFingerprint`, `appliedAt`, `appliedProfileId` | **semantic** | They live in opencodex's `config.json` beside every other setting. Restoring that file byte-for-byte would revert provider edits and account changes made after the disable (audit r3 #4). |

Saying this plainly is the point. Earlier revisions tried to make one mechanism
cover both and produced either a dangling `appliedId` or a config rollback that
ate unrelated settings.

## IN

1. `src/claude/desktop-3p.ts` — MODIFY: add `removeDesktop3pConfig`.
2. `src/types.ts` — MODIFY: `appliedProfileId?: string`.
3. `src/claude/desktop-profile.ts` — MODIFY: parse and carry the new field
   (audit r2 #6 — without this the ownership proof evaporates on the next
   config reload).
4. `src/integrations/native/claude-desktop.ts` — NEW.
5. `tests/desktop-3p-removal.test.ts` — NEW.
6. `tests/desktop-profile-applied-id.test.ts` — NEW.

OUT: `generateDesktop3pConfig`, `buildDesktop3pRegistry` — pure, uninvolved.

## Ownership must be proved

Apply identifies its own row by `name === "opencodex"`
(`desktop-3p.ts:345-352`). That is a display name in another app's registry, and
a user can choose it. Two independent proofs are required before removal touches
anything (audit r1 #7):

1. **A persisted id** — apply records what it wrote as
   `config.claudeCode.desktopProfile.appliedProfileId`.
2. **A payload marker** — the profile parses and carries our gateway shape:
   `inferenceProvider: "gateway"` with a loopback `inferenceGatewayBaseUrl`.

Rows named `opencodex` that are not the persisted id are refused as
`unowned_profile`, not adopted.

**Legacy installs are refused, not guessed** (audit r2 #5). A profile applied
before `appliedProfileId` existed has only the name and a generic gateway shape,
both user-constructible. It refuses `legacy_profile_unverified` with the one
action that resolves it — re-apply, which writes the id and makes removal
provable. The user is never stuck and we never delete on a guess.

## Removal order, and its inverse

Removal: repair `_meta.json` first, delete the profile second. A crash between
them leaves an unreferenced file, which is inert. The other order leaves a
reference to nothing, which is what Desktop chokes on — it resolves `appliedId`
then opens exactly `<appliedId>.json`
(`devlog/_fin/260727_bug_triage_loop/003_claude_desktop_path_rca.md:106`).

Undo runs the inverse: profile and `.bak` back first, then `_meta.json`, then
the config fields. **At no instant does `_meta.json` name a file that is not
there** — the invariant both directions preserve, and the one the tests assert.

### `appliedId` repair

- Pointed at us, a survivor exists → the first surviving entry **whose profile
  file actually exists**. Checking existence matters: pointing at another
  registry row whose file is already missing would move the dangling pointer,
  not fix it.
- Pointed at us, no usable survivor → **refuse** `no_safe_desktop_fallback`.
  Dropping the key is unproven behavior in someone else's application
  (`001` §What the repo does NOT prove), and guessing with it is not ours to do.
- Pointed at someone else, or absent → untouched. Our removal is not a reason to
  change the user's selection.

## Bookkeeping, or the toggle un-toggles itself

Two fields, both required for the disable to mean anything:

- `appliedFingerprint`/`appliedAt` cleared — `/status` reports `applied` as
  literally `savedFingerprint !== null` (`agent-settings-routes.ts:797`), so a
  kept fingerprint keeps claiming the integration is applied after we removed it.
- `desktopAutoApply: false` — its guard is the first line of
  `autoApplyDesktopBestEffort` (`agent-settings-routes.ts:130-151`), whose
  located caller is the subagent-model route. Without this, that route recreates
  the profile we just removed.

`desktopProfile` itself is KEPT: it holds the user's model assignments, and
discarding those would cost far more than the toggle implies.

All four go back through `saveConfigPreservingClaudeCode`, which merges the
`claudeCode` subtree against disk rather than replacing the file — the mechanism
that makes a semantic restore safe here.

## Failure classification

An unreadable or unparseable `_meta.json` is `unsafe`, never `unowned_profile`
(audit r2 #10). Telling a user to sort out ownership when their file is corrupt
sends them to the wrong problem.

A deletion that fails after the metadata write returns `partial` with both
residual paths: the registry no longer lists a profile whose file is still on
disk, and reporting "nothing happened" would be the exact lie audit r1 #2 named.

## Tests

`OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR` redirects the library verbatim
(`desktop-3p-paths.ts:69`), so every case runs against a `mkdtempSync` dir.

| Case | Assertion |
|---|---|
| Ours applied, `Default` sibling exists | `appliedId` becomes Default's id; its row and file untouched |
| Ours is the only entry | REFUSES `no_safe_desktop_fallback`; nothing deleted |
| Survivor row exists, its file does not | REFUSES; the pointer is not moved to another dangling target |
| `appliedId` points elsewhere | unchanged; only our row and file go |
| Row named `opencodex`, not the persisted id | REFUSES `unowned_profile` |
| Persisted id present, marker missing | REFUSES `unowned_profile` |
| Legacy: no persisted id | REFUSES `legacy_profile_unverified` |
| `_meta.json` unparseable | REFUSES `unsafe`; deletes nothing |
| Delete fails after metadata write | `partial` with both residual paths |
| `.bak` present | deleted with its profile |
| Unknown top-level fields | preserved identically after re-parse |
| **Round trip** | apply → disable → undo → profile, `.bak`, `_meta.json` byte-identical AND the four config fields back |
| **Config isolation** | an unrelated config edit between disable and undo SURVIVES the undo (audit r3 #4) |
| **Invariant** | after any undo, `appliedId` resolves to a profile file that exists |
| **Schema survival** | apply → reload config → edit an assignment → disable: `appliedProfileId` survives every step |
| Auto-apply | after disable, the subagent-model route does not recreate the profile |

The config-isolation row is the one that proves the replan was right: under the
retired byte design it would have failed.

## Acceptance

- [ ] Every table row passes.
- [ ] Library bytes restore before `_meta.json`; config fields restore last.
- [ ] The invariant holds after every undo.
- [ ] Ownership needs the persisted id AND the marker; legacy refuses.
- [ ] A corrupt `_meta.json` refuses `unsafe`, never `unowned_profile`.
- [ ] `appliedProfileId` survives parse and reconciliation.
- [ ] `/api/claude-desktop/status` reports `applied: false` after a disable.
- [ ] `bun run typecheck` and the existing Desktop tests green.
