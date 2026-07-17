# Cycle 040 — Management and GUI Presentation

## Objective

Make every management/UI surface describe the same three tiers. Runtime sidecar
ownership is already activated and verified in Cycle 020.

## Management and GUI file map

### MODIFY `src/server/auth-cors.ts`

`safeConfigDTO` derives account mode/note for `openai` and `openai-multi`. It omits
migration marker, credentials, registry virtual maps, and max-input internals.

### MODIFY `src/server/management-api.ts`

Provider presets expose exactly Direct, Multi, API. `/api/providers` carries derived
mode. These are exactly three OpenAI presets alongside all existing non-OpenAI and
custom presets. `/api/models` keeps bare Direct, namespaced Multi, namespaced API/Pro.
Disable, subagent, and injection APIs store selected ids, never wire ids. Context-cap is
provider-keyed and makes no model-identity claim.

### MODIFY `src/providers/derive.ts`

Extend `DerivedProviderPreset` with `provider?: OcxProviderConfig`. For the reserved
forward presets `openai` and `openai-multi`, `entryToPreset` sets `provider` to a deep
clone of `providerConfigSeed(entry)`. Other presets retain their existing shape. This
gives the modal the same immutable full canonical seed that management admission
compares, without exposing registry-only mode or virtual-model metadata.

### MODIFY `gui/src/provider-icons.ts`

Map `openai-multi` and `openai-apikey` to the OpenAI icon.

### MODIFY `gui/src/components/AddProviderModal.tsx`

Add derived mode to `Preset`. Render Direct badge, Multi badge, or API-key badge;
add optional `provider?: ProviderPayload` to `Preset`, then call
`buildProviderPostBody(preset, form)`. Submit its returned full `{ name, provider }`
body. No editable account-mode or virtual-map field exists; existing API-key/custom
provider submission contracts remain unchanged. The exact form type includes `name`.
Reserved Direct/Multi names render read-only and always emit `name: preset.id`; mutated
form name/adapter/base/default values never affect the canonical post body. Missing
canonical seeds fail locally before fetch.

### MODIFY `gui/src/provider-payload.ts`

Keep `buildProviderPayload(form)` for API-key/custom form submission. Add pure
`buildProviderPostBody(preset, form): { name: string; provider: ProviderPayload }`.
When preset id is `openai` or `openai-multi`, it requires and deep-clones
`preset.provider`; otherwise it uses `buildProviderPayload(form)`. It never copies
derived display-only mode/note fields. `AddProviderModal` uses this helper as the sole
POST body constructor.

### MODIFY `tests/provider-payload.test.ts`

Import the exact helper used by the modal. Use `deriveProviderPresets()` fixtures and
deep-equal Direct and Multi bodies against `providerConfigSeed()` for their registry
entries. Assert no mode/note or virtual field is posted, and retain existing API-key/
custom payload cases. Mutate every reserved form field, cover missing seed and input
immutability, and prove unchanged API/custom naming. In the required Cycle-040 browser
run, submit both Direct and Multi and inspect the management
POST network request and deep-compare its JSON to the same expected Direct/Multi body
before accepting the screenshot.

### MODIFY `gui/src/pages/Providers.tsx`

Type/read `codexAccountMode`; GUI-owned i18n copy keyed by mode/id takes precedence over
raw English registry notes. Render localized Direct “main login, no rotation,”
Multi “main + added accounts,” and API “API key” badges. Multi links to Codex Auth;
Direct never nests global pool accounts. When `openai-apikey` exists without a key,
render an explicit localized API-key setup empty state instead of excluding it.

### MODIFY `gui/src/pages/CodexAuth.tsx`

Copy states that this page owns Multi and fetch `/api/config` as the provider-presence
owner. When Multi is absent, render an add-provider link targeting `#providers` while
preserving account rows. Main remains visible as an eligible account.

### MODIFY `gui/src/pages/Models.tsx`

Use existing provider grouping. Native rows may render bare ids; routed Multi and
API/Pro rows render/store `namespaced` selected ids; no wire-id UI. Add exact
round-trip tests proving a Pro selected id survives disabled-model, subagent, and
injection APIs.

