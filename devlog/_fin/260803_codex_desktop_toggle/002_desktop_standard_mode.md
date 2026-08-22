# Claude Desktop: standard mode is documented, so disable is buildable

Research doc. This one overturns the load-bearing conclusion of
`../../_fin/260803_integrations_toggle_all/001_removal_path_inventory.md` §Claude Desktop.

## What the previous conclusion got right, and where it overreached

Right, and re-confirmed here:

- `apply` sets `_meta.json`'s `appliedId` to our id **unconditionally** and never
  records the previous value (`src/claude/desktop-3p.ts:345,358`). Exact
  "put back whatever was selected before" is impossible from our bookkeeping.
- `<id>.json.bak` holds the previous profile, and that profile carries
  `inferenceGatewayApiKey` — so the backup can contain a credential and nothing
  cleans it up (`src/claude/desktop-3p.ts:371`).
- `/status.applied` is derived from the saved fingerprint, not from actual
  selection (`src/server/management/agent-settings-routes.ts:797`), so a disable
  that forgets to clear the markers keeps reporting `applied: true`.
- `desktopAutoApply` is enabled by ABSENCE (`src/types.ts:458-459`); its guard
  suppresses only an explicit `false`, and the subagent-model update route can
  re-create a removed profile (`agent-settings-routes.ts:130,518`).

The overreach was treating "cannot restore the exact prior selection" as
"cannot safely disable". **Those are different requirements**, and only the
first one is blocked.

## The official semantics that make disable safe

Primary Anthropic documentation, opened and read (not inferred from our devlog).
Dates are deliberately omitted: the sitemap `lastmod` values originally recorded
here are not visible on the pages themselves, and an independent reviewer could
not confirm them. The semantic claims below WERE independently re-verified by
that reviewer, twice.

- [Configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration)
- [In-app configuration](https://claude.com/docs/third-party/claude-desktop/in-app-configuration)
- [Claude API provider](https://claude.com/docs/third-party/claude-desktop/claude-api)
- [Gateway provider](https://claude.com/docs/third-party/claude-desktop/gateway)

The load-bearing sentence: third-party mode activates **only** when
`inferenceProvider` and that provider's required credentials are valid;
otherwise Desktop launches in **standard mode**. Configuration is read once at
launch.

That is a documented contract we can aim at deliberately. We do not need to
guess what Desktop does with a missing or dangling `appliedId` — we can point it
at a configuration that is *present, readable, and deliberately without an
`inferenceProvider`*, which the docs say yields standard mode.

## What stayed UNPROVEN, and why it no longer blocks us

| Question | Status |
|---|---|
| Is there a documented "return to standard" UI button? | UNPROVEN |
| What happens when `appliedId` is absent? | UNPROVEN |
| What happens when `appliedId` dangles? | UNPROVEN |
| Is a `Default` entry guaranteed? | UNPROVEN |

The design simply avoids all four. It never deletes `appliedId`, never leaves it
dangling, and never selects an entry merely because it is named `Default`.

This machine proves why that last guard matters: the real `_meta.json` has a
`Default` entry **whose `<id>.json` does not exist**. A disable that "just picks
Default" would have pointed Desktop at a missing file. The one observation the
earlier RCA generalized from was the exception, not the rule.

The installed Desktop bundle (v1.18286.0) does appear to seed a `Default`/`{}`
profile when metadata does not yet exist, and its current reader does fall back
when the selected file is unreadable — but that is a bundle observation, not a
contract, and it does not upgrade any row above.

## `default` is not the restore verb

The hypothesis worth testing was that `ocx claude desktop default` already
performs an official restore. It does not.

`default <family> <route|none>` sets the default model **inside one opencodex
model family** (opus/fable/sonnet/haiku) via `setDesktopFamilyDefault`, saves
`claudeCode.desktopProfile`, and returns without touching Desktop's config
library or `appliedId` at all (`src/cli/claude-desktop.ts:148`,
`src/claude/desktop-profile.ts:219`). `move` likewise only edits our own routing
profile (`src/cli/claude-desktop.ts:138`).

Neither is a disable mechanism. The name collides with the concept; the behavior
does not.

## The disable sequence

Ordered so Desktop is never pointed at something missing:

1. Persist `desktopAutoApply: false` **first**, so no concurrent auto-apply
   re-creates what we are about to remove.
2. Write a new opencodex-owned, credential-free configuration — no
   `inferenceProvider` — under a fresh UUID, and set `appliedId` to it.
3. Only then remove the old `opencodex` entry, its `<id>.json`, and its `.bak`
   (the credential-bearing file).
4. Clear `appliedFingerprint` and `appliedAt` so `/status` stops claiming
   `applied: true`.
5. Preserve `desktopProfile.assignments`/`defaults` so re-enabling does not throw
   away the user's model organization. This machine currently has 33 assignments.

Two explicit non-choices: do not route through `inferenceProvider: "anthropic"`,
because that is direct Claude API billing rather than the user's normal
subscription mode; and do not reuse the `default` subcommand.

Because configuration is read once at launch, the disable does not take effect
until Desktop restarts. The consequence dialog must say that plainly rather than
implying an instant switch.

## Residual, deliberately deferred

Recording the previous `appliedId` at apply time is still worth doing, but it now
buys only the stronger feature: "restore exactly whichever *other* third-party
provider was active before opencodex." Returning the user to standard Claude does
not need it. That keeps it out of this unit's critical path.
