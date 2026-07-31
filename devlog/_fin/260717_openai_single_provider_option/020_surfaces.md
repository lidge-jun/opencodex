# Cycle 2 — management API and GUI surfaces

Depends on: Cycle 1 core contract and migration green
Exit gate: management/payload/state tests green plus isolated render-grounded QA
Change class: API DTO/write surface, React presentation, four-locale copy

## Cycle objective

Expose the single provider’s account mode honestly and make it editable without a proxy restart.
The Providers page owns the Pool/Direct control, Codex Auth explains the current option, and Models
shows one bare-id `openai` group. No surface offers “Add Codex Multi-account provider.”

## Server/API diff manifest

### `MODIFY src/server/auth-cors.ts`

- Remove `"codexAccountMode"` from `FORBIDDEN_PROVIDER_RUNTIME_FIELDS`; it is now persisted config,
  not runtime-only metadata. Keep `virtualModels`, `codexAuthContext`, selected forward headers,
  sidecar callbacks, and underscore credential overrides forbidden.
- Rewrite `providerManagementConfigError`:
  - `chatgpt` and `openai-multi` remain reserved legacy ids and cannot be POSTed;
  - `openai` must equal the canonical registry seed except that `codexAccountMode` may be exactly
    `"pool"` or `"direct"`;
  - missing/invalid mode on a management write is rejected (management writes are explicit even
    though runtime reads default a mode-less disk config to pool);
  - custom providers and `openai-apikey` may not carry the option;
  - the canonical OpenAI transport/base URL/forward auth cannot be changed.
- In `safeConfigDTO`, call `providerCodexAccountMode(name, provider)` and emit the resolved mode on
  `providers.openai`. Never emit a mode on `openai-apikey` or custom providers.
- Include `codexAccountMode` in the safe provider field projection only through the resolver, so a
  malformed passthrough value cannot be reflected directly.

Before: DTO reports registry-derived Direct/Multi modes for two rows and management forbids the
field.
After: DTO reports the resolved persisted option for one row and management accepts only the two
safe values on canonical `openai`.

### `MODIFY src/server/management-api.ts`

- Update `/api/providers` `GET` to return
  `codexAccountMode: providerCodexAccountMode(name, p)` for `openai`, with no legacy row.
- Keep `/api/providers` `POST` for canonical preset creation. Posting `openai` with either valid
  mode is accepted; posting `openai-multi` is rejected by `providerManagementConfigError`.
- Extend `/api/providers` `PATCH` as two strict, mutually exclusive operations:

  ```json
  { "disabled": true }
  { "codexAccountMode": "direct" }
  ```

  Reject an empty body, both fields together, unknown fields, a non-string mode, a value outside
  `pool|direct`, or a mode patch for any name except `openai`.
- For a mode patch:
  1. require an existing canonical enabled/disabled `openai` row;
  2. write a new provider object preserving all safe overlays and setting the exact mode;
  3. `saveConfig(config)`;
  4. call `clearThreadAccountMap()` so a later switch back to pool cannot reuse affinity created
     under the previous policy;
  5. when switching to pool, invoke `primeCodexPoolQuotas(config, "mode-change")` best-effort after
     save; direct mode performs no prime;
  6. return `{ success: true, name: "openai", codexAccountMode: <mode> }`.
- Do not refresh the model catalog for a mode-only patch: ids and metadata do not change. Do not
  restart or drain the server. A new turn observes the mode from the live config object.
- Keep disabled-provider behavior and “cannot disable default provider” validation unchanged.

## GUI diff manifest

### `MODIFY gui/src/provider-payload.ts`

- Add `codexAccountMode?: "pool" | "direct"` to `ProviderPayload` so the canonical registry seed
  can be cloned without dropping the persisted option.
- Change `isReservedCodexForwardPreset` to return true only for `preset.id === "openai"`.
- Change `CodexPresetDescriptionKey` to
  `"prov.openaiPoolDesc" | "prov.openaiDirectDesc"`.
- `codexPresetDescriptionKey` uses `preset.codexAccountMode` for the one reserved id; missing mode
  resolves to the Pool description. Delete id-specific handling for `openai-multi`.
