# 030 — PR #148 Combos GUI absorb onto current `dev` (C3)

## 1. Objective, source, and hard boundary

Absorb only the GUI workspace authored by Wibias in community PR #148 onto the
already-landed combo runtime on `dev`.

- Contributor source ref: `wibias/feat/gui-combos-workspace`
- Immutable source head: `9fed60650569aa9ca0bc8f83f71c0b0964647ce1`
- Target: current local `dev`
- Landed combo stack: `f48a5c73..161a9f74`
- Contributor author identity: `Wibias <37517432+Wibias@users.noreply.github.com>`
- Maintainer identity: `bitkyc08-arch <bitkyc08@gmail.com>`

The allowed product diff is exactly:

- `gui/src/App.tsx`
- `gui/src/combo-workspace-data.ts`
- `gui/src/components/ComboWorkspace.tsx`
- `gui/src/pages/Combos.tsx`
- `gui/src/i18n/{de,en,ko,zh}.ts`
- `gui/src/icons.tsx`
- `gui/src/styles-combos-workspace.css`
- `gui/src/styles.css`
- `tests/combo-workspace-data.test.ts`

Hard exclusions:

1. Do **not** absorb any PR #148 `src/**` file, backend test, config/type/router,
   management API, catalog, response-pipeline, or usage implementation. Those files are
   the contributor's stacked variant of PR #147; the reviewed implementation already
   landed in `f48a5c73..161a9f74`.
2. Do **not** add `gui/src/styles-provider-workspace.css`. It is a 3,207-line vendored
   snapshot from the PR's #139 ancestry, not a missing Combos asset on current `dev`.
3. Do not add POST/PATCH combo calls, a cooldown API, a combo-health API, or a second
   provider/catalog client. The landed management contract is sufficient.
4. Preserve unrelated dirty work. Stage only an explicit manifest for each commit.

## 2. Current-contract evidence and source comparison

Execution must re-run these reads before applying the diff so line drift cannot silently
change the plan:

```bash
git rev-parse wibias/feat/gui-combos-workspace
git show wibias/feat/gui-combos-workspace:gui/src/combo-workspace-data.ts
git show wibias/feat/gui-combos-workspace:gui/src/components/ComboWorkspace.tsx
git show wibias/feat/gui-combos-workspace:gui/src/pages/Combos.tsx
git show wibias/feat/gui-combos-workspace:tests/combo-workspace-data.test.ts
git diff dev...wibias/feat/gui-combos-workspace -- \
  gui/src/App.tsx gui/src/i18n gui/src/icons.tsx \
  gui/src/styles.css gui/src/styles-combos-workspace.css

nl -ba src/server/management-api.ts | sed -n '643,665p;667,690p;1400,1448p'
nl -ba src/combos/types.ts | sed -n '1,205p'
nl -ba src/combos/resolve.ts | sed -n '1,175p'
nl -ba src/combos/failover.ts | sed -n '1,110p'
nl -ba src/combos/request.ts | sed -n '1,80p'
nl -ba src/codex/catalog.ts | sed -n '1370,1532p'
nl -ba src/server/responses.ts | sed -n '443,450p;562,735p'
nl -ba src/server/request-log.ts | sed -n '28,88p'
nl -ba src/usage/log.ts | sed -n '7,53p'
nl -ba gui/src/App.tsx | sed -n '1,55p;260,280p'
nl -ba gui/src/styles.css | sed -n '1,20p'
```

### 2.1 Landed combo value contract

The GUI view model must mirror, but not import from, the standalone backend package:

```ts
type ComboStrategy = "failover" | "round-robin";
type ComboEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

interface ComboTarget {
  provider: string;
  model: string;
  weight?: number; // integer 1..10000; SWRR relative weight; normalized default 1
}

interface ComboItem {
  id: string;
  model: string; // combo/<id>
  strategy: ComboStrategy; // normalized default failover
  stickyLimit: number; // integer 1..100; normalized default 1
  defaultEffort: ComboEffort; // normalized default medium
  targets: ComboTarget[];
}
```

`round-robin` on current `dev` is deterministic smooth weighted round-robin (SWRR),
not PR #147/#148's source-side random weighted pick. `stickyLimit` counts successful
requests retained on the selected SWRR batch before the selector advances. The UI can
keep Wibias's weight and sticky controls, but its copy must describe deterministic
weighted selection and successful-request retention without claiming randomness.

