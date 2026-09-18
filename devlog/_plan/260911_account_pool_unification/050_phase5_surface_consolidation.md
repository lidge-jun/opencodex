# Phase 5 — three contracts and two GUIs become one

Base: the phase-2 layer. Opens once the kernel lands.

## Thesis

One pool-settings contract and one operator surface, so a new pooled provider
needs configuration rather than another name branch.

## Current behaviour (verified on dd9a2906b)

Three management contracts:

1. Codex only. src/codex/auth-api.ts handleCodexAuthAPI :2477-2515 handles PUT
   and PATCH /api/codex-auth/pool-strategy, writing accountPoolStrategy and
   accountPoolStickyLimit. There is no GET on this path.
2. Anthropic versus generic. src/server/management/oauth-account-routes.ts
   handleOauthAccountRoutes branches on provider !== "anthropic": GET :348-361,
   PUT and PATCH :373-423 with stickyLimit and quotaWindow rejected at :395-396,
   and the anthropic write at :424-483.
3. Registry. src/server/management/route-registry.ts :95 and :110 for the Codex
   path, :263, :270 and :283 for the oauth pool path.

Two GUI surfaces, one shared control:

- shared gui/src/components/AccountPoolStrategyControls.tsx :42 and
  gui/src/account-pool-strategy.ts, whose putCodexPoolStrategy :58-65 posts to the
  Codex-only route
- Codex gui/src/components/CodexPoolStrategySetting.tsx :33 and :174
- Anthropic gui/src/components/provider-workspace/AnthropicAccountPoolSettings.tsx
  :63 GET and :117 PUT, hardcoded to provider=anthropic
- mounted by a name branch in
  gui/src/components/provider-workspace/ProviderAuthPanel.tsx :387-389,
  item.name === "anthropic" only, so the generic kind has an API and no UI

i18n: 36 accountPool.* keys in gui/src/i18n/en.ts :1981-2023, and every catalog in
gui/src/i18n/catalogs.ts :24-33 already carries 36. All nine stay in sync.

## Change surface

NEW one pool-settings DTO covering every kind, served from a single route pair
under the oauth-account-routes module, with the Codex path kept as a deprecated
alias that forwards rather than duplicating the write.

MODIFY ProviderAuthPanel to mount the pool panel from the capability returned by
poolSettingsCapability instead of item.name === "anthropic".

MODIFY AnthropicAccountPoolSettings into a kind-driven component; keep
AccountPoolStrategyControls as the shared control it already is.

MODIFY the i18n catalogs together. Any new key lands in all nine files in the same
commit, per the docs-sync rule in AGENTS.md.

## Boundary with phase 4

This layer owns oauth-account-routes.ts, the route registry entries and the GUI
pool surfaces. Phase 4 keeps key-strategy fields out of those files. If the key
pool needs an operator surface, it arrives here after both have landed, not in
parallel.

## Tests

tests/server/account-pool-management-api.test.ts for the unified DTO and the
deprecated alias; tests/cli/cli-account-pool-verbs.test.ts for CLI parity; a GUI
test that the panel mounts for a generic OAuth provider. A gui-labelled PR needs a
screenshot in its description per AGENTS.md.

## wp5 plan — one pool-settings contract

## What "three contracts" actually means

Not three routes with one shape. Three shapes, three storage locations and three
re-implementations of the same validation.

| Kind | Route | Storage | DTO fields |
|---|---|---|---|
| Codex | `PUT /api/codex-auth/auto-switch`, `PUT\|PATCH /api/codex-auth/pool-strategy` | `runtimeConfig.autoSwitchThreshold`, `.accountPoolStrategy`, `.accountPoolStickyLimit` | threshold; strategy + stickyLimit, split across two routes |
| Anthropic | `GET\|PUT\|PATCH /api/oauth/accounts/pool?provider=anthropic` | `config.anthropicAccountPool` | enabled, autoSwitchThreshold, strategy, stickyLimit, quotaWindow, `experimental: true` |
| generic | same route, other branch | `providers.<name>.oauthAccountFailover` | enabled, strategy, autoSwitchThreshold, stickyLimit, `inert` |

