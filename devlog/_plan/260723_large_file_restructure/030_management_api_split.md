# 030 — Phase 3: split `src/server/management-api.ts` (1940) into domain route modules

Target: `src/server/management-api.ts` → thin dispatch core + 7 domain route
modules + 1 shared module. Facade preserves the exact public surface.

## wp3 P stale-check (verified)

`src/server/management-api.ts` is unchanged at **1940 lines** (matches this
doc). Public surface confirmed: `VERSION` `:61`, `ManagementApiDeps` `:69`,
`handleManagementAPI` `:181-1922`, `fetchAllModels` `:1925`.

**Ordering invariant VERIFIED:** extracted every `(method, pathname)` matcher
in `handleManagementAPI` (`:181-1922`) — 72 matchers, all `(method,path)` pairs
UNIQUE. The only repeated pathname regex `/^\/api\/custom-models\/([^/]+)$/`
appears at `:958` (PUT) and `:995` (DELETE) — distinct methods, so still a
unique pair. Pathname literals repeat only across distinct methods (e.g.
`/api/providers` has GET/POST/PATCH/DELETE). Therefore reordering the route
blocks into domain groups is behavior-safe (first-match order is irrelevant
when every `(method,path)` matcher is unique). The two regex matchers do not
overlap any literal matcher (`/api/custom-models/:id` vs `/api/custom-models`).

Implementation note (vs catalog): `handleManagementAPI` is ONE imperative
function of sequential `if (url.pathname === X && req.method === Y)` blocks,
not top-level declarations — so B extracts each domain's if-blocks into a
`DomainHandler(ctx)` function and the core chains them in the original
domain-first-appearance order. Shared helpers/DTOs move to `shared.ts`;
`config`/`deps`/`req`/`url` travel via a `ManagementContext`.

## Public surface to preserve (the facade contract)

External importers (verified by rg):

- `src/server/index.ts:125` imports `fetchAllModels`, `handleManagementAPI`,
  `VERSION`.
- `src/cli/index.ts:251,682` dynamically imports `fetchAllModels`.
- 12 test files import `handleManagementAPI`; `tests/oauth-reauth-bind.test.ts:113`
  also reads the source text for a source-level assertion (keep the symbol
  defined in this file path, not re-exported from elsewhere, OR verify that
  test still passes — see C note).

Facade must keep exporting, from the same path `src/server/management-api.ts`:
`VERSION` (`:61-67`), `ManagementApiDeps` (`:69-76`), `handleManagementAPI`
(`:181-1922`), `fetchAllModels` (`:1925-1928`).

## Dispatch model and the ordering invariant (KEY)

`handleManagementAPI` is a sequential `if (url.pathname === ... && req.method
=== ...)` chain (`:181-1922`) returning on first match, `null` on no match
(`:1918-1922`). There is no router table and no module-level mutable state
(the only mutable state is the caller-owned `config`).

Route blocks are INTERLEAVED by domain in the source (providers at 519-797,
851-907, 1096-1100; models at 799-849, 909-1009, 1499-1527). Reordering into
domain groups is behavior-safe IF AND ONLY IF every `(method, pathname)`
matcher is unique across the whole file — then first-match order is
irrelevant. This is the load-bearing invariant:

- C MUST verify path uniqueness: extract every matched literal/regex and
  assert no `(method, path)` pair repeats. The two regex matchers
  (`/api/custom-models/:id` at `:958` and `:995`) are distinct methods
  (PUT/DELETE) — confirm.
- Each domain module preserves the ORIGINAL relative order of its own blocks.

## File map

NEW `src/server/management/context.ts` — the shared request context type:

```ts
export interface ManagementContext {
  req: Request;
  url: URL;
  config: OcxConfig;
  deps: ManagementApiDeps;
}
export type DomainHandler = (ctx: ManagementContext) => Response | null | Promise<Response | null>;
```

NEW `src/server/management/shared.ts` — cross-domain helpers/DTOs (moved
verbatim): `isPlainRecord` (`:78-80`), `parseDebugLogQuery` (`:82-91`),
`MetricUnavailableReason`/`TokPerSecondResult`/`CostEstimateReason`/
`CostResult`/`MetricSource` (`:94-111`), `tokPerSecondResult` (`:113-124`),
`unavailableCostReason` (`:126-142`), `costResult` (`:144-158`),
`requestLogDto` (`:160-179`), `refreshCodexCatalogBestEffort` (`:193-203`),
`syncClaudeAgentDefsBestEffort` (`:205-223`), `stripRegistryOnlyStaticHeaders`
(`:1930-1940`).