`defaultEffort` fills a missing client effort. Client-owned effort wins. Each concrete
target is reparsed through its full adapter pipeline, so target capability handling can
clamp the effort or remove it for `noReasoningModels`. The catalog advertises only the
reasoning ladder common to every member and picks an effective catalog default from that
intersection. The GUI must not claim that every selected member necessarily supports
the configured rung unchanged.

### 2.2 Management and runtime response contract

| Surface | Landed request/response | GUI use |
|---|---|---|
| list | `GET /api/combos` → `{ combos: [{ id, model, strategy, stickyLimit, defaultEffort, targets:[{provider,model,weight}] }] }` | authoritative workspace list; `parseComboList` defensively validates rows |
| create/update | `PUT /api/combos` body `{ id, combo:{targets,strategy,stickyLimit?,defaultEffort} }` → `{ success:true,id,model,combo }` | one whole-value upsert path for both create and edit |
| delete | `DELETE /api/combos?id=<encoded>` → `{ success:true,id }` | remove only the virtual model |
| unsupported | POST/PATCH `/api/combos` have no route | never emitted by GUI |
| provider config | `GET /api/config` safe DTO with `providers` map | names, disabled state, adapter/auth/base URL, and default model only |
| target catalog | `GET /api/models` → bare array | provider/model picker; rows with `provider === "combo"` are excluded to prevent nesting |
| unavailable runtime | HTTP 503 `{ error:{ message, type:"server_error", code:"combo_unavailable" } }` | explanatory copy only; no invented polling endpoint |
| request attribution | parent `provider:"combo"`, `model/requestedModel:"combo/<id>"`, nested `attempts[]` | no Combos-page fetch; existing Logs/Usage surfaces remain the observer |

The landed `attempts[]` row is additive request-log/usage data:

```ts
{
  ordinal: number;
  provider: string;
  model: string;
  adapter: string;
  status: number;
  durationMs: number;
  sendCount: number;
  recoveryKinds: Array<
    "transient-5xx" | "connection-reset" | "oauth-401" | "key-429" | "image-413"
  >;
  usageStatus: "reported" | "unreported" | "unsupported" | "estimated";
  inputTokenEstimate?: number;
  usage?: OcxUsage;
  totalTokens?: number;
  errorCode?: string;
}
```

Do not flatten this into the combo list and do not label the final provider as the only
provider used. One logical combo request can have multiple physical attempts with usage
attributed to each target.

### 2.3 Strict API mismatches to adapt in the GUI

| PR #148 GUI/source assumption | Current `dev` truth | Required GUI adaptation |
|---|---|---|
| PUT helper silently floors/clamps sticky and weight | validation rejects non-integer/out-of-range values; normalization runs only after validation | validate integer `stickyLimit` 1..100 and RR `weight` 1..10000; `toPutBody` sends the validated values without healing them |
| client validation checks only ID/target presence | backend also rejects duplicate `provider/model`, combo-ID/provider-name collisions, reserved physical `combo` collision, unknown providers, and a PUT with zero enabled members | add matching draft errors and provider-aware validation before PUT; server `error` remains authoritative fallback |
| source backend rejected every disabled target | landed config permits mixed enabled+disabled members and rejects only zero enabled members on PUT | keep an existing disabled target visible/editable; require at least one enabled member; do not silently delete disabled members from a draft |
| random weighted selection in source backend | deterministic SWRR with successful-batch stickiness | retain controls; adapt hints and tests to SWRR semantics; never mention random picks |
| source response loop mutated one routed request across hops | landed response handler rebuilds and reparses each child through the complete pipeline | retain target-neutral UI; copy says target-specific capability handling, not shared first-target processing |
| source had no final ordered attempt attribution | landed parent request contains ordered `attempts[]` with per-attempt usage | no new API; About copy may point users to Logs/Usage but must not claim last-provider-only accounting |
| source combo catalog row could be treated like an ordinary target | landed `provider:"combo"` row is synthesized only when all member capabilities are known and intersect; `exactComboSlugs` preserves exact ladders/modalities | `/api/combos` remains list authority; filter all combo rows out of target options; absence from `/api/models` is not deletion |
| target catalog always represents every configured provider | disabled providers and discovery failures can have no `/api/models` rows | preserve an existing target's model as a synthetic select option; add a provider default only when the provider is enabled, matching current source behavior |
| cooldown might be a GUI-visible object | landed cooldown is internal, keyed by combo + target, 60s default, `Retry-After` aware, max 10m | no cooldown shape in the GUI; keep explanatory text qualitative |
| all unavailable members might fall through | landed path fails closed with exact `combo_unavailable` 503 and never hits `defaultProvider` | About/how-it-works copy must say unavailable, not fallback to global default |
| provider can be deleted independently | `DELETE /api/providers` returns 409 plus sorted `combos` while referenced | combo delete/edit is the repair workflow; no backend alteration in this slice |
| branch PUT parser assumed an object-like body | landed PUT first requires a plain record and a string ID | `toPutBody` always returns a plain object with trimmed string `id`; add exact test |