Anchors: `src/codex/auth-api.ts`:2465 and :2478; `src/server/management/oauth-account-routes.ts`:354
and :379; `src/oauth/pool-settings-capability.ts`:57.

Three consequences, all observable today. The Codex kind is the only one that cannot be READ
through a pool route at all — the CLI reads `/api/codex-auth/active` instead
(`src/cli/account-extended.ts`:854-887 already documents the asymmetry as a table, which is the
tell). Every kind re-parses `strategy` and `stickyLimit` with its own copy of the same bounds.
And a field that exists for one kind is absent rather than declared-unsupported for the others,
so a dashboard cannot tell "this pool has no quotaWindow" from "this pool forgot to send it".

## The unit

**One DTO, one validator, one route. The three existing paths stay as aliases.**

NEW `src/server/management/pool-settings-contract.ts` — a single `PoolSettingsDto` with every
field the union needs and an explicit `supported` set per kind, plus one validator that owns the
strategy names, the 1..100 sticky bound and the 0..100 threshold bound. The three kinds keep
their own STORAGE; only the shape and the validation are shared.

NEW route `GET\|PUT /api/pool/settings?provider=<name>` in
`src/server/management/oauth-account-routes.ts`, registered in `route-registry.ts`, serving all
three kinds through `poolSettingsCapability`.

The three existing paths keep working, unchanged, delegating to the same module. This is
additive on purpose: the management API is a public contract with CLI and GUI clients, and a
breaking change is not what "consolidate" has to mean. The registry marks the old paths
superseded so the next reader knows which one is canonical.

MODIFY `src/cli/account-extended.ts` — the transport table at :854-887 exists precisely because
the two contracts disagree. It collapses to one path, and the comment explaining the asymmetry
goes with it.

## Out of scope, and why

**The GUI half is its own work-phase (wp5b).** `gui/src/codex-auto-switch.ts` and
`gui/src/components/provider-workspace/AnthropicAccountPoolSettings.tsx` are two separate pool
surfaces, and merging them is a visual change. This repository's `enforce-target` gate requires
a screenshot in the description of any PR whose title or description mentions `gui`, which means
building and running the dashboard to capture one. That is a real deliverable, not a formality,
and bolting it onto a server-side PR would either skip the evidence or stall the server work
behind it.

## Acceptance

- One module owns strategy/sticky/threshold validation; a bad value is rejected identically on
  every kind, proven by a table-driven test across all three.
- `GET /api/pool/settings?provider=` answers for Codex, Anthropic and a generic provider, and
  each response declares which fields that kind supports rather than omitting them.
- The three legacy paths return byte-identical bodies to today, proven by tests that predate this
  change and must not be edited.
- Red control: each new shared-validator case must fail if the shared bound is loosened.

### wp5 plan audit — FAIL, folded

**Blocker 1 — the compatibility guard this plan leans on does not exist.** "Byte-identical,
proven by tests that predate this change and must not be edited" is false. The Codex and
Anthropic assertions use `toMatchObject`, which passes when extra keys appear, and the Codex
`PUT /api/codex-auth/auto-switch` test checks only status 200, never the body
(`tests/server/account-pool-management-api.test.ts`:42, :187, :266;
`tests/codex-integration/codex-auth-api.test.ts`:3645). Only the generic GET uses a full
`toEqual` (:483). So the refactor would have been guarded by tests that cannot detect the
regression they were cited for.

The unit therefore starts by WRITING that guard: exact-body assertions for all three legacy
responses, committed and green BEFORE any shared module exists. A characterization test written
after the change proves nothing about what the change did.

**Blocker 2 — "delegating to the same module" skipped the adapter.** The three routes do not
merely differ in shape, they disagree on every axis: Codex auto-switch takes `{threshold}` and
answers `{ok:true}`; Codex pool-strategy takes `{strategy, stickyLimit}` and answers
`{ok, accountPoolStrategy, accountPoolStickyLimit}`; the OAuth route takes `{provider, ...}`
and answers with different key names again. A shared handler would 400 live CLI and GUI writes.