### MODIFY `gui/src/i18n/en.ts`, `gui/src/i18n/ko.ts`,
`gui/src/i18n/de.ts`, and `gui/src/i18n/zh.ts`

Add the same new keys to all four locale modules. `en.ts` remains `TKey` SoT;
`index.ts` and `shared.ts` require no translation-key edits.

## Sidecar dependency

Central sidecar ownership, standalone/internal caller rewiring, auth-aware fallback,
and the full activation matrix moved into Cycle 020 because route-aware auth cannot be
made mandatory atomically while route-blind sidecar callers remain. Cycle 040 only
updates management/GUI presentation and may refine labels; it does not re-own runtime
selection.

## Automated activation matrix

### MODIFY `tests/server-auth.test.ts`

Assert the preset endpoint exposes exactly `openai`, `openai-multi`, and
`openai-apikey` among OpenAI ids, excludes `chatgpt`, preserves every non-OpenAI preset,
and returns clone-isolated Direct/Multi seeds. Assert exact DTO/card data and a
forbidden-field table covering credentials, migration marker, virtual maps, runtime
fields, and max-input metadata.

## Render-grounded GUI QA

Run a temporary proxy with deterministic temp `OPENCODEX_HOME` and a newly-created
empty temporary `CODEX_HOME`, both established before process import/start. Assert no
credential-bearing request leaves localhost. Build/serve GUI, then use the native
in-app browser. Phase A contains all three tiers. Phase B removes Multi while preserving
synthetic main/additional rows so the absent-Multi branch is reachable.

Required runs:

1. English 1280×720: `/#providers`; assert the localized Providers page title DOM,
   open Add Provider; verify three OpenAI choices,
   badges, submit and capture canonical Direct/Multi POST bodies, verify Multi→Codex
   Accounts navigation; re-snapshot and inspect console.
2. Korean 1280×720: `/#providers`; assert the Providers title DOM, then verify
   translated cards and API-key empty state.
3. English 1280×720: `/#models`; assert the Models title DOM, then verify bare Direct,
   namespaced Multi, API group, and
   three Pro rows; toggle one Pro row and re-snapshot.
4. Korean 390×844: `/#codex-auth`; assert the Codex Accounts title DOM, then verify
   main row, Multi ownership copy, absent-Multi
   add action, and no horizontal overflow.
5. Stop management API once on the same hash URL to observe the existing load-error
   state, restart it, and prove recovery on refresh without losing the hash route.

Persist observed screenshots:

- `devlog/_plan/260717_openai_hardening/evidence/040_providers_en_1280x720.png`
- `.../040_providers_ko_1280x720.png`
- `.../040_models_en_1280x720.png`
- `.../040_codex_auth_ko_390x844.png`

## Verification and exit gate

```sh
bun test tests/server-auth.test.ts tests/provider-payload.test.ts
bun x tsc --noEmit
cd gui && bun run lint:i18n && bun run build
```

Exit requires management/payload tests plus one clean post-interaction DOM/
console observation for each named screenshot. Browser output produced but not read is
not evidence.

## Implementation evidence (2026-07-17)

- Focused contract gate after independent-review repairs: `bun test tests/provider-payload.test.ts tests/codex-multi-state.test.ts tests/server-auth.test.ts tests/provider-registry-parity.test.ts` — 85 pass, 0 fail, 620 assertions.
- Static gates: root `bun x tsc --noEmit`, GUI `bun run lint:i18n`, and GUI `bun run build` all exited 0.
- The requested native in-app browser id (`iab`) was not exposed by the current Codex browser runtime; `agent.browsers.list()` exposed only the installed Chrome extension. Browser QA therefore used the same bundled browser client's Chrome/CDP backend and records that environment fallback explicitly.
- Fixture isolation: a new temp `OPENCODEX_HOME` and an empty temp `CODEX_HOME` were set before proxy startup. OpenAI API live discovery was disabled in the fixture. CDP observed 146 browser requests; all HTTP(S) requests were loopback, the only non-loopback schemes were browser-extension assets, and no authorization/API-key/cookie/token signal appeared in request headers or POST bodies.
- `/#providers` English DOM asserted title `Providers`, all three cards, Direct/Multi/API badges, API-key-required setup state, and zero horizontal overflow at CSS 1280×720. The Add Provider modal exposed exactly the three intended OpenAI choices. Captured POST bodies deep-equaled:
  - Direct: `{"name":"openai","provider":{"adapter":"openai-responses","baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward"}}`
  - Multi: `{"name":"openai-multi","provider":{"adapter":"openai-responses","baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward"}}`