## 3. Styles decision: reuse current split workspace, do not vendor

Current `gui/src/styles.css:10-14` already imports the landed provider workspace as:

```css
@import "./styles/provider-catalog.css";
@import "./styles/provider-quota.css";
@import "./styles/provider-workspace-shell.css";
@import "./styles/provider-workspace-settings.css";
@import "./styles/provider-overview-dashboard.css";
```

That is current `dev`'s reviewed #139 rebuild. The PR's
`gui/src/styles-provider-workspace.css` is therefore rejected wholesale.

An exact selector audit shows that `ComboWorkspace.tsx` references only these 15 `pwi-*`
classes missing from current CSS:

```text
pwi-back-overview
pwi-dot
pwi-empty-right-icon
pwi-empty-right-sub
pwi-json-unsaved-actions
pwi-json-unsaved-card
pwi-json-unsaved-desc
pwi-json-unsaved-title
pwi-remove-confirm-actions
pwi-remove-confirm-card
pwi-remove-confirm-danger
pwi-remove-confirm-desc
pwi-remove-confirm-title
pwi-section
pwi-section-title
```

Place only their declaration blocks in `styles-combos-workspace.css`. Do not copy any
other selector from the 3,207-line source. The narrow compatibility block is:

```css
.pwi-dot { flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: var(--muted); }
.pwi-back-overview { flex: 0 0 auto; gap: 4px; margin-right: 2px; white-space: nowrap; }
.pwi-section { background: none; border: none; border-radius: 0; min-width: 0; padding: 0; }
.pwi-section-title { margin: 0 0 4px; font-size: 12px; font-weight: 650; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.pwi-empty-right-icon { color: var(--faint); }
.pwi-empty-right-sub { font-size: 13.5px; color: var(--muted); margin: 0; max-width: 44ch; line-height: 1.5; }
.pwi-json-unsaved-card,
.pwi-remove-confirm-card { max-width: 420px; width: min(420px, 92vw); padding: 20px 22px 16px; }
.pwi-json-unsaved-title,
.pwi-remove-confirm-title { margin: 0 0 8px; font-size: 16px; font-weight: 650; color: var(--text); }
.pwi-json-unsaved-desc,
.pwi-remove-confirm-desc { margin: 0 0 18px; font-size: 13.5px; line-height: 1.45; }
.pwi-json-unsaved-actions,
.pwi-remove-confirm-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.pwi-remove-confirm-danger { background: var(--red) !important; color: #fff !important; border-color: transparent !important; }
.pwi-remove-confirm-danger:hover:not(:disabled) { filter: brightness(1.08); }
```

The source Combos CSS is 539 lines. Keeping it as one contributor-owned, isolated
workspace stylesheet is an intentional exception to the ordinary 400-line split hint:
splitting a CSS namespace during reconstruction would obscure source attribution, while
the file already has one responsibility and no shared ownership.

## 4. Diff-level implementation

### 4.1 `gui/src/combo-workspace-data.ts` — NEW, then API-adapt

Start from the source-head file and retain its pure view-model ownership: no React and no
network calls. Retain `ComboStrategy`, `ComboEffort`, `ComboTarget`, `ComboItem`, grouping,
filtering, attention, dirty comparison, model-ID formatting, and empty draft helpers.

