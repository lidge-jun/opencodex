# 020 — wp2: first-party model bindings

## Scope

IN: storage, request-path resolution for intercepted Messages and count_tokens, status/PUT API,
CLI `bind`/`unbind`, dashboard first-party card, docs and structure.
OUT: Desktop picker rows or labels, OS trust store/system proxy, Claude.app, gateway-mode
behaviour, global `claudeCode.modelMap` semantics, the public `/v1/messages` path.

## Contract

- `claudeCode.intercept.modelMap?: Record<string, string>` — key: a Desktop picker model id
  (`claude-` prefix, e.g. `claude-sonnet-4-6`); value: an opencodex route in the Desktop route
  vocabulary (`provider/model`, or `native/<slug>` for the native OpenAI pool).
- A binding applies only to requests that arrive on the `claude-intercept` ingress. It is
  overlaid on the global `modelMap` for that request (binding wins per key), so every existing
  resolution rule applies unchanged: alias first, Desktop 3P alias, exact key, date-suffix-stripped
  key, `[1m]` strip, `--fast` decode. A bound id is therefore never natively passed through.
- `native/<slug>` targets resolve to the bare slug, matching how Desktop 3P aliases resolve
  (src/claude/inbound-model-options.ts:48-53). Normalization runs read-side inside
  `claudeCodeForIngress`, so a hand-written config, the CLI, the API and the GUI all converge;
  the stored value keeps the Desktop route vocabulary (`native/<slug>`) for round trips. Only the
  intercept entries are normalized before the merge; global `modelMap` values keep today's verbatim
  semantics on every path.
- An `ocx-route` body directive (src/server/claude-messages.ts:694-697) still wins over a binding,
  because it rewrites the model before resolution. Bindings do not change that precedence.
- PUT validates a target against the whole Desktop route vocabulary from `buildClaudeDesktopState`
  (`state.models`, available entries, native routes included). The apply path's filtered `routed`
  list (agent-settings-routes.ts:1174) is not used, because it drops `native/` routes.

## File change map

| File | Change |
| --- | --- |
| `src/types/config.ts` (~146) | `intercept?: { enabled?; port?; modelMap?: Record<string, string> }` with doc comment. |
| `src/config/schema/config-schema.ts` (~285) | Validate `intercept.modelMap`: plain object; keys match the picker-id shape; values non-empty strings without whitespace. |
| `src/claude/intercept/model-bindings.ts` (new) | `INTERCEPT_BINDING_ID` shape, `normalizeBindingTarget(route)`, `claudeCodeForIngress(cc, claudeIntercept)` (request-scoped view, never persisted), `applyBindingPatch(current, {set, remove})` with validation errors. |
| `src/server/index/serve-options.ts` (~1478, ~1509) | Pass `{ claudeIntercept: ingress === "claude-intercept" }` to `handleClaudeCountTokens` and `handleClaudeMessages`. |
| `src/server/claude-messages.ts` (~96-210, ~634-790, ~1211-1270) | Derive `cc = claudeCodeForIngress(config.claudeCode, claudeIntercept)` once per request; use it in `decodeFablePickerAlias`, `decodeClaudeFastSelector`, capture, `wantsNativePassthrough` (new `cc` argument) and `anthropicToResponsesTranslation`. `config` itself is never copied. |
| `src/server/management/agent-settings-routes.ts` (~1237-1310) | Status adds `firstParty.modelBindings`; new `PUT /api/claude-desktop/first-party-bindings` taking `{ set?, remove? }`, validating routes against the available Desktop routes, committing through `mutatePersistedConfig` and adopting the committed `claudeCode` into the live config. |
| `src/server/management/route-registry.ts` | Declare the PUT route. |
| `src/cli/claude-desktop.ts` | `ocx claude desktop bind <picker-id> <route>` and `unbind <picker-id>` via `runtimeRequest`; help text. |
| `src/cli/capabilities.ts` + `skills/ocx` surface map | Register `claude desktop bind` and `claude desktop unbind`; regenerate with `bun run skill:surface`. |
| `gui/src/components/ClaudeFirstPartyBindings.tsx` (new) + `gui/src/pages/ClaudeDesktop.tsx` + `gui/src/i18n/*.ts` + `gui/src/styles/claude-first-party-bindings.css` (new; `gui/src/styles.css` is at its 2958-line cap and is not touched) | First-party card: rows "picker id → route", add/remove, suggestions of observed picker ids, route select from available Desktop routes, copy that the Desktop label stays Anthropic's. |
| `docs-site/src/content/docs/guides/claude-code.md` + locales | Section "Use opencodex models from the Desktop Code tab"; the CLI-compatibility bullet names bindings next to `modelMap`. |
| `structure/clients/claude-desktop.md`, `structure/runtime.md` | Contract above and the ingress-scoped overlay. |
| `src/providers/provider-id-rewrite.ts` (~97), `src/server/management/routing-profile-routes.ts` (~200), `src/server/management/combo-routes.ts` (~273) | Rewrite `intercept.modelMap` values alongside `modelMap` on provider, routing-profile and combo renames so a binding cannot go stale silently. Keys are not migrated: they are Anthropic picker ids, never opencodex public ids, so a routing-profile rename cannot rename them. `src/providers/openai-tiers.ts` legacy-id migration is left alone: it rewrites pre-existing legacy ids, and bindings are written after it with current ids. |
| Tests | `tests/claude-integration/claude-intercept-model-bindings.test.ts` (new, registered in both layout maps); an intercept-vs-public case in `tests/server/claude-intercept-integration.test.ts`; route/CLI cases next to the existing first-party tests. |

Field chain for `intercept.modelMap`: creation — CLI `bind`, PUT route, GUI card, hand-written
config; serialization — `mutatePersistedConfig`; deserialization — schema validation on load
(invalid entries reported, never silently used); consumers — `claudeCodeForIngress` in both
handlers, status route, GUI card, CLI output, and the three rename migrations above.

## Activation scenarios (C-ACTIVATION-GROUNDING-01)

1. Bound id via intercept: a Messages request for `claude-sonnet-4-6` through the CONNECT proxy
   with binding `xai/…` reaches the fake provider, not the fake Anthropic upstream.
2. Same request on the public listener: passes through to the fake Anthropic upstream.
3. Dated id: `claude-haiku-4-5-20251001` reaches a `claude-haiku-4-5` binding.
4. `native/<slug>` target resolves to `<slug>`.
5. count_tokens on a bound id via intercept is not natively passed through.
6. PUT rejects a non-`claude-` key, an unavailable route and a whitespace value with 400 and
   leaves config unchanged; `remove` of an unknown id is a no-op.
7. Schema rejects a non-object `intercept.modelMap` and non-string values.

## Verifiers (run before writing, PLAN-VERIFIER-REAL-01)

- `bun test tests/server/claude-intercept-integration.test.ts tests/claude-integration/claude-desktop-first-party.test.ts`
  — exit 0, 33 pass on the base; both files import the intercept pair and first-party module directly.
- New test file above, plus `bun run typecheck`, `bun run structure:check`, `bun run skill:surface:check`,
  `bun run lint:gui`, `bun run build:gui`, `bun run test:changed` (run in B/C).

## Delegation

Main writes server, config, CLI, API, tests, structure and English/Korean docs. One devin/swe-2
worker writes the GUI component, page wiring, CSS and all ten GUI locales against the API contract
above (disjoint write scope: `gui/` only). A second devin/swe-2 worker translates the new docs
section into fr, ja, ru, tr, zh-cn and zh-tw (write scope: those six files). Main reviews both diffs.