- Multi's management link changed the hash to `#codex-auth` and rendered title `Codex Auth`.
- `/#providers` Korean DOM asserted title `프로바이더`, localized Direct/Multi/API descriptions, localized API-key-required action, and zero horizontal overflow.
- `/#models` English DOM asserted title `Models`, bare native ids, namespaced Multi rows, eight namespaced API rows, and all three Pro ids. Toggling `openai-apikey/gpt-5.6-sol-pro` changed `aria-pressed` to `false` while preserving its namespaced selected id.
- Phase B removed only `openai-multi`. `/#codex-auth` at CSS 390×844 retained the synthetic main row and two added-account rows, showed the localized absent-Multi action, and measured `scrollWidth - clientWidth = 0`.
- A separated Vite GUI/proxy run stopped the management API while staying on `#providers`: the page retained title/hash and rendered `Failed to load config`. Restart plus refresh recovered the cards on the same hash. This run exposed and fixed the prior unreachable error notice caused by the null-config early return.
- Additional responsive probes at CSS 767×800 and 1024×800 measured zero horizontal overflow.
- Every named screenshot was opened with `view_image`; no blank render, overlap, clipping, or mobile horizontal spill was observed. Post-interaction console inspection returned no warning/error entries for each capture.

Screenshot receipts:

| Path | Pixels | SHA-256 |
|---|---:|---|
| `devlog/_plan/260717_openai_hardening/evidence/040_providers_en_1280x720.png` | 1280×720 | `f9a8281d7aa83fcb9a7000c51f40d53bc708eb1afea99fcdaa978fac9821a663` |
| `devlog/_plan/260717_openai_hardening/evidence/040_providers_ko_1280x720.png` | 1280×720 | `142579c7cd8fb68c154c23c4b2d0a3dd9e68833f95fed8a04360a08c85795ae2` |
| `devlog/_plan/260717_openai_hardening/evidence/040_models_en_1280x720.png` | 1280×720 | `3086c9ecedf48a2f9087df09cad16f55eebb7c0e7f04f68b1b277cc0a968b1e1` |
| `devlog/_plan/260717_openai_hardening/evidence/040_codex_auth_ko_390x844.png` | 390×844 | `b6380e8adcde6bd35ad0c988c7d657307009c279d9bc66a920c9802994db8316` |

### Independent-review repair round

- Reserved Direct/Multi descriptions now route through `codexPresetDescriptionKey()` in both the chooser and detail form. `isReservedCodexForwardPreset()` is also the POST and setup-guide guard, so neither tier renders dashboard/API-key instructions. English and Korean browser DOM probes confirmed only the localized tier description and canonical read-only name; the four locale dictionaries are covered by the focused test.
- `codexMultiProviderState()` distinguishes own-property `absent`, `enabled`, and `disabled` states. The absent branch alone renders the add action; disabled renders a separate localized configured-but-disabled action. A Korean browser DOM probe confirmed the disabled branch while retaining main and added account rows.
- The Pro selected-id test now reads the public `/api/models`, `/api/subagent-models`, and `/api/injection-model` GET responses after their respective PUTs and observes the unchanged `openai-apikey/gpt-5.6-sol-pro` id.
- The safe DTO activation table now injects API-key pool secrets plus all seven forbidden runtime fields, including a forged raw `codexAccountMode`. It asserts credential/runtime absence and registry-derived `codexAccountMode: direct`.
- Post-repair standalone browser console capture was empty; `git diff --check` exited 0.
- The second review found that detail copy still branched directly on optional mode metadata. Detail rendering now calls the same helper as the chooser, and reserved ids take precedence over missing or forged mode metadata. The ID-only/contradictory-mode regression table proves `openai-multi` remains Multi and `openai` remains Direct.
