# WP1 audit — two corrections before building

Verdict: **PASS with two amendments.** The row model and the state mapping hold
up against the shipped code; two mechanical assumptions in `010` do not.

## 1. Six parallel requests on one page, verified for cost

`010` adds five fetches next to the two the overview already makes. Measured
against the running proxy:

| Route | Time | Size |
|---|---|---|
| `/api/claude-code` | 105 ms | 35.9 KB |
| `/api/keys` | 466 ms | 820 B |
| `/api/grok` | 4.9 ms | 4.9 KB |
| `/api/startup-health` | 1.9 ms | 598 B |
| `/api/claude-desktop/status` | 1.1 ms | 350 B |

`/api/claude-code` is 36 KB to read two booleans, and `/api/keys` is the
slowest at 466 ms. Both are acceptable **once**, on a tab the user is actively
looking at, and unacceptable on a poll. So: **no `pollMs` on any of the five
new surfaces.** `useDataSurface` without `pollMs` fetches on mount and on
explicit `refresh()`, which is what the existing two do. The overview's
existing `refresh()` fans out to all seven.

`enabled: active` must be passed to every one of them, exactly as the existing
two do. Without it, mounting the overview panel and hopping to another tab
leaves five hidden fetches alive — the bug the `active` gate was introduced to
prevent.

## 2. Codex CLI: use `/api/settings`, not `/api/startup-health`

`010` reads `routingInjected` from `GET /api/startup-health`. That is correct
but redundant: `GET /api/settings` already embeds the same `startupHealth`
object (verified — its keys are `timeZone, codexAutoStart, port, hostname,
streamMode, appOwnedMemoryBudgetMb, startupHealth, codexRuntime`), and the
dashboard already polls it.

Not adopted. The overview does not otherwise need `/api/settings`, and
`/api/startup-health` is the smaller, faster (1.9 ms / 598 B), single-purpose
route. Reading the big settings payload for one nested field is the same
mistake as reading 36 KB of Claude payload for one boolean — which we tolerate
only because Claude has no narrower route. Keep `/api/startup-health`, and
record here that the duplication is deliberate.

## 3. `routingInjected` is derived, and derived correctly

Checked `deriveStartupHealth` in `src/codex/autostart-health.ts`:
`routingInjected` is exactly `routingKind === "opencodex-local"`, computed
server-side and independent of `status`. So the plan's claim — that a
`protected` status with `routingInjected: false` must render `absent` — is
reachable and correctly separated. `status` mixes in service viability and
reboot safety, which is a Startup-page concern.

One nuance the mapping must respect: `status: "native"` means Codex is NOT
routed through opencodex at all (`routingKind` is remote/native), and it comes
with `routingInjected: false`. That already falls out as `absent`. No special
case needed.

## 4. Amendment: `unknown` needs a translated label

`010` names a "확인 중" badge but does not allocate the key.
`IntegrationStateBadge` maps `VisualIntegrationState` through `LABEL_KEYS` and
`CLASSES`, both exhaustive records — adding a state to the union without adding
both entries fails typecheck, which is the desired outcome. Add
`integrations.state.unknown` to all six locale files
(`en, ko, ja, zh, ru, de`) and both records, class `badge badge-muted`.

## Amended acceptance

Carried from `010`, plus:

- [ ] None of the five new surfaces sets `pollMs`.
- [ ] All five pass `enabled: active`.
- [ ] `integrations.state.unknown` exists in all six locales.