- `buildProviderPostBody` continues deep-cloning the canonical seed, now including
  `codexAccountMode: "pool"`; attacker-owned form name/base URL/key/default model remain ignored.

### `MODIFY gui/src/components/AddProviderModal.tsx`

- The preset picker contains one Codex-login OpenAI preset and the separate unchanged API-key
  preset. Remove any rendering branch that labels a second Multi preset.
- Replace `modal.badge.multi` with `modal.badge.pool` for a pool-mode seed; retain
  `modal.badge.direct` for completeness if the server ever returns a direct preset.
- The modal creates `openai` in default Pool mode. Mode switching belongs on the Providers card,
  not a second add flow.

### `MODIFY gui/src/pages/Providers.tsx`

- Keep `Config.providers[*].codexAccountMode`, but normalize `openai` missing mode to `pool` in a
  local helper rather than rendering “passthrough.”
- Add `modeBusy: boolean` (or provider-keyed busy state if reused) and
  `setOpenAiAccountMode(next: "pool" | "direct")`:
  - PATCH `/api/providers?name=openai` with `{ codexAccountMode: next }`;
  - on 2xx, update the local `config.providers.openai.codexAccountMode`, show
    `prov.openaiModeSaved`, and refresh provider quota reports when entering pool;
  - on failure, retain the previous selection and show `prov.openaiModeSaveFailed` or server error;
  - prevent concurrent toggles while the request is in flight.
- In the `Object.entries(config.providers)` card renderer, special-case `name === "openai"`:
  - title remains `openai` with one status/default badge;
  - show a localized `Pool` or `Direct` badge;
  - render a two-button `role="radiogroup"` control labelled by `prov.openaiAccountMode`, with
    `role="radio"`/`aria-checked` on Pool and Direct buttons;
  - Pool is selected for a missing DTO field;
  - description is `prov.openaiPoolDesc` or `prov.openaiDirectDesc`;
  - show the Codex Auth account-management link in both modes (accounts may be prepared while
    Direct is selected), but explain in Direct copy that they are not used until Pool is selected.
- Remove the separate Multi badge/card copy and any `openai-multi` action path.
- `openai-apikey` card, masked key controls, quotas, and setup button remain unchanged.
- Mode changes must not call `/api/update/run`, `/api/sync`, stop, or restart.

### `MODIFY gui/src/codex-multi-state.ts`

Keep the path to minimize import churn, but replace its public model:

```ts
export type CodexAccountModeState = "pool" | "direct" | "disabled" | "absent";
export function codexAccountModeState(config: unknown): CodexAccountModeState;
```

Rules:

- use `Object.hasOwn(providers, "openai")`; inherited names do not count;
- no own `openai` => `absent`;
- `providers.openai.disabled === true` => `disabled`;
- valid explicit `direct` => `direct`;
- valid explicit `pool` or missing mode => `pool`;
- malformed provider values fail conservatively to `absent` rather than claiming Direct.

Delete `CodexMultiProviderState` and `codexMultiProviderState`. The file contains no lookup of
`openai-multi` after this change.

### `MODIFY gui/src/pages/CodexAuth.tsx`

- Replace imports/state `CodexMultiProviderState`, `codexMultiProviderState`, and
  `multiProviderState` with `CodexAccountModeState`, `codexAccountModeState`, and
  `accountModeState`.
- The existing `load` call still fetches `/api/config`; derive state from the single `openai` DTO.
- Rework the top panel:
  - title `codexAuth.accountModeTitle`;
  - Pool state: `codexAuth.accountModePool` badge + `codexAuth.accountModePoolDesc` explaining main
    and added accounts are eligible for rotation;
  - Direct state: `codexAuth.accountModeDirect` badge + `codexAuth.accountModeDirectDesc` explaining
    added accounts stay stored but are not selected;
  - disabled/absent: neutral copy `codexAuth.openaiDisabled` or `codexAuth.openaiMissing` with only
    the existing `codexAuth.openProviders` link. Never mention adding Multi.
