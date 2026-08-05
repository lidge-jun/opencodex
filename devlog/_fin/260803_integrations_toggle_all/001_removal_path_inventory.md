# What can be turned off today, and what it costs

Research pass. No diffs here — the phase docs own those.

Sources: direct reads of `src/codex/inject.ts`, `src/codex/journal.ts`,
`src/grok/inject.ts`, `src/claude/desktop-3p.ts`, `src/claude/desktop-3p-paths.ts`,
`src/service.ts`, `src/cli/index.ts`, plus two dispatched read-only explorers whose
findings are cited inline and were spot-checked against the files.

## The four, at a glance

| Client | Disable exists? | Reachable from the GUI? | Restorable today? |
|---|---|---|---|
| Claude Code | yes — `PUT /api/claude-code {enabled}` | yes, but only inside the Claude tab | n/a, it is a config flag |
| Grok Build | yes — `stripGrokConfig()` | **no** | partly — a one-time `.bak` from apply, not from strip |
| Codex | yes — `restoreNativeCodex()` | **no** | yes — `$CODEX_HOME/opencodex-journal.json` holds the pre-injection bytes |
| Claude Desktop | **no such code anywhere** | no | **no** |

## Claude Code — a config flag; no EXTERNAL file

`config.claudeCode.enabled` is read at six call sites; `false` makes
`/v1/messages` answer 403 and stops agent injection and system-env injection
(`src/server/claude-messages.ts:66`, `src/server/index.ts:496`,
`src/claude/agents-inject.ts:249`, `src/server/system-env.ts:253`,
`src/cli/claude.ts:238`).

No file outside opencodex is touched — but the toggle does write **our own**
`config.json`, so "nothing on disk" (the rev-1 wording) was wrong and is
corrected here: the distinction is external-client file vs. any disk write. It
still snapshots, because one contract across four clients beats a special case
that reads "this one is not recoverable".

## Codex — journal-backed, and it is not just `config.toml`

`injectCodexConfig` (`src/codex/inject.ts:481`) writes the pre-injection bytes to
`$CODEX_HOME/opencodex-journal.json` (base64 `originalConfig`, optional
`originalProfile`, plus hashes of what it wrote) BEFORE mutating anything, then
writes `config.toml` and `opencodex.config.toml`.

`restoreNativeCodex` (`src/codex/inject.ts:764`) is a three-tier fallback:

1. An external `model_provider` is active → drop the journal, touch nothing, and
   say so. Somebody else owns the routing.
2. Journal hashes still match what we wrote → restore the exact original bytes.
3. The user edited since → do NOT replace wholesale; strip only recognized
   opencodex fragments (`stripInjectedOpenaiBaseUrl`, `[model_providers.opencodex]`,
   the profile section, `model_provider = "opencodex"`, the catalog path) and keep
   their edits.

Blast radius is wider than the config file. A restore can also touch the model
catalog (`readCodexCatalogPath()`, backed up at
`<config dir>/catalog-backup-<path-hash>.json`) and, for legacy history retagging,
`$CODEX_HOME/state_5.sqlite`.

Two findings that change what the dialog may promise:

- **There is no ownership refusal on `getCodexRoutingKind()`.** I expected one.
  Safety comes from marker-level ownership instead — `if (!markerOwned) return
  { content, keptUserBaseUrl: true }` (`inject.ts:153`) — so a user's own
  `openai_base_url` survives. But health diagnostics actively RECOMMEND `ocx
  restore` for `custom-local` and `unknown` (`autostart-health.ts:86`), so there
  is no "this is not ours, refuse" contract to lean on.
- **A running Codex app-server may not pick up the change.** The file mutation
  needs no proxy restart, and a newly launched `codex` reads the new config. But
  `app-server-processes.ts:546` proves long-lived app-servers hold their catalog
  in memory, and nothing proves an existing app-server re-reads
  `openai_base_url`. The dialog must not promise an already-open Codex session
  switches immediately.

## Grok — fence-scoped, and the backup is on the wrong side

`stripGrokConfig` (`src/grok/inject.ts:449`) removes exactly the marked region
plus the one separator newline injection added, concatenates the bytes either
side, and restores the file's dominant EOL. User content outside the fence is
preserved byte-for-byte.

**It takes no backup.** The `config.toml.bak-opencodex` copy is made once by
*injection*, before its first write to an existing config
(`inject.ts:261`, `inject.ts:431`), and is never overwritten. So the safety net
exists for "opencodex first touched this file", not for "opencodex is removing
its block now". A GUI disable needs its own snapshot.

Refusal shapes, from `GrokInjectResult` (`inject.ts:13`):