Make these contract adaptations:

1. `parseComboList` accepts only `{ combos: unknown[] }`, skips malformed rows/targets,
   trims IDs/providers/models, defaults missing normalized fields defensively, preserves
   integer weights, and sorts by ID. This parser must accept the exact normalized GET row
   (including weight 1 on failover members).
2. Delete the source file's duplicate `hideRedundantChatGptForwardProviders`; the landed
   owner is `gui/src/provider-workspace/catalog.ts` and is imported by `Combos.tsx`.
3. Replace positional draft validation with an options object:

```ts
export type ComboDraftError =
  | "missingId"
  | "invalidId"
  | "duplicateId"
  | "reservedNamespace"
  | "providerCollision"
  | "noTargets"
  | "incompleteTarget"
  | "unknownProvider"
  | "duplicateTarget"
  | "invalidStickyLimit"
  | "invalidWeight"
  | "noEnabledTarget";

export function validateComboDraft(
  item: ComboItem,
  options: {
    existingIds: readonly string[];
    isCreate: boolean;
    providers: Readonly<Record<string, { disabled?: boolean }>>;
  },
): ComboDraftError | null;
```

Validation order is ID required/pattern, duplicate ID on create, configured physical
provider named `combo`, ID collision with a provider key, non-empty targets, complete and
configured targets, duplicate target keys, RR sticky integer/range, RR weight
integer/range, then at least one target whose provider is not disabled. This mirrors the
first useful client error while the server remains authoritative.

4. `toPutBody` returns this exact plain-object contract and performs no silent clamp:

```ts
{
  id: item.id.trim(),
  combo: {
    targets: item.targets.map(target => item.strategy === "round-robin"
      ? { provider: target.provider.trim(), model: target.model.trim(), weight: target.weight ?? 1 }
      : { provider: target.provider.trim(), model: target.model.trim() }),
    strategy: item.strategy,
    defaultEffort: item.defaultEffort,
    ...(item.strategy === "round-robin" ? { stickyLimit: item.stickyLimit } : {}),
  },
}
```

The hidden failover weight/sticky values are intentionally omitted; the backend
normalizes them to 1. Do not add `POST`/`PATCH` body helpers.

### 4.2 `gui/src/components/ComboWorkspace.tsx` — NEW, then contract-adapt

Reconstruct the source component and retain its rail, overview, empty state, create
modal, detail tabs, target reorder, dirty guard, copy-ID, remove confirmation, and
responsive class structure.

Concrete adaptations:

1. Remove unused `apiBase` from `ComboWorkspaceProps` and its call site. The component is
   presentational; `pages/Combos.tsx` owns all requests.
2. Build a `providerMap` from `ProviderOption[]` once and pass it to
   `validateComboDraft` for create and update. Map every returned code through
   `t(\`cws.err.${code}\`)`.
3. Provider selects normally list enabled providers. If a row already references a
   disabled provider, append that provider to that row's options and label it with
   `cws.target.disabled`; this preserves a valid degraded combo created by provider
   PATCH. Never drop the row automatically.
4. Preserve a current model value that is absent from `/api/models` as the first option.
   Continue excluding nested combo targets at the page data boundary.
5. Keep weight visible only for round-robin and sticky visible only for round-robin.
   Inputs retain `min/max`, but the explicit validator—not coercion—is the contract gate.
   Replace the source handlers' `Number(e.target.value) || 1` with
   `Number(e.target.value)` so zero/fractional/over-max drafts reach validation instead
   of being silently healed.
6. Keep source unsaved-navigation behavior and modal Escape handling. Use current global
   `modal-overlay`, `modal-card`, `btn`, `btn-danger`, `Notice`, and input classes; only
   the 15 scoped `pwi-*` declarations in section 3 may be carried over.
7. Keep About/how copy within landed behavior: deterministic weighted batches,
   Retry-After-aware cooldown, no hop for invalid/context errors, target-specific effort
   adaptation, and fail-closed unavailability. Ordered physical attempts remain owned by
   the existing Logs/Usage surfaces; do not add a competing client or live health badges
   because no such combo-management shape exists.

### 4.3 `gui/src/pages/Combos.tsx` — NEW, API owner