What is actually shared is narrower and still worth it: the shared module owns VALUE validation —
the strategy names, the 1..100 sticky bound, the 0..100 threshold bound — while each route keeps
its own request parsing and response shaping as an explicit adapter. "One validator, three
adapters", not "one handler".

**Major — a new management route is not a one-line registration.** It must appear in
`route-registry.ts` (`tests/server/management-route-registry.test.ts` compares source and
registry as exact pairs), AND in `src/cli/capabilities.ts` or one of the two exemption lists in
`tests/cli/cli-capabilities.test.ts`:174/:344, AND — if capabilities change — the generated
`skills/ocx/references/01_management_surface.md` must be regenerated, which is the gate that
went red on #4289 this session. Also `PATCH` exists on both legacy writes while the proposed
route was `GET|PUT` only.

**Major — a fourth storage location the plan missed.** Top-level
`config.oauthAccountFailover.enabled` (`src/types/config.ts`:917) participates in generic
activation through `isProactivePreferenceEnabled`, but the generic DTO reads only
`providers.<name>.oauthAccountFailover`. So `enabled: null` currently means "nothing stored
here" while the effective answer may be `true` from the global. That is a reporting defect in
its own right and belongs in this unit, since honest per-kind field reporting is the point.

**Major — more clients than the plan named:** `gui/src/account-pool-strategy.ts`,
`gui/src/components/.../CodexPoolStrategySetting.tsx` and `gui/src/hooks/useCodexAccountPool.ts`
join `codex-auto-switch.ts`, and `cmdAutoSwitch` sends `threshold` where the OAuth route expects
`autoSwitchThreshold`.

**Recorded:** `docs-site/src/content/docs/reference/management-api.md`:332 already claims the
pool route 400s for non-Anthropic providers, which stopped being true when the generic contract
shipped. Stale before this unit; fixed by it.

**Minors.** The anchor `pool-settings-capability.ts`:57 points at a comment; the kinds are
:23-28 and `inert` is :63. The kind table omits `provider`/`kind` from the DTO rows. Codex and
Anthropic already share `parseAccountPoolStrategy` from `pool-kernel.ts` while the generic kind
keeps a private copy — that duplication is the smallest true instance of the problem this unit
exists to fix, and is the natural first thing to collapse.

### Status

Planned and audited, NOT implemented. The audit turned a one-route consolidation into a
four-part unit: write the missing exact-body guard first, collapse the duplicate validators,
add the route with all four registrations, then fix the `enabled` reporting defect. That is a
larger cycle than it looked, and the sequencing above is the deliverable of this A phase.

### wp5 cycle scope, after the audit resized it

The audit turned one route change into four parts. This cycle takes the two that stand alone
and are verifiable on their own; the route and the reporting fix become wp5c, because adding a
management route touches four registration surfaces and is a different kind of risk from
deduplicating a validator.

**In this cycle**

1. Write the missing compatibility guard: exact-body assertions for all three legacy pool
   responses, green BEFORE anything is shared. This is the test the plan wrongly assumed existed.
2. Collapse the duplicate validators onto one module. Codex and Anthropic already share
   `parseAccountPoolStrategy` from `pool-kernel.ts`; the generic kind keeps a private copy in
   `pool-settings-capability.ts`. That is the smallest true instance of the problem this phase
   exists to fix, and closing it is what makes a bad value behave identically on every kind.

**Deferred to wp5c**

3. `GET|PUT|PATCH /api/pool/settings` with its four registrations.
4. The `enabled: null` reporting defect, where the generic DTO ignores the top-level
   `oauthAccountFailover.enabled` that actually participates in activation.

Splitting here is not scope avoidance: part 1 is the precondition for parts 3 and 4 being
checkable at all, and shipping it separately means the guard exists in `dev` before the risky
change is written rather than alongside it.

