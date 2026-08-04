# 001 — Surface inventory

What the API tab renders at `eeef7012`, which selectors and tests pin it, and
what the management route actually supplies. Every claim here is a file:line
read, not a recollection.

## 1. The three bands, in code

```
.main-inner:has(.apikeys-workspace-shell)   max-width: 1200px   (css:13-18)
└ .apikeys-workspace-root                    grid: minmax(200px,240px) | 1fr   (css:51-59)
  ├ aside.apikeys-workspace-rail             band 1
  └ section.apikeys-workspace-main
    └ .awi-overview                          grid: 1fr | 1.05fr   (css:183-190)
      ├ .awi-overview-left                   band 2
      └ .awi-overview-right                  band 3
```

Measured at a 1280px viewport: the app sidebar takes 232px (`styles.css:241`),
so the 1200px shell cap is never reached and `.main-inner` yields 976px of
content. After the rail (240 + 12 gap) and the main pane's 8px padding, the
overview track is 708px, which the `1fr / 1.05fr` grid splits into **339px and
357px** — a panel interior near 300px once border and padding are removed. That
number is the root cause of every defect below.

### Band 2 (`awi-overview-left`), in render order

| Order | Component | Source |
|-------|-----------|--------|
| 1 | `ApiKeysManagePanel` (`showKeyList={false}`) — new-key reveal + generate | `api-keys-panels.tsx:20-140` |
| 2 | `ApiKeysEndpointsPanel` — 5 endpoint URLs + auth matrix | `api-keys-endpoints-panel.tsx:19-88` |
| 3 | `ClientConfigPanel` | `ClientConfigPanel.tsx:36-234` |
| 4 | `ApiKeysUsagePanel` — three curl examples | `api-keys-panels.tsx:308-369` |

`ApiKeysWorkspace.tsx:424-426` carries a comment naming this placement a
fallback: "003 §6 fallback placement: the connect-bar rework has not landed, so
the panel sits in the left column directly below Endpoints". This unit is that
rework.

### Band 3 (`awi-overview-right`)

`ApiKeysModelsPanel` only (`api-keys-panels.tsx:142-306`), capped at
`min(574px, 58vh)` (`css:254-262`) with a sticky header (`css:265-272`). It is
the tab's only vertical cap and that rule is asserted by test.

## 2. Defects the width causes

| # | Defect | Evidence |
|---|--------|----------|
| D1 | Auth matrix clips; `x-api-key` column is off-screen | `.api-auth-matrix-scroll` horizontal scroller, `api-keys-endpoints-panel.tsx:64-84`; observed in the maintainer's screenshot |
| D2 | Catalog actions stack vertically; one model row = 4 lines | `css:405-415`, whose comment states the cause outright |
| D3 | Config JSON block is screen-height at rest in the narrowest band | `ClientConfigPanel.tsx:182-190` renders `JSON.stringify(config, null, 2)` unconditionally |
| D4 | Empty state spends a 240px rail on one "Overview" row | `ApiKeysWorkspace.tsx:203-222` |
| D5 | Endpoint URLs truncate to `http://localhost:101…` | `EndpointUrl`, `api-keys-copy.tsx:10` inside a ~300px panel interior |

## 3. What `GET /api/client-config` supplies

Route: `src/server/management/model-routes.ts:241-285`. Envelope per client:

| Field | Meaning | Rendered today |
|-------|---------|----------------|
| `client` | echo of the requested id | no |
| `filename` | download filename, server-owned | download only |
| `destination` | canonical config path for a human | yes, `CopyableExample` |
| `apiKeyEnv` | env var name | yes, inside the no-key line |
| `exportHint` | `export VAR=<your key>` | yes, `CopyableExample` |
| `modelCount` | exported model count | yes |
| `modelsWithoutLimits` | degraded count | yes, conditional |
| `config` | the config document itself | yes, full JSON at rest |

Client ids come from `EXPORT_CLIENT_IDS` (`src/clients/config-export.ts:368`),
built from `EXPORT_CLIENTS` (`:349-367`): exactly `opencode` and `pi` today. The
GUI hardcodes the same pair in `ClientConfigPanel.tsx:15` with a comment saying
to keep it in sync — a duplication this unit inherits and does not fix (the
route offers no client-list endpoint; adding one would be a `src/` change and is
OUT).

**Consequence for `010`:** rendering N rows means N concurrent GETs, one per
client, where today there is one GET for the selected client. At two clients
that is two requests on tab open. Recorded here because it is a real behavior
change a reviewer must weigh, and `010` states its fetch policy explicitly.