Start from the PR page, remove both page-level CSS imports, and rely on the global
`styles.css` import graph. Import
`hideRedundantChatGptForwardProviders` from
`../provider-workspace/catalog`, not from the new data helper.

Type `/api/config` with the current safe DTO contract so the reused helper type-checks:

```ts
type ProviderDto = {
  adapter: string;
  baseUrl: string;
  disabled?: boolean;
  defaultModel?: string;
  authMode?: string;
};
type ConfigDto = { providers?: Record<string, ProviderDto> };
```

`fetchAll` performs exactly three parallel GETs and fails the refresh if any response is
non-2xx before decoding:

```ts
const [combosRes, configRes, modelsRes] = await Promise.all([
  fetch(`${apiBase}/api/combos`),
  fetch(`${apiBase}/api/config`),
  fetch(`${apiBase}/api/models`),
]);
if (!combosRes.ok || !configRes.ok || !modelsRes.ok) throw new Error("combo workspace load failed");
```

Data mapping:

- `setCombos(parseComboList(await combosRes.json()))`;
- parse `config.providers` as the safe DTO shape and reuse the current provider-workspace
  canonical `openai`/legacy `chatgpt` collapse;
- map provider options with `name`, `disabled`, `authMode`, `adapter`, `baseUrl`;
- treat `/api/models` as a bare array, keeping the source `{models:[...]}` fallback only
  as defensive compatibility;
- skip malformed rows, `disabled:true`, and every `provider:"combo"` row;
- append an enabled provider's configured `defaultModel` when discovery omitted it;
- never use `/api/models` to decide whether a combo exists.

Mutations remain exact:

```ts
fetch(`${apiBase}/api/combos`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(toPutBody(item)),
});

fetch(`${apiBase}/api/combos?id=${encodeURIComponent(id)}`, { method: "DELETE" });
```

Both non-2xx responses and `{error}` bodies surface the server's bounded error string;
network/invalid-response failures use localized fallbacks. A successful mutation awaits
`fetchAll()` before reporting success. There is no POST/PATCH path.

### 4.4 `gui/src/App.tsx` — MODIFY current registry, do not take stale branch routing

Apply only the additive current-file changes:

1. import `Combos` and `IconShuffle`;
2. add `"combos"` to `Page` and `VALID_PAGES`;
3. add `{ id:"combos", tkey:"nav.combos", Icon:IconShuffle }` immediately after Models;
4. render `<Combos apiBase={API_BASE} />` after Models;
5. use `className={\`main-inner${page === "combos" ? " main-inner--combos" : ""}\`}`.

Preserve current `readPageFromHash` first-segment parsing and `hashBelongsToPage`,
including `#providers/workspace`. The PR branch's older exact-hash implementation must
not overwrite the current page/sub-view registry.

### 4.5 `gui/src/icons.tsx` — MODIFY

Add only source `IconShuffle` (nav/rail) and `IconGrip` (target reorder) using the existing
`S()`/`SVGProps` convention. Do not add an icon dependency or alter existing exports.

### 4.6 `gui/src/styles-combos-workspace.css` — NEW

Reconstruct the source 539-line `combos-workspace-*`/`cwi-*` stylesheet. Keep its
workspace grid, shell/banner/body, rail, overview/detail, tabs, target editor, modals,
and `max-width:939px` responsive layout. Then append only the 15-selector compatibility
block from section 3.

The stylesheet may use only current design tokens. Replace source-only token fallbacks
only when build/render proves they are undefined; do not import or recreate the provider
workspace monolith.

### 4.7 `gui/src/styles.css` — MODIFY global import and Combos full-bleed class

Add the import after the current provider workspace imports:

```css
@import "./styles-combos-workspace.css";
```

Add only a Combos-scoped full-height rule, using the current page class rather than the
PR's misleading `main-inner--providers` name:

```css
.main-inner.main-inner--combos {
  max-width: none;
  margin: 0;
  padding: 0;
  min-height: 100dvh;
  height: 100dvh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.main-inner.main-inner--combos > .combos-workspace-shell {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}
@media (max-width: 760px) {
  .main-inner.main-inner--combos { padding: 0; min-height: 100dvh; height: 100dvh; overflow: hidden; }
}
```