- Keep account add/remove, active account, quota refresh, threshold, reset-credit, cooldown, and
  reauthentication controls. They manage pool inventory even while Direct is selected.
- In Direct state, relabel active/next-account affordances as prepared pool state; do not imply that
  choosing an added account overrides Direct. The card click may still set the pool’s next active
  account for when Pool is re-enabled.

### `MODIFY gui/src/pages/Models.tsx`

- No grouping algorithm change is required: `groups` already groups by `ModelRow.provider` and pins
  all-native groups first.
- Update the `groups` comment and native hint semantics to say the single `openai` group is served
  according to the Providers-page account option.
- Do not add a mode badge or duplicate rows to Models. Mode is provider configuration, not model
  identity.
- Render acceptance is one `openai` heading with bare ids, one independent `openai-apikey` heading
  when configured, and zero text/rows matching `openai-multi`.

### `MODIFY gui/src/provider-icons.ts`

- Delete the `"openai-multi": "openai.svg"` alias. Keep `openai` and `openai-apikey` mappings.

## Four-locale key contract

Modify all four files together:

- `gui/src/i18n/en.ts`
- `gui/src/i18n/ko.ts`
- `gui/src/i18n/de.ts`
- `gui/src/i18n/zh.ts`

Add/rename the exact keys below in every locale:

| Key | English source meaning |
| --- | --- |
| `prov.openaiAccountMode` | Codex account mode |
| `prov.openaiModePool` | Pool |
| `prov.openaiModeDirect` | Direct |
| `prov.openaiPoolDesc` | Default. Rotate the main login and added accounts using affinity, quota, cooldown, and failover. |
| `prov.openaiDirectDesc` | Use only the current/main Codex login. Stored pool accounts are not read or rotated. |
| `prov.openaiModeSaved` | OpenAI account mode changed to {mode}. |
| `prov.openaiModeSaveFailed` | Could not change the OpenAI account mode. |
| `codexAuth.accountModeTitle` | OpenAI account mode |
| `codexAuth.accountModePool` | Pool mode |
| `codexAuth.accountModePoolDesc` | The main login and eligible added accounts rotate here. |
| `codexAuth.accountModeDirect` | Direct mode |
| `codexAuth.accountModeDirectDesc` | Requests use only the main login; added accounts remain stored for Pool mode. |
| `codexAuth.openaiMissing` | The built-in OpenAI provider is not configured. |
| `codexAuth.openaiDisabled` | The built-in OpenAI provider is disabled. |
| `modal.badge.pool` | Pool |

Delete obsolete active-contract keys after all call sites move:

- `prov.openaiMultiDesc`
- `codexAuth.multiOwnerTitle`
- `codexAuth.multiOwnerDesc`
- `codexAuth.multiMissing`
- `codexAuth.addMultiProvider`
- `codexAuth.multiDisabled`
- `modal.badge.multi` if no unrelated caller remains

Retain `codexAuth.openProviders`, `prov.manageCodexAccounts`, `modal.badge.direct`, and all API-key
keys. Locale parity is a test assertion, not a best-effort translation follow-up.

## Surface test diff manifest

### `MODIFY tests/provider-registry-parity.test.ts`

- Featured/preset ids change from `openai`, `openai-multi`, `openai-apikey` to `openai`,
  `openai-apikey`.
- Assert the one `openai` preset label, mode `pool`, and canonical provider seed containing pool.
- Assert no registry/preset/init entry has id `openai-multi`.
- Keep `openai-apikey` label/catalog and all unrelated provider order assertions unchanged except
  for the one removed item.

### `MODIFY tests/provider-payload.test.ts`

- Replace the table over two reserved ids with one `openai` case.
- Assert the deep-cloned canonical payload includes `codexAccountMode: "pool"` and excludes notes,
  virtual models, and attacker form values.
- Assert `openai-multi` is not reserved and cannot be found in derived presets.
- Assert Pool/Direct description keys exist in en/ko/de/zh and contain no API-key semantics.
- Keep API/custom payload tests unchanged.

### `MODIFY tests/codex-multi-state.test.ts`