### Residuals from the re-audit, folded

**The three guard targets, named exactly.** Not all four responses are unguarded. Codex
`GET /api/codex-auth/active` already pins its pool fields with a full `toEqual`
(`tests/codex-integration/codex-auth-api.test.ts`:1575). The live holes are precisely:
`PUT /api/codex-auth/auto-switch` (status-only, :3645), `PUT /api/codex-auth/pool-strategy` and
the Anthropic `PUT /api/oauth/accounts/pool` (both `toMatchObject`), and the Anthropic
`GET /api/oauth/accounts/pool` (`toMatchObject`). Those four assertions are the deliverable;
the Codex GET needs nothing.

**The section above is superseded where it disagrees.** "## The unit" and its Acceptance list
still describe the pre-audit shape — one new route, the CLI transport collapse, and
"pre-existing tests must not be edited". The cycle scope below overrides all three: the route
and the CLI collapse move to wp5c, and writing the guard IS editing the test files, which is the
point rather than a violation. The original text stays as the record of what was planned before
the audit rather than being rewritten to look prescient.

**Part 1 does not make part 4 checkable by itself.** The generic GET golden already pins
`enabled: null` (`tests/server/account-pool-management-api.test.ts`:483), so wp5c's reporting
fix has to change that assertion deliberately. The guard is an alias-safety net for the route
change in part 3 and only a tripwire for part 4 — it tells wp5c that it is changing a published
answer, which is exactly what a golden should do, but it does not prove the new answer correct.

## wp5c plan — the unified route and the enabled reporting defect

Part 3 and part 4 of the unit the wp5 audit resized. Parts 1 and 2 shipped: the exact-body
goldens for the three legacy responses, and one validator for strategy and sticky.

### The route

NEW `GET | PUT | PATCH /api/pool/settings?provider=<name>` in
`src/server/management/oauth-account-routes.ts`, serving all three kinds through
`poolSettingsCapability`. The three legacy paths keep working unchanged — the goldens from
part 1 are what proves that, and they were written before any of this precisely so they could.

**Four registration surfaces, each of which fails CI on its own.** This is the part that went
red on #4289 and is worth stating as a list rather than a sentence:

1. `src/server/management/route-registry.ts` — `tests/server/management-route-registry.test.ts`
   compares source and registry as exact pairs.
2. `src/cli/capabilities.ts` — `tests/cli/cli-capabilities.test.ts` fails on any registry route
   that is neither declared, `exempt`, nor in the dated ratchet. The ratchet is NOT an option:
   a sibling test asserts it only ever shrinks.
3. `skills/ocx/references/01_management_surface.md` — generated; `bun run skill:surface` must
   run and the result must be committed, or `tests/ci-workflows/skill-ocx.test.ts` fails.
4. `docs-site` — `reference/management-api.md`:332 still claims the pool route 400s for
   non-Anthropic providers, which stopped being true when the generic contract shipped. Stale
   before this unit and fixed by it.

Declaring the route in `capabilities.ts` rather than exempting it is the honest option only if
the CLI actually uses it, so `src/cli/account-extended.ts` switches its transport table to the
single path. That table exists today only because the two contracts disagreed.

`PATCH` is included because both legacy writes accept it; a unified route that dropped it would
be a narrower contract wearing a wider name.

### The enabled reporting defect

`isProactivePreferenceEnabled` reads the per-provider `enabled` when it is a boolean and falls
back to the global `config.oauthAccountFailover.enabled`. The generic DTO reports only the
per-provider value, so `enabled: null` means "nothing stored here" while the effective answer
may be `true` from the global — a dashboard cannot tell a disabled pool from an inherited one.

The fix ADDS `enabledEffective: boolean` rather than changing `enabled`. `enabled` is published
as "the stored provider override, `null` means unspecified, not inherited effective state" in
`docs-site/reference/cli/providers-accounts.md` and the CLI surfaces it as `poolEnabled`;
redefining it would break a documented field to fix a missing one. The generic GET golden at
`tests/server/account-pool-management-api.test.ts`:483 pins `enabled: null` and must be
extended deliberately — that is the tripwire firing exactly as intended, not a test to silence.