Do not alter current Providers layout rules.

### 4.8 `gui/src/i18n/{de,en,ko,zh}.ts` — MODIFY with exact parity

Reconstruct the source block in all four locales: `nav.combos`, `common.saving`,
`common.discard`, and every `cws.*` key from the source head. `common.close` already
exists and must not be duplicated. Preserve the source translations, then add these
adaptation keys in every locale:

| Key | en | de | ko | zh |
|---|---|---|---|---|
| `cws.target.disabled` | `{name} (disabled)` | `{name} (deaktiviert)` | `{name} (비활성화됨)` | `{name}（已禁用）` |
| `cws.err.reservedNamespace` | `A physical provider named combo must be renamed before creating combos.` | `Ein physischer Anbieter namens combo muss vor dem Erstellen von Combos umbenannt werden.` | `콤보를 만들기 전에 combo라는 실제 프로바이더의 이름을 변경하세요.` | `创建组合前，请先重命名名为 combo 的实体提供方。` |
| `cws.err.providerCollision` | `The combo ID conflicts with a configured provider name.` | `Die Combo-ID kollidiert mit einem konfigurierten Anbieternamen.` | `콤보 ID가 설정된 프로바이더 이름과 충돌합니다.` | `组合 ID 与已配置的提供方名称冲突。` |
| `cws.err.unknownProvider` | `Each target must use a configured provider.` | `Jedes Ziel muss einen konfigurierten Anbieter verwenden.` | `각 대상은 설정된 프로바이더를 사용해야 합니다.` | `每个目标都必须使用已配置的提供方。` |
| `cws.err.duplicateTarget` | `The same provider/model target can appear only once.` | `Dasselbe Anbieter/Modell-Ziel darf nur einmal vorkommen.` | `같은 프로바이더/모델 대상은 한 번만 추가할 수 있습니다.` | `同一提供方/模型目标只能出现一次。` |
| `cws.err.invalidStickyLimit` | `Sticky successes must be an integer from 1 to 100.` | `Sticky-Erfolge müssen eine Ganzzahl von 1 bis 100 sein.` | `sticky 성공 횟수는 1~100의 정수여야 합니다.` | `粘性成功次数必须是 1 到 100 的整数。` |
| `cws.err.invalidWeight` | `Each round-robin weight must be an integer from 1 to 10000.` | `Jedes Round-Robin-Gewicht muss eine Ganzzahl von 1 bis 10000 sein.` | `각 라운드로빈 가중치는 1~10000의 정수여야 합니다.` | `每个轮询权重必须是 1 到 10000 的整数。` |
| `cws.err.noEnabledTarget` | `At least one target must use an enabled provider.` | `Mindestens ein Ziel muss einen aktivierten Anbieter verwenden.` | `하나 이상의 대상이 활성화된 프로바이더를 사용해야 합니다.` | `至少一个目标必须使用已启用的提供方。` |

Parity proof must compare the key sets, not only rely on TypeScript's first error:

```bash
for lang in de ko zh; do
  diff -u \
    <(rg -o '^  "(nav\.combos|common\.(saving|discard)|cws\.[^"]+)"' gui/src/i18n/en.ts | sed 's/:.*$//' | sort) \
    <(rg -o '^  "(nav\.combos|common\.(saving|discard)|cws\.[^"]+)"' "gui/src/i18n/$lang.ts" | sed 's/:.*$//' | sort)
done
```

When implementing, correct the extraction command if ripgrep includes values; the gate
is equality of quoted keys across all four dictionaries.

### 4.9 `tests/combo-workspace-data.test.ts` — NEW, then expand

Reconstruct the source pure-helper tests and adapt them to the landed contract. Required
cases:

1. parse exact normalized GET rows, including `strategy`, `stickyLimit`,
   `defaultEffort`, weights, and `combo/<id>` fallback;
2. group and filter by combo ID, wire model, provider, and target model;
3. attention flags zero/one-target defensive rows;
4. exact valid/invalid ID boundary and duplicate ID on create;
5. `toPutBody` produces a plain object with a string ID, RR weights/sticky, and no
   failover weights/sticky;
6. duplicate target rejection;
7. integer/range rejection for sticky and weight (fractional, zero, and over max);
8. unknown provider, combo-ID/provider-name collision, and physical `combo` namespace
   collision;
