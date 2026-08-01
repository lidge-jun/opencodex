# 050 — WP5: a Grok surface in the dashboard

Depends on WP3 so the tab reports the corrected context windows rather than
teaching users the wrong number in a new place.

## What exists today

The Grok Build integration is CLI/config-only:

| Piece | Location |
|-------|----------|
| managed-block inject/strip for `~/.grok/config.toml` | `src/grok/inject.ts:130`, `:170`, `:251` |
| catalog sync on start/ensure/restart | `src/grok/sync.ts:29` |
| management API | **none** — `rg '"/api/grok'` over `src/server/` returns nothing |

So there is no read surface for the GUI to render. This work-phase is therefore
two pieces: a status endpoint, then the tab.

## Scope decision

READ-ONLY status for this phase. The tab reports what the fence currently holds:
whether the managed block is present, which port/host it points at, and which
models were registered with which context windows. It does NOT add a write path.

Reasoning: `src/grok/inject.ts` mutates a file in the user's home directory, and
the guards around it (non-loopback refusal, byte-for-byte user-config
preservation, TOML key canonicalization) were hardened only this session. Exposing
a one-click writer to that file from a web surface widens the blast radius of any
bug in those guards. A read surface answers the user's actual question — "is Grok
wired up, and with what?" — at a fraction of the risk. A write path can be its own
work-phase once the read surface proves the shape.

## MODIFY / NEW map

### NEW `src/grok/status.ts`

`readGrokStatus(config)` returning:

```ts
{
  configPath: string;        // resolved ~/.grok/config.toml
  present: boolean;          // managed fence found
  port: number | null;
  hostname: string | null;
  models: Array<{ id: string; contextWindow?: number }>;
}
```

Parses the managed block only; never rewrites. Missing file is `present: false`,
not an error — Grok simply is not installed.

### `src/server/management/agent-settings-routes.ts`

`GET /api/grok` next to the Claude routes, mirroring their error convention
(400 with `{ error }` on a throw).

### NEW `gui/src/pages/Grok.tsx`

Reuses the Claude tab-wrapper structure (`gui/src/pages/Claude.tsx`): the ARIA
tabs pattern with roving `tabIndex`, conditional mounting, panels labelled by
their tabs. States per UX-STATE-01:

- **not present** — explain that Grok Build is not configured and name the command
  that configures it, rather than an empty panel;
- **present** — the endpoint plus the registered model table with context windows;
- **error** — the message with a retry, matching the Desktop panel's convention.

### `gui/src/App.tsx`, `gui/src/app-routing.ts`, `gui/src/i18n/*.ts`

A `grok` page id, a nav entry, and `nav.grok` + `grok.*` keys in ALL SIX locales.
`gui/tests/claude-desktop-locale.test.ts` (added earlier this session) enforces
key-set parity, so a missing locale fails the suite rather than shipping blank UI.

## TESTS

- `tests/grok-status.test.ts` (NEW): present/absent/malformed managed block.
- `gui/tests/grok-page.test.tsx` (NEW): the three states render, and the nav entry
  routes to the page.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/grok-status.test.ts` | pass |
| `gui: bun run test` | pass, including locale parity |
| `bun run typecheck` and `bun run lint:gui` | clean |