### Acceptance

- `GET /api/pool/settings?provider=` answers for Codex, Anthropic and a generic provider, each
  declaring which fields its kind supports.
- The three legacy paths still return byte-identical bodies, proven by the part-1 goldens, which
  are not edited.
- `enabledEffective` is true for a provider with no stored override under a global `true`, and
  false under a global `false` or absence.
- Registry, capabilities, regenerated surface map and docs all move in the same commit.
- Red control: each new assertion must fail with its production branch removed.

### wp5c plan audit — PASS-WITH-FINDINGS, folded

**Major 1 — the acceptance contradicted itself, and the resolution is the safer one.**
Adding `enabledEffective` to `genericPoolSettingsDto` would change the LEGACY
`GET /api/oauth/accounts/pool` too, so the part-1 golden at :483 would have to move — while the
same section promised the goldens stay unedited. Resolution: the new field appears ONLY on
`/api/pool/settings`. The legacy DTO is not touched, every part-1 golden stays byte-identical
and unedited, and the reporting defect is fixed on the surface that is meant to be canonical.
Choosing the other branch would have spent the tripwire on the first cycle that met it.

**Major 2 — the CLI switch orphans a route's coverage.** Once `account strategy` and
`account sticky` stop driving `PUT /api/codex-auth/pool-strategy`, that route has no capability
declaring it and cannot enter the ratchet, which only shrinks. It gets a registry
`exempt: { reason: "compatibility-alias" }` naming the unified route as its replacement — an
honest description of what it becomes, rather than a capability entry claiming a CLI path that
no longer exists. `GET`/`PUT /api/oauth/accounts/pool` keep their declarations because
`cmdAutoSwitch` still uses them; the transport table this cycle collapses is strategy and sticky
only.

**Major 3 — `PATCH /api/pool/settings` needs its own answer.** The CLI only PUTs, so the PATCH
verb is declared through the same capability entry as the PUT rather than left to a ratchet that
cannot take it.

**Major 4 — do not reuse `isProactivePreferenceEnabled` for `enabledEffective`.** It is
unexported, and it additionally requires `hasFailoverAccountQuorum` — two or more eligible
accounts. Folding a roster condition into a settings field would make the DTO answer a different
question than the one it asks: the defect is stored-versus-global CONFIG, so the field resolves
exactly that and nothing else. Confirmed by the audit that no GUI or CLI consumer already
derives effective enablement: the CLI's `poolEnabled` is stored-only and the Anthropic GUI reads
`enabled === true`.

**Minor 6 — two more locales.** `ko` and `ru` carry the same stale "400 for non-Anthropic" pool
row as the English `reference/management-api.md`. They move with it.

**Confirmed by the audit, no action:** `poolSettingsCapability("openai") === "codex"` is the
right discriminator; the unified GET must NOT copy the mixed pin+failover+pool DTO that
`GET /api/codex-auth/active` returns; and CORS, the Vite `/api` proxy, OpenAPI and the
management-auth enumeration are not gates for a new path.

## wp5b plan — one GUI pool client

The last phase. wp5c gave the server one contract; this points the dashboard at it.

### What "two surfaces" means in the GUI

Not two screens. Two independent client implementations of the same idea:

| Surface | File | Talks to | Reads |
|---|---|---|---|
| Codex threshold | `gui/src/codex-auto-switch.ts` | `PUT /api/codex-auth/auto-switch` | bare `{ threshold }` |
| Codex strategy/sticky | `gui/src/account-pool-strategy.ts` | `PUT /api/codex-auth/pool-strategy` | `accountPoolStrategy`, `accountPoolStickyLimit` |
| Anthropic pool | `gui/src/components/provider-workspace/AnthropicAccountPoolSettings.tsx` | `GET`/`PUT /api/oauth/accounts/pool` | `strategy`, `stickyLimit`, `quotaWindow` |