9. one disabled + one enabled member passes, all-disabled members fail;
10. `draftEquals` includes strategy/sticky/default effort/order/weight.

Do not duplicate the existing provider-workspace canonical-forward tests; this slice
reuses their tested helper.

## 5. Commit reconstruction and attribution

Estimated commit count: **3**. Every body names PR #148 and source head
`9fed60650569aa9ca0bc8f83f71c0b0964647ce1`.

### Commit 1 — contributor reconstruction

```text
feat(gui): reconstruct Combos workspace surface

Reconstructs the GUI components, view-model helpers, styles, icons, locale blocks,
and focused helper tests from community PR #148 on current dev.

Source: PR #148
Source head: 9fed60650569aa9ca0bc8f83f71c0b0964647ce1
```

- Author: `Wibias <37517432+Wibias@users.noreply.github.com>`
- Committer: maintainer
- Files: the new data/component/page/style/test files, `icons.tsx`, and four locale files.
- Mechanical current-tree adaptation allowed here: remove the obsolete 3,207-line CSS
  import/vendor and reuse current provider helper/style owners.
- Gate: focused test, GUI lint/i18n lint/build.

### Commit 2 — contributor navigation/layout integration

```text
feat(gui): wire Combos workspace into the dashboard

Wires the reconstructed Combos workspace from community PR #148 into the current
dashboard page registry and global style graph without regressing provider subroutes.

Source: PR #148
Source head: 9fed60650569aa9ca0bc8f83f71c0b0964647ce1
```

- Author: `Wibias <37517432+Wibias@users.noreply.github.com>`
- Committer: maintainer
- Files: `gui/src/App.tsx`, `gui/src/styles.css`.
- Gate: GUI lint/i18n lint/build and `git diff --check`.

### Commit 3 — maintainer API-contract adaptation

```text
fix(gui): align Combos workspace with landed combo contracts

Adapts the PR #148 GUI to the reviewed combo stack already landed on dev: strict
PUT validation, mixed disabled-member handling, deterministic SWRR wording,
non-nesting catalog rows, fail-closed availability, and ordered attempt attribution.

Source: PR #148
Source head: 9fed60650569aa9ca0bc8f83f71c0b0964647ce1

Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>
```

- Author: maintainer
- Required trailer: `Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>`
- Files: only the reconstructed GUI/data/test files requiring behavioral adaptation.
- Gate: all section 6 checks.

Use explicit author environment for commits 1 and 2; never change repository-wide git
identity:

```bash
GIT_AUTHOR_NAME='Wibias' \
GIT_AUTHOR_EMAIL='37517432+Wibias@users.noreply.github.com' \
git commit
```

## 6. Verification and render grounding

### 6.1 Static, focused, and broad checks

Run from repository root unless the command changes directory:

```bash
bun x tsc --noEmit
bun test --isolate tests/combo-workspace-data.test.ts

cd gui
bun run lint:i18n
bun run lint
bun run build
cd ..

bun test --isolate tests/
git diff --check
```

`bun run lint:i18n` is separate in `gui/package.json` and is mandatory even though full
lint also runs. `bun run build` is the GUI typecheck plus Vite production build; the root
TypeScript check does not replace it.

Static scope/contract checks:

```bash
test "$(git rev-parse wibias/feat/gui-combos-workspace)" = \
  9fed60650569aa9ca0bc8f83f71c0b0964647ce1
test ! -e gui/src/styles-provider-workspace.css
test "$(git rev-list --count HEAD~3..HEAD)" -eq 3
git diff --name-only HEAD~3..HEAD
git log -3 --format=fuller
rg -n 'POST|PATCH' gui/src/pages/Combos.tsx gui/src/combo-workspace-data.ts
rg -n 'provider === "combo"|m\.provider === "combo"' gui/src/pages/Combos.tsx
rg -n 'Math\.random|styles-provider-workspace\.css' gui/src tests/combo-workspace-data.test.ts
```

Expected: no GUI combo POST/PATCH implementation, an explicit combo-target catalog
filter, no random-selection claim/implementation, and no monolithic CSS import.

### 6.2 C-RENDER-GROUNDING — required screenshot proof