- Rename to `tests/codex-account-mode-state.test.ts`.
- Test `absent`, `disabled`, explicit `pool`, explicit `direct`, missing-mode=>pool, malformed object,
  and inherited `openai` property.
- Assert a config containing only legacy `openai-multi` returns `absent`; the UI must not revive it.

### `MODIFY tests/server-auth.test.ts`

- DTO tests assert one resolved `providers.openai.codexAccountMode` and no Multi row/preset.
- Runtime-field rejection no longer lists `codexAccountMode`; instead test strict provider placement
  and invalid values.
- POST tests accept canonical `openai` seeds with pool/direct, reject transport overlays and legacy
  `openai-multi`.
- PATCH tests cover strict shape, only-openai rule, persistence, response DTO, affinity clear,
  pool-only quota prime, and no catalog refresh/restart.
- Existing disable/re-enable tests remain and must not accidentally accept a mixed disable+mode
  body.

## Render-grounded QA on an isolated instance

(Audit fold-back A5 — PHASE-SPLIT-01) The runtime-child rename/rewrite
(`scripts/openai-three-tier-runtime-child.ts` -> `scripts/openai-provider-option-runtime-child.ts`)
is a CYCLE 2 deliverable owned by this document, so this cycle's exit gate is independently
reachable; Cycle 3 keeps only the parent smoke/evidence orchestration.
Use that renamed runtime child with temporary `OPENCODEX_HOME`, `CODEX_HOME`, and `port: 0`.
The child must emit its selected port/PID and serve fixture management data; it must not discover,
signal, drain, or bind `127.0.0.1:10100`.

Required browser scenarios:

1. Desktop 1280×720, English, Pool:
   - Providers shows one OpenAI Codex card, Pool selected, account-management link, separate
     unchanged API-key card;
   - Codex Auth banner says Pool and contains no “add Multi provider” copy;
   - Models has one openai bare-id group and no Multi group.
2. Desktop 1280×720, German, Direct after clicking the Direct radio:
   - PATCH succeeds without page/server restart;
   - card badge/description and Codex Auth banner both switch to Direct;
   - Models rows remain identical.
3. Mobile 390×844, Korean, Pool and Direct:
   - radio controls remain visible/tappable, no overflow, account cards remain readable.
4. Mobile 390×844, Chinese, disabled/absent fixture:
   - neutral OpenAI missing/disabled copy links to Providers and never asks for Multi.

For each scenario capture screenshot, DOM text receipt, `/api/config` JSON, and the isolated
PID/port. Assert no console errors, failed management requests, duplicate OpenAI cards, clipped
controls, or literal untranslated i18n keys. The browser may be closed after evidence capture; only
the isolated child is stopped.

## Cycle 2 acceptance criteria

- `/api/config` and `/api/providers` expose one resolved mode field.
- PATCH mode is strict, persisted, live for the next turn, and restart-free.
- Providers presents one OpenAI card with accessible Pool/Direct controls.
- Codex Auth describes option state and never demands `openai-multi`.
- Models shows one bare native group; mode changes do not change model identity.
- en/ko/de/zh keys are complete and no obsolete Multi-provider key is referenced.
- `openai-apikey` GUI/API behavior is unchanged.
- Focused gates exit 0:

  ```sh
  bun test --isolate \
    tests/provider-registry-parity.test.ts \
    tests/provider-payload.test.ts \
    tests/codex-account-mode-state.test.ts \
    tests/server-auth.test.ts

  bun run typecheck
  bun run build:gui
  ```

## Cycle 2 closeout receipt — 2026-07-18

- Implementation commit: `14e57661`.
- Existing render evidence remains in `evidence/020_*` and covers desktop/mobile Pool, Direct,
  disabled/absent, en/ko/de/zh, provider cards, Codex Auth, and Models.
- Cycle 3 re-ran the combined focused suite: 309 pass, 0 fail.
- `cd gui && bun run lint:i18n && bun run build`: PASS; 51 modules transformed. The existing
  non-fatal chunk-size advisory remains unchanged.
- The account-mode state test now has its contract-accurate path
  `tests/codex-account-mode-state.test.ts`.

Terminal status: **PASS**.