Three fetchers, three response shapes, two prefix conventions for the same two fields. The
components on top are legitimately different — a Codex pool card is not an Anthropic pool card —
so this phase merges the CLIENT, not the presentation. Merging the rendering would be a visual
redesign nobody asked for; merging the transport is the duplication the objective names.

### Change surface

NEW `gui/src/pool-settings.ts` — one client for `/api/pool/settings`:
`getPoolSettings(apiBase, provider)` and `putPoolSettings(apiBase, provider, fields)`, both
returning the unified DTO with its `supported` list. The existing normalizers in
`account-pool-strategy.ts` stay where they are and are reused; this adds a transport, not a
second copy of the value rules.

MODIFY `codex-auto-switch.ts` `putAutoSwitchThreshold` and `account-pool-strategy.ts`
`putCodexPoolStrategy` to delegate, keeping their exported signatures so no component changes
shape. The `accountPoolStrategy`/`accountPoolStickyLimit` response handling disappears with the
prefixed keys — the unified DTO is neutral for every kind.

MODIFY `AnthropicAccountPoolSettings.tsx` to read and write through the same client.

### The screenshot

`enforce-target` requires a screenshot embed in the description of any PR whose title or
description mentions `gui`, waivable only by a maintainer label. So: `bun run build:gui`, start
the proxy, open the dashboard, capture the pool settings, and commit the PNG under the plan unit
so the description can embed it from the branch. A committed asset is the only route that does
not depend on a browser drag-and-drop.

### Acceptance

- No GUI file references `/api/codex-auth/auto-switch`, `/api/codex-auth/pool-strategy` or
  `/api/oauth/accounts/pool` any more; one grep proves the consolidation rather than an
  argument about it.
- `bun run lint:gui` passes and the GUI suites covering these modules pass.
- The three server routes still work — they have their own goldens and are not touched.
- The PR description embeds a real screenshot of the rendered pool settings.

### wp5b plan audit — FAIL, folded

**Blocker 1 — the request adapter, again.** This is the third time this exact shape has been
caught in this unit, and it is the most dangerous instance. `putAutoSwitchThreshold` sends
`{ threshold }`; the unified route reads `{ provider, autoSwitchThreshold }`. A URL swap alone
either 400s, or — with `provider` added and `threshold` left alone — returns **200 while writing
nothing**, because the route ignores an unknown field. And the function only inspects
`response.ok`, so the dashboard would report success on every save and change no setting.

Silent success is worse than a visible failure, so the client owns an explicit request mapping:
`threshold` becomes `autoSwitchThreshold`, `provider` is always sent, and Codex is addressed as
`provider: "openai"`. The strategy body keys already match and need no mapping; only the
response did, which is what the original plan named and why the request side slipped past it.

**Major 2 — the read path is a different route, and the plan mislabeled it.** The table called
the write bodies "Reads". The GUI actually reads the Codex threshold and strategy from
`GET /api/codex-auth/active` via `extractAutoSwitchThresholdPayload`. That read STAYS: `/active`
is a mixed pin + failover + pool payload the dashboard needs in one request, and wp5c
deliberately did not have the unified GET copy it. Stated rather than left implicit, because a
future reader would otherwise see a half-migrated client and assume it was unfinished.

This narrows the acceptance grep: no GUI file may reference the three legacy pool WRITE
contracts. `/api/codex-auth/active` legitimately remains, and the grep says so.

**Major 3 — four GUI test files pin the old URLs and payloads:**
`gui/tests/account-pool-strategy.test.tsx`, `anthropic-pool-quota-window.test.tsx`,
`codex-account-auto-switch.test.tsx` and `codex-auto-switch-controller.test.tsx`. They move with
the client. `CodexPoolStrategySetting` reads `result.strategy`/`stickyLimit` from the wrapper,
so it survives untouched as long as the wrapper maps the DTO; `putAutoSwitchThreshold` callers
never read the body.