NEW domain modules, each exporting one `DomainHandler` running its blocks in
original order, returning `null` on no match:

| NEW file | Routes moved (anchors) |
|---|---|
| `src/server/management/config-routes.ts` | `/api/config` GET/PUT `:225-231`, `/api/settings` `:233-249`, `/api/diagnostics/project-config` `:252-255`, `/api/sync` `:258-265`, `/api/update/*` `:267-301`, `/api/sidecar-settings` `:303-380`, `/api/shadow-call-settings` `:382-407` |
| `src/server/management/logs-usage-routes.ts` | `/api/logs` `:409-412`, `/api/debug*` + `/api/claude/inbound-debug` `:414-462`, `/api/usage` `:464-502`, `/api/storage` `:505-516` (uses shared DTOs) |
| `src/server/management/provider-routes.ts` | `/api/provider-quotas` `:519-522`, `/api/providers` GET/POST/PATCH/DELETE `:524-797`, `/api/providers/test` `:718-773`, `/api/provider-context-caps` `:851-907`, `/api/provider-presets` `:1096-1100` |
| `src/server/management/model-routes.ts` | `/api/models` `:799-849`, `/api/disabled-models` `:909-918`, `/api/custom-models*` `:920-1009`, `/api/selected-models` `:1499-1527` |
| `src/server/management/agent-settings-routes.ts` | `/api/v2` `:1015-1082`, `/api/injection-model` `:1104-1190`, `/api/effort-caps` `:1195-1220`, `/api/subagent-models` `:1222-1250`, `/api/claude-code` `:1252-1497` |
| `src/server/management/oauth-account-routes.ts` | `/api/oauth/providers` `:1085-1087`, `/api/key-providers` `:1090-1092`, `/api/oauth/login*` `:1531-1587`, `/api/oauth/status` `:1589-1593`, `/api/oauth/logout` `:1595-1605`, `/api/oauth/accounts*` `:1608-1651`, `/api/providers/keys*` `:1655-1719`, `/api/keys*` `:1725-1751` |
| `src/server/management/combo-routes.ts` | `/api/combos` GET/PUT/DELETE `:1753-1895` |

MODIFY `src/server/management-api.ts` → facade:

- Keeps `VERSION`, `ManagementApiDeps` (re-exported from `./management/shared`
  or `./management/context`), `fetchAllModels` (`:1925-1928`).
- `handleManagementAPI` becomes: origin check (`:181-184`) → body-size check
  (`:186-191`) → build `ManagementContext` → try each domain handler in the
  ORIGINAL domain-first-appearance order (config, logs-usage, providers,
  models, agent-settings, oauth-account, combos) → `/api/stop` (`:1897-1909`)
  → `/api/codex-auth/*` delegation (`:1911-1915`) → `null` (`:1918-1922`).
- Re-exports nothing new; all prior exports remain at this path.

## Shared-dependency seams

Domains share, via imports from existing modules (NOT from each other):
`jsonResponse`/`isAllowedRequestOrigin` (`:56-57`), `saveConfig`, provider
validation (`isValidProviderName`/`hasOwnProvider`), catalog identity
(`catalogModelSlug`/`routedSlug`/`slugEquals`, `:3-4`), and the shared.ts
helpers. The models/agent/combos/claude-sync coupling is resolved by routing
all of them through `syncClaudeAgentDefsBestEffort` + `saveConfig` from
shared.ts — domains never import each other's handlers.

## Verification (C)

1. `bun run typecheck`; `bun run test` (all 12 management-importing suites +
   full run); `bun run privacy:scan`.
2. Path-uniqueness check: script/rg over the facade + domain modules asserting
   no `(method, pathname)` matcher repeats (the ordering-invariant proof).
3. Import-surface check: `rg "from .*server/management-api"` shows only
   `fetchAllModels|handleManagementAPI|VERSION|ManagementApiDeps` — no new
   specifiers.
4. `wc -l src/server/management-api.ts` < 800 (facade) — target.
5. `tests/oauth-reauth-bind.test.ts:113` source-text assertion still passes
   (it reads this file; confirm the asserted text still lives here or adjust
   the split so it does — NO test edit unless the assertion is about a symbol
   that legitimately moved, in which case flag as a deviation).

## SoT sync

Update the relevant `structure/` note describing the management API layout if
one exists (check `structure/` at P-reverify); otherwise note in D.