## 4. Brand marks available

`gui/public/provider-icons/` contains `opencode.svg`. There is **no** Pi asset,
and `gui/src/provider-icons.ts` has no `pi` alias (`:3-47`). The `opencode.svg`
entries there map `opencode-free` / `opencode-go` / `opencode-zen`, which are
*provider* ids, not this unit's *export client* ids — reusing that lookup would
couple two unrelated namespaces. `002` settles what the row shows.

## 5. Tests that pin the current shape

These fail by design when the layout changes, and each one is a deliberate
contract rather than a snapshot. `010`/`020` must update them **as contract
edits with stated reasons**, never by deletion.

| Test | What it pins | Phase that must revise it |
|------|--------------|---------------------------|
| `client-config-panel.test.tsx:107` "switching client refetches…" | segmented switch + one visible `.awi-clientconfig-json` | 010 |
| `client-config-panel.test.tsx:222` "client switch is a segmented radio group" | `role=radiogroup`, options `["OpenCode","Pi"]` | 010 |
| `client-config-panel.test.tsx:196` degraded line | `.awi-clientconfig-degraded` reachable | 010 (moves into the dialog) |
| `client-config-panel.test.tsx:126` download filename + "never says applied" | server filename, forbidden words, **and the merge warning visible at rest** (`:162`) | 010 (keeps passing; the merge-warning half must be retargeted, not dropped) |
| `client-config-panel.test.tsx:173` "route failure … no partial JSON, base URL visible" | failed state renders no JSON and keeps the base URL | 010 |
| `client-config-panel.test.tsx:236` "cold load … no second live region" | exactly one `[aria-live]` | 010 (N rows must not mean N live regions) |
| `apikeys-workspace.test.tsx:132` and its three siblings | pending-secret preservation, delete-confirm reset/return, stale selected-key fallback, truncated-attribution wording | **Nobody.** `020`'s P gate settled that the rail stays, so these are untouched; editing them signals a scope breach |
| `apikeys-layout.test.ts:157` "usage examples … left column keeps its order" | `Manage → Endpoints → Usage` index order | 020 |
| `apikeys-layout.test.ts:118` "page owns vertical scroll" | exactly one `max-height`, `min(574px, 58vh)` | 020 (must keep passing) |
| `apikeys-layout.test.ts:100` six-locale `api.*` parity | identical key sets | 010 |

The scroll test is the sharpest constraint in the file: it asserts the complete
list of `max-height` declarations in **this** stylesheet equals exactly
`["min(574px, 58vh)"]`. A dialog that caps its JSON body with `max-height` here
breaks it. `010` resolves this explicitly rather than discovering it in C.

## 6. Verified constraints that are NOT blockers

Established during this unit's A-phase audit and recorded so no later phase
re-litigates them.

- **`.modal-card` already scrolls.** `gui/src/styles.css:1177` carries
  `max-height: 84vh` and `overflow-y: auto`. It lives in a different stylesheet
  from the one the scroll test reads, so the dialog needs no cap of its own and
  the assertion stays green. `010`'s dialog claim holds.
- **Parallel client-config fetches do not trip `CatalogGatherBusyError`.**
  Same-fingerprint callers join one in-flight gather synchronously
  (`src/codex/catalog/provider-fetch.ts:670`). The busy path needs eight other
  distinct fingerprints, or a config fingerprint that changes between the two
  requests. `002` §6's fetch policy is safe; the activation condition is named
  here rather than left implicit.
- **`api.clientConfig.clientLabel` has exactly seven references**: six locale
  dictionaries plus `ClientConfigPanel.tsx:155`. No docs-site, e2e, or tooling
  consumer. There is also no unused-key lint in this repository, so a retained
  but unreferenced key would pass every gate silently.

## 7. Verifier reality

`bun run typecheck` at the repository root **does not observe `gui/src`**. Root
`tsconfig.json:15` is `"include": ["src"]`; the GUI is compiled by
`gui/package.json:8` (`tsc -b && vite build`). Any plan citing root typecheck as
a GUI gate is citing a command that cannot fail on a GUI-only type error.

`gui/AGENTS.md:42` states the required validation for every functional `gui/`
change:

```
cd gui
bun test tests
bun run lint
bun run build
```

plus `bun run lint:i18n` after copy changes. Those are the real gates for this
unit; root `typecheck` remains useful only as a backend check.
