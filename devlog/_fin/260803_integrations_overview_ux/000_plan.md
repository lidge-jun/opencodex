# Integrations overview: every client's real state, in one place

## The ask

From the GUI, on `#integrations`:

1. The overview must show the state of **every** integration the page can
   reach — Codex CLI, Claude (Code + Desktop), Grok Build and the API keys
   surface — not only the six file-toggle clients.
2. Clicking a card must move to that client's tab.
3. Claude gets its own sidebar entry back.

## What the page shows today

`IntegrationsOverview` reads exactly one source, `GET
/api/client-integrations`, which answers only for the six file clients
(`opencode`, `pi`, `hermes`, `openclaw`, `kimi`, `gajae`). The summary strip
counts those six. The card grid renders those six. So a user who has Claude
Code connected, Claude Desktop applied and a Grok fence written sees
"감지됨 5 / 적용 중 0" and six cards — the page tells them nothing is applied
while three integrations are live one tab away.

Measured on the running proxy (`127.0.0.1:10100`, admin token from
`~/.opencodex/admin-api-token`), 2026-08-03:

| Source | Route | State right now |
|---|---|---|
| file clients | `GET /api/client-integrations` | 6 rows, all `absent`; `kimi` `installed:false` |
| Claude Code | `GET /api/claude-code` | `enabled:true`, `authMode:"subscription"` |
| Claude Desktop | `GET /api/claude-desktop/status` | `applied:true`, `stale:true`, `activeProfile:true` |
| Grok Build | `GET /api/grok` | `present:true`, 20+ fenced models |
| API keys | `GET /api/keys` | `keys: []` |
| Codex CLI | `GET /api/startup-health` | `status:"at-risk"`, `routingInjected:true`, `serviceRunning:true` |

Three of those are applied. The overview shows none of them.

## Cards are not clickable

The card carries a switch plus a ghost "설정" button that calls
`navigateHash('integrations/<client>')`. The card body itself does nothing —
which is what the user tried, since the card looks like the target. The switch
is the reason the whole card is not a link: nesting an interactive control
inside an anchor is invalid and breaks keyboard semantics.

## Claude left the sidebar

`a56a4aea6` collapsed the API / Claude / Grok pages into one `#integrations`
route and, in the same move, took the Claude connection switch out of the
sidebar — correctly, since a nav row owning a mutation is a trap. The nav
**entry** went with it. Claude Code is the deepest surface in the app (models,
auth mode, sidecars, context windows, Desktop profile) and now costs two clicks
from anywhere.

## Direction

Design Read (mini):

```yaml
name: opencodex-integrations
colors:
  primary: "var(--accent)"
  accent: "var(--accent)"
  background: "var(--raised)"
typography:
  heading: { fontFamily: inherit, fontSize: var(--text-control) }
  body: { fontFamily: inherit, fontSize: var(--text-caption) }
iconography:
  system: "existing gui/src/icons.tsx set"
  weight: "regular"
  domain: "library-subset"
```

Reading this as: a dense operator control surface for a user who runs several
coding clients at once, with a quiet utility language. It is a status board
first and an action surface second — the question it answers is "what is wired
up right now", and it has to answer that without lying by omission.

Do's: reuse the existing badge/card/summary vocabulary; keep every state
string translated in all six locales; keep the file clients' switch behavior
byte-identical.
Don'ts: no new color, no new card style, no motion, no emoji.

```
DESIGN_VARIANCE: 3
MOTION_INTENSITY: 1
Product density profile: D5
Reasoning: dashboard/admin surface for repeated operator work — the preset is
V3/M2/D5, and this is a status board inside an already-built design system, so
variance drops one more notch and motion stays at feedback-only.
```

Concept generation (UX-CONCEPT-GEN-01) is **skipped**: this is a utility
dashboard surface governed by an existing design system, which the skill names
as an explicit skip. Recorded rather than silently omitted.

## Work phases

| Phase | Doc | Deliverable |
|---|---|---|
| WP1 | `010_wp1_status_aggregation.md` | One client-agnostic status model + adapters for the five non-file surfaces |
| WP2 | `020_wp2_overview_surface.md` | Overview renders all clients, cards navigate, summary counts everything |
| WP3 | `030_wp3_sidebar_claude.md` | Claude sidebar entry (navigation only) + route plumbing |

Each phase is one full PABCD cycle and closes with `bun run typecheck` plus its
own focused GUI test.

## Criteria

- C1 — `#integrations` overview lists Codex CLI, API keys, Claude Code, Claude
  Desktop, Grok Build and the six file clients, each with a state badge derived
  from its own route.
- C2 — the summary counts reflect all listed clients, not just the file six.
- C3 — activating a card (click, Enter, Space) selects that client's tab and
  updates the hash; the switch and the settings button keep working and do not
  double-fire the card.
- C4 — the sidebar has a Claude entry that navigates to `#integrations/claude`
  and marks itself current while any Claude tab is open. It carries no
  mutation.
- C5 — `bun run typecheck`, the GUI integration tests and `bun run lint:gui`
  are green; no locale loses a key.