This is a visual full-height master/detail surface. Completion requires a fresh rendered
screenshot, not only build/lint. Use the built dashboard served by the local proxy after
`cd gui && bun run build`, or use `bun run dev:proxy` plus `bun run dev:gui` when the
packaged serve path is unavailable. Navigate to `#combos`.

Required states at 1280×720 and 760×900:

- empty workspace and Add Combo modal;
- overview with failover and round-robin rows;
- detail/config with weights and sticky control;
- validation error for duplicate target or all-disabled target;
- unsaved-leave dialog;
- remove confirmation;
- dark and light theme at least once each;
- console has no React errors and network shows only GET/PUT/DELETE combo verbs.

Open the screenshot artifact and record the visual verdict: no clipped rail, double
scrollbar, transparent group dot, off-screen modal, untranslated key, broken mobile
stack, or provider-workspace CSS regression. Keep QA combo/provider state in an isolated
temporary config where possible; clean only the created combo through the supported
DELETE endpoint.

Waiver is allowed only when the environment cannot start a browser/server after one
documented retry. The closeout must name the exact failure, include command/output, and
state **C-RENDER-GROUNDING WAIVED — visual behavior unverified**. Lack of time is not a
waiver reason.

## 7. Rollback

Revert commits in reverse order: API adaptation, navigation/layout integration, then
contributor reconstruction. The diff is additive and has no config migration. Reverting
must remove the Combos route/import/style and new files together so no stale i18n keys or
orphan global CSS import remains.

Do not roll back the landed backend combo stack, provider workspace rebuild, or any
unrelated dirty file. If render QA created a combo in a non-temporary config, delete only
that combo through `DELETE /api/combos?id=...` before rollback; never delete its member
providers. The provider 409 dependency guard is expected behavior, not a rollback fault.

## 8. Findings closure and done gate

| Finding/promise | Closure in this slice |
|---|---|
| Issue #133 requested a usable combo surface | `#combos` provides list/create/edit/delete against the landed virtual-model API |
| PR #147 backend absorb explicitly deferred GUI/i18n | PR #148's contributor UI and all four locale blocks are reconstructed with attribution |
| PR #148 is stacked on contributor backend variants | every `src/**` and backend test hunk is excluded; current reviewed contracts drive adaptations |
| PR #148 vendors #139 provider CSS | 3,207-line file rejected; current split workspace styles are reused and only 15 consumed selectors are retained |
| source random weighted behavior differs from landed SWRR | controls/copy/tests describe deterministic SWRR and sticky successful batches |
| source GUI heals invalid numeric values | client validation mirrors integer/range/duplicate/enabled-member rules; PUT remains authoritative |
| disabled provider lifecycle differs | existing mixed disabled-member combos remain editable; zero-enabled PUT is blocked |
| combo catalog rows are member intersections | combo rows never appear as nested target choices; `/api/combos` remains list authority |
| runtime can exhaust targets | copy reflects exact fail-closed `combo_unavailable` behavior; no default-provider fallback claim |
| usage formerly looked final-provider-only | this contract map records ordered target attempts; no competing Logs/Usage client is introduced |
| provider deletion can orphan a combo | existing 409 guard is preserved; combo edit/delete is the repair flow |

This slice completes the GUI/i18n follow-up promised by issue #133 and the PR #147
absorb. It is done only when all three commits have the required authorship/body, the
changed-file list stays inside section 1, the focused and broad gates pass, four-locale
keys are equal, the vendor CSS file is absent, screenshot grounding passes (or carries
the explicit constrained waiver), and no PR #148 backend file has entered the range.

## Audit fold-back (2026-07-18, pre-build gate)

- Blocker 1 (GO-WITH-FIXES): hidden `chatgpt` provider must NOT vanish from the
  validation map. BINDING for B: build the combo validation map from the FULL
  provider DTO list (backend accepts both `openai` and legacy `chatgpt` as
  configured, src/combos/types.ts:109); apply the canonical collapse
  (gui/src/provider-workspace/catalog.ts:226) ONLY to the new-member picker
  display list. When an existing combo row references a hidden-but-configured
  provider, preserve it as a row-local option. Add test: existing combo with
  `chatgpt` member saves unchanged without unknownProvider error.
  Rebuttal: none.