**Minor 4 recorded, not fixed:** `ProviderAuthPanel` still gates the pool card on
`item.name === "anthropic"`, so a generic OAuth provider has a contract and no UI, and the new
`supported`/`enabledEffective` fields are not yet rendered. That is a feature the objective does
not ask for; naming it is better than silently leaving a reader to wonder whether it was missed.

**Screenshot — the gate is stricter than the plan assumed.** It fires on `gui/` PATH CHANGES,
not on a title cue, so it applies here regardless of wording. A committed PNG alone does not
satisfy it: the description must contain a rendered embed. A relative path passes the regex but
renders nothing on GitHub, so the description uses an absolute `raw.githubusercontent.com` URL
pointing at the committed file on this branch. The waiver is a maintainer COMMENT, not a label.

### wp5b SPEC — supersedes "Change surface", "The screenshot" and "Acceptance" above

Those three sections predate the audit and disagree with it. This is the spec.

**Change surface.**

NEW `gui/src/pool-settings.ts`, one client for `/api/pool/settings`:

- `getPoolSettings(apiBase, provider)` — `GET ?provider=<name>`, returns the unified DTO.
- `putPoolSettings(apiBase, provider, fields)` — `PUT`, and it owns an explicit REQUEST
  mapping rather than forwarding whatever it is handed:
  - `provider` is ALWAYS sent, and Codex is addressed as `provider: "openai"`.
  - the Codex threshold field `threshold` becomes `autoSwitchThreshold`.
  - `strategy` and `stickyLimit` already match and pass through unmapped.

  Without that mapping a URL swap returns 200 and writes nothing, because the route ignores an
  unknown field — and the caller only inspects `response.ok`, so the dashboard would report
  success on every save. That is the specific failure this mapping exists to prevent.

MODIFY `gui/src/codex-auto-switch.ts` `putAutoSwitchThreshold` and
`gui/src/account-pool-strategy.ts` `putCodexPoolStrategy`: same exported signatures, bodies
delegating through the client, and the `accountPoolStrategy`/`accountPoolStickyLimit` response
parsing replaced by the DTO's neutral keys.

MODIFY `gui/src/components/provider-workspace/AnthropicAccountPoolSettings.tsx`: read and write
through the client.

MOVE WITH IT — four test files pin the old URLs and payloads and are part of this change, not
collateral: `gui/tests/account-pool-strategy.test.tsx`,
`gui/tests/anthropic-pool-quota-window.test.tsx`, `gui/tests/codex-account-auto-switch.test.tsx`,
`gui/tests/codex-auto-switch-controller.test.tsx`.

UNCHANGED ON PURPOSE — `GET /api/codex-auth/active`. The dashboard reads the Codex threshold and
strategy from that mixed pin + failover + pool payload in one request, and wp5c deliberately did
not have the unified GET copy it. This phase migrates the three pool WRITE contracts, not that
read.

**Acceptance.**

- `rg` over `gui/` returns no hit for `/api/codex-auth/auto-switch`,
  `/api/codex-auth/pool-strategy` or `/api/oauth/accounts/pool` — the three legacy WRITE
  contracts. `/api/codex-auth/active` is expected to remain and is not part of this grep.
- The four test files above assert the unified path and the mapped request body, including
  `autoSwitchThreshold` rather than `threshold`.
- `bun run lint:gui` passes and the GUI suites pass.
- Red control: with the request mapping removed, the auto-switch save test must fail — the point
  is that it would otherwise pass silently.

**The screenshot.**

The gate fires on `gui/` PATH CHANGES, not on a title cue, so it applies. A committed PNG alone
does NOT satisfy it. The description must carry a rendered embed — `![alt](url)`,
`<img src="...">`, or a reference form — outside comments and fences. A relative path passes the
regex but renders nothing, so the PNG is committed under the plan unit and the description
embeds its absolute `raw.githubusercontent.com` URL on this branch. The only waiver is a
maintainer COMMENT, which is not something this cycle can issue for itself.