| `skippedReason` | `ok` | Meaning |
|---|---|---|
| `no-grok-home` | true | Grok is not installed — a state, not an error |
| `orphaned-marker` | **false** | begin marker without an end marker; the deletion boundary is ambiguous so BOTH inject and strip refuse |
| `non-loopback` | true | auto-registration is loopback-only |

`orphaned-marker` is the one that must reach the user as an explained refusal:
it means we will not guess where our block ends, and the file is untouched.

## The guard I described wrong

I previously told the user that `ocx stop` refuses to strip the Grok fence
"while an installed service is still running". That is not the condition.

The real trigger is `ServiceOwnershipError` (`src/service.ts:216`): the installed
service's recorded `CODEX_HOME` or `OPENCODEX_HOME` does not match the current
process's. An ordinary stop failure logs a warning and does NOT set
`ownershipBlocked` (`src/cli/index.ts:464`). So it is a **different-home**
guard, not a **service-running** guard — a service running under the SAME home
does not block teardown at all.

That distinction matters for the dialog copy: telling a user to stop their
service would be useless advice for a home-mismatch problem.

## Claude Desktop — apply-only, and the hard problem of this unit

Confirmed by exhaustive search: **no removal, restore, uninstall, or cleanup code
exists** for Desktop anywhere in `src/`, `scripts/`, or `tests/`. The CLI exposes
`apply, show, move, default, export, import` (`src/cli/claude-desktop.ts:22`) and
nothing else. Neither `ocx stop` nor `ocx uninstall` mentions it. It is not routed
through `src/integrations/` at all.

What an apply writes, under `<userDataRoot>/configLibrary/`:

```
configLibrary/
├── _meta.json          ← Claude Desktop OWNS this; we mutate it
├── <opencodex-id>.json ← we own this
└── <opencodex-id>.json.bak  ← we create this, overwritten every apply
```

`_meta.json` mutation (`desktop-3p.ts:345`): reuse the first row whose
`name === "opencodex"` or append one, preserve unknown fields through spreads,
and **unconditionally** set `appliedId` to our id.

That last word is the problem. **Apply does not record the previous
`appliedId`.** So exact "put it back the way it was" is impossible from current
bookkeeping — the information was never captured.

And a naive delete is worse than nothing. Desktop's reader resolves
`appliedId` and then opens exactly `<appliedId>.json`
(`devlog/_fin/260727_bug_triage_loop/003_claude_desktop_path_rca.md:106`):

```js
let t = JSON.parse(readFileSync(metaPath, "utf8"))?.appliedId;
return JSON.parse(readFileSync(profilePath(t), "utf8"));
```

Delete our `<id>.json` while `appliedId` still points at it and Desktop reads a
file that is not there.

What the repo does NOT prove, and we must not assume:

- that every install has a `name === "Default"` entry to fall back to;
- that an absent `appliedId` triggers a safe Desktop default;
- that a dangling `appliedId` is tolerated;
- which surviving profile to pick when several exist.

One real observed `_meta.json` had a `Default` row alongside ours, and choosing
Default in the app moved `appliedId` to it (same RCA, line 116) — evidence that
the app rewrites the field itself, not evidence that a Default always exists.

Three more removal obligations:

- `<id>.json.bak` survives a delete of `<id>.json` and **contains an API key**.
  Nothing cleans it up today.
- `appliedFingerprint` and `appliedAt` in `config.claudeCode.desktopProfile` must
  be cleared, or `/status` keeps reporting `applied: true` — that field is
  literally `savedFingerprint !== null` (`agent-settings-routes.ts:797`).
- `desktopAutoApply` defaults ON whenever a stored `desktopProfile` exists
  (`agent-settings-routes.ts:130-151`), and its guard is the first line of
  `autoApplyDesktopBestEffort`. The rev-1 claim that "a provider change"
  triggers it was too broad: the located caller is the subagent-model route
  (`agent-settings-routes.ts:518-528`). The suppression is still required — that
  one caller is enough to recreate a removed profile — but the trigger is
  narrower than first stated.

## Reusable machinery

`src/integrations/journal.ts` and `ownership.ts` are close to client-agnostic:
`captureSnapshot`, `appendOperation`, `readSnapshot`, `pruneSnapshots`,
retention, path-escape guards, and 0600 + Windows ACL hardening on snapshot
writes. The only coupling is the `IntegrationClientId` type, which is
`ExportClientId` — the six file clients.

`writer.ts` is NOT reusable: `applyIntegration`/`disableIntegration` are built
around parse → merge fragments → serialize, which is meaningless for a TOML
fence, a base64 journal, or a profile registry.

So the shape is: widen the journal/snapshot substrate to a superset id type,
reuse it wholesale, and give each native client its own small writer that
snapshots through the shared store before delegating to the existing
`stripGrokConfig` / `restoreNativeCodex` / new Desktop remover.
