# 040 — Cycle 4: discovery failure visibility and honest helper fallback copy

> DIFFLEVEL-ROADMAP-01: this is the implementation SSOT for Cycle 4 of
> `260724_bugfix_train`. Re-verify every cited line against the cycle-start SHA before B;
> do not implement from the issue summaries alone.

## Loop spec

- **Loop archetype:** verifier-defined, spec-satisfaction repair.
- **Trigger:** issue #329's core zero-model grouping/manual-add repair is present, but
  live discovery failures such as HTTP 401 remain log-only; issue #331's empty
  `smallFastModel` runtime behavior leaves both helper overrides unset while the GUI says
  “Claude default (Haiku).”
- **Goal / user-visible outcome:** an active provider whose latest live model discovery
  failed exposes a safe machine-readable reason through `GET /api/providers`; when that
  provider has no model rows, Models shows a compact failure badge and reason beside the
  existing recovery guidance. The Claude page accurately says that an unset helper model
  delegates selection to Claude Code and warns that native Sonnet usage may incur native
  provider cost.
- **Non-goals:** no retry button, no new discovery request, no persistence of transient
  discovery state, no upstream response body/status-text exposure, no routing or fallback
  behavior change, no provider editor redesign, no broad Claude settings redesign, and no
  #337 auto-switch takeover work.
- **Verifier:** `bun run typecheck`, `bun run test`, `bun run lint:gui`,
  `bun run build:gui`, and `bun run privacy:scan` must each exit 0. Focused tests prove
  the status contract and both conditional UI states. A real Vite render and observed
  screenshot prove the empty-provider badge is visible and legible.
- **Stop condition:** stop only when the 401, successful discovery, helper-unset, and
  helper-set activation scenarios below pass; all five repository gates pass; the Vite
  screenshot has been opened and observed; docs/locales agree; and the final diff still
  avoids #337's changed keys and CSS hunks.
- **Memory artifact:** this document, later moved by the parent workflow to the unit's
  `_fin/` location with C/D evidence. The delegated writer does not operate parent loop or
  goal state.
- **Expected terminal outcomes:** `DONE`; `BLOCKED` if a required existing seam cannot
  represent last-attempt status without changing discovery semantics; `NEEDS_HUMAN` if
  product owners reject the native-Sonnet/cost wording.
- **Escalation:** upward to the parent before expanding the API beyond an additive optional
  field, exposing provider-controlled text, touching auth/token material, altering runtime
  selection, or editing a #337-owned key/hunk. No downward delegation is planned; any such
  delegation is a P-phase amendment owned by the parent, not a B-phase improvisation.

## Grounding and necessity gate

Cycle-start base is `origin/dev` / `d9e06c8dd08df6635f5ca042bf6aa469fe1a10a8`.

- `src/codex/catalog/provider-fetch.ts:207-388` owns live discovery, fallback, cooldown
  activation, logs, and successful cache writes. HTTP non-OK is reduced to a warning at
  `:307-313`; valid discovery is cached at `:343-380`.
- `src/codex/model-cache.ts:20-61` already owns per-provider cache and failed-fetch
  cooldown lifecycle. `clearModelCache()` is therefore the correct owner for clearing the
  associated last-attempt diagnostic; a second independent map module would drift.
- `src/server/management/provider-routes.ts:71-81` builds the additive provider DTO.
- `gui/src/models-groups.ts:1-53` is the pure join between `/api/providers` and model rows;
  configured zero-row providers are retained at `:29-37`.
- `gui/src/pages/Models.tsx:180-224` loads both endpoints; `:729-795` renders groups and
  passes empty providers to `EmptyProviderHint`; `:1111-1121` owns the current generic
  guidance and is the smallest render seam. Because the current `Promise.all` starts
  `/api/models` and `/api/providers` concurrently, the provider DTO can win the race before
  discovery records its result; order the DTO read after the model read so the first render
  is grounded in the attempt it displays.
- `src/claude/context-windows.ts:152-173` proves `tierModels.haiku ?? smallFastModel` is
  written to both helper env variables only when non-empty. Existing runtime regression
  coverage includes the unset case at `tests/claude-cli.test.ts:214`.
- `gui/src/pages/ClaudeCode.tsx:141-144` labels the empty option with
  `claude.slotUnset`; `:348-356` renders the misleading helper copy and picker.
- The six GUI dictionaries are type-locked by English `TKey` through
  `gui/src/i18n/shared.ts:1-12`; every new English key must be added to de/ja/ko/ru/zh.
- Existing `.badge`, `.badge-amber`, and `.notice-warn` rules at
  `gui/src/styles.css:498-502,730-731` satisfy the visual need. Reuse them; do not add or
  edit CSS.

No-code options rejected: doing nothing leaves #329 log-only and #331 factually wrong;
configuration cannot surface a runtime HTTP result; deleting copy would hide the cost
consequence; reusing only the generic empty hint cannot distinguish an authoritative empty
catalog from a failed request. The plan reuses the model-cache lifecycle, provider DTO,
grouping seam, existing badge/warning classes, and existing i18n system; it introduces no
dependency or background polling.

## Scope

### IN

1. Ephemeral last-attempt discovery status in the model-cache lifecycle.
2. Additive optional discovery metadata on each `GET /api/providers` row.
3. Empty-provider failure badge/reason in Models, with successful/unknown/static states
   retaining the current non-error guidance.
4. Accurate helper description, unset-option label, and conditional native Sonnet/cost
   warning in all six GUI locales.
5. English plus all existing translated Claude Code guides kept semantically aligned.
6. Focused backend/API/SSR tests, full gates, and a real rendered screenshot observation.

### OUT

- Discovery retries, timestamps, history, telemetry, disk persistence, status for disabled
  or forward-auth providers, and showing a badge when stale/static rows are already present.
- Any raw response body, URL, API key, account identifier, `statusText`, or thrown message in
  the API/UI.
- Changes to `src/claude/context-windows.ts` or Claude Code's actual model choice.
- Changes to provider setup, account auto-switch, global visual tokens, or release files.

## API contract

`GET /api/providers` remains an array of provider rows. Add one optional field:

```ts
export type ProviderModelDiscoveryFailureReason =
  | "http"
  | "blocked"
  | "invalid_response"
  | "network"
  | "provider";

export type ProviderModelDiscoveryStatus =
  | { status: "ok" }
  | { status: "failed"; reason: "http"; httpStatus: number }
  | {
      status: "failed";
      reason: Exclude<ProviderModelDiscoveryFailureReason, "http">;
      httpStatus?: never;
    };

// GET /api/providers row (new field only)
{
  name: "example",
  // ...existing fields unchanged...
  discovery?: ProviderModelDiscoveryStatus
}
```

Example 401 row:

```json
{
  "name": "example",
  "liveModels": true,
  "models": [],
  "discovery": {
    "status": "failed",
    "reason": "http",
    "httpStatus": 401
  }
}
```

Contract rules:

- `status: "ok"` means the most recent attempted live discovery returned a valid models
  payload, including an authoritative empty array. It does not promise that models exist.
- `status: "failed"` means the most recent attempted live discovery took a fallback path.
  `httpStatus` is present only for `reason: "http"` and is the integer HTTP status.
- No status exists before an attempt or for paths that intentionally do not discover
  (`liveModels: false`, forward auth, or OAuth without a token). Because object properties
  with `undefined` are omitted by JSON serialization, old consumers receive their existing
  row shape plus, at most, an unknown additive field.
- Cache hits/cooldown reads preserve the last attempted status. A later valid live response
  replaces `failed` with `ok`. `clearModelCache(provider)` and global clear remove both cache
  and status, preventing a provider edit from retaining stale diagnostics.
- `reason` is a closed server-owned code. The UI localizes it; it never parses or displays
  a provider-controlled message. For issue #329 the visible detail is derived as `HTTP 401`.

## Exact change map

### Backend and management API

#### MODIFY `src/codex/model-cache.ts`

Before:

```ts
const cache = new Map<string, CacheEntry>();
const failureAt = new Map<string, number>();

export function markModelsFetchFailure(provider: string, now = Date.now()): void {
  failureAt.set(provider, now);
}

export function clearModelCache(provider?: string): void {
  if (provider) {
    cache.delete(provider);
    failureAt.delete(provider);
  } else {
    cache.clear();
    failureAt.clear();
  }
}
```

After:

```ts
export type ProviderModelDiscoveryFailureReason =
  | "http" | "blocked" | "invalid_response" | "network" | "provider";

export type ProviderModelDiscoveryStatus =
  | { status: "ok" }
  | { status: "failed"; reason: "http"; httpStatus: number }
  | { status: "failed"; reason: Exclude<ProviderModelDiscoveryFailureReason, "http">; httpStatus?: never };

const discoveryStatus = new Map<string, ProviderModelDiscoveryStatus>();

export function markProviderDiscoveryOk(provider: string): void {
  discoveryStatus.set(provider, { status: "ok" });
}

export function markProviderDiscoveryFailed(
  provider: string,
  failure: Omit<Extract<ProviderModelDiscoveryStatus, { status: "failed" }>, "status">,
): void {
  discoveryStatus.set(provider, { status: "failed", ...failure });
}

export function getProviderDiscoveryStatus(
  provider: string,
): ProviderModelDiscoveryStatus | undefined {
  return discoveryStatus.get(provider);
}

// Existing cache/failureAt clearing remains, plus discoveryStatus delete/clear.
```

Keep `markModelsFetchFailure(provider, now?)` unchanged for cooldown compatibility. Do not
make `setCached()` imply discovery success because tests and non-fetch callers seed cache
entries directly.

#### MODIFY `src/codex/catalog/provider-fetch.ts`

Extend the existing model-cache import with
`markProviderDiscoveryOk` and `markProviderDiscoveryFailed`.

Before:

```ts
const failedDiscoveryFallback = (): { models: CatalogModel[]; fallback: "stale" | "configured" } => {
  markModelsFetchFailure(name);
  // ...
};

if (!res.ok) {
  const { models, fallback } = failedDiscoveryFallback();
  // log only
  return models;
}

setCached(name, live);
return live;
```

After:

```ts
type DiscoveryFailure = Omit<
  Extract<ProviderModelDiscoveryStatus, { status: "failed" }>,
  "status"
>;

const failedDiscoveryFallback = (
  failure: DiscoveryFailure,
): { models: CatalogModel[]; fallback: "stale" | "configured" } => {
  markModelsFetchFailure(name);
  markProviderDiscoveryFailed(name, failure);
  // existing stale/configured fallback is byte-for-byte unchanged
};

if (!res.ok) {
  const { models, fallback } = failedDiscoveryFallback({
    reason: "http",
    httpStatus: res.status,
  });
  // existing sanitized warning remains
  return models;
}

markProviderDiscoveryOk(name);
setCached(name, live);
return live;
```

Use the same helper for every generic failure path:

| Existing branch | Recorded failure |
|---|---|
| destination-policy rejection (`:295-305`) | `{ reason: "blocked" }` |
| HTTP non-OK (`:307-314`) | `{ reason: "http", httpStatus: res.status }` |
| invalid JSON 2xx (`:316-332`) | `{ reason: "invalid_response" }` |
| malformed `data` 2xx (`:333-342`) | `{ reason: "invalid_response" }` |
| thrown fetch/timeout (`:381-387`) | `{ reason: "network" }` |
| Cursor `liveResult.ok === false` (`:249-261`) | `{ reason: "provider" }` |

Call `markProviderDiscoveryOk(name)` in both successful live seams: Cursor immediately
before its `setCached(name, result)` and generic discovery immediately before
`setCached(name, live)`. Do not mark static, forward-auth, missing-token, fresh-cache, or
cooldown-only returns as newly successful; they did not perform an attempt.

#### MODIFY `src/server/management/provider-routes.ts`

Import `getProviderDiscoveryStatus` from `../../codex/model-cache` and append one property
to the existing DTO at `:72-81`:

```ts
return jsonResponse(Object.entries(config.providers).map(([name, p]) => ({
  // existing fields unchanged
  codexAccountMode: providerCodexAccountMode(name, p),
  discovery: getProviderDiscoveryStatus(name),
})));
```

Do not trigger discovery from this route. The Models implementation below orders
`/api/providers` after `/api/models` on each existing load (`gui/src/pages/Models.tsx:180-219`),
so the route reports the completed fetch lifecycle rather than duplicating it.

#### MODIFY `tests/codex-catalog.test.ts`

- Extend the existing HTTP non-OK case at `:1567-1594` to use 401 and assert
  `getProviderDiscoveryStatus(provider)` equals
  `{ status: "failed", reason: "http", httpStatus: 401 }` while configured fallback rows
  remain unchanged.
- Extend a valid live-discovery case (the private-network opt-in case at `:1460-1485` is
  suitable) to assert `{ status: "ok" }`.
- Retain the existing sanitized-log assertions. Cleanup continues through
  `clearModelCache(provider)`, now also proving status isolation between tests.

#### MODIFY `tests/management-provider-validation.test.ts`

Add a direct management contract test using the existing `handleManagementAPI` seam:

```ts
markProviderDiscoveryFailed("auth-broken", { reason: "http", httpStatus: 401 });
const response = await handleManagementAPI(
  new Request("http://127.0.0.1/api/providers"),
  new URL("http://127.0.0.1/api/providers"),
  { providers: { "auth-broken": providerFixture } },
);
expect(await response!.json()).toContainEqual(expect.objectContaining({
  name: "auth-broken",
  discovery: { status: "failed", reason: "http", httpStatus: 401 },
}));
```

Also include an unattempted provider and assert it has no own `discovery` property after
JSON serialization. Clear status in `finally` with `clearModelCache()`.

### Models GUI

#### MODIFY `gui/src/models-groups.ts`

Before, `ConfiguredProviderSummary` and `ProviderModelGroup` carry only live/static model
metadata. After, add the API union and thread it through the pure join:

```ts
export type ProviderDiscoverySummary =
  | { status: "ok" }
  | {
      status: "failed";
      reason: "http" | "blocked" | "invalid_response" | "network" | "provider";
      httpStatus?: number;
    };

export interface ConfiguredProviderSummary {
  // existing fields
  discovery?: ProviderDiscoverySummary;
}

export interface ProviderModelGroup<Row> {
  // existing fields
  discovery?: ProviderDiscoverySummary;
}

// map result
discovery: configured?.discovery,
```

No new client fetch, store, parser, or component-level status map.

#### MODIFY `gui/src/pages/Models.tsx`

Make the load order explicit. Keep `/api/models` and context caps parallel, then read
`/api/providers` only after `/api/models` has completed and recorded discovery status:

```ts
const [data, capsData] = await Promise.all([
  fetch(`${apiBase}/api/models`).then(r => r.json()) as Promise<ModelRow[]>,
  fetch(`${apiBase}/api/provider-context-caps`).then(r => r.json())
    as Promise<ProviderContextCapsResponse>,
]);
const providerData = await fetch(`${apiBase}/api/providers`)
  .then(r => r.json()) as ConfiguredProviderSummary[];
```

This changes request ordering only; it adds no request, retry, or timer. Retain the existing
ten-second refresh and busy guard. The ordering is required so a first-load 401 reaches the
same render rather than waiting for the next poll.

Destructure `discovery` from each group and pass it only to the zero-row hint:

```tsx
groups.map(({ provider, rows, native: isNative, liveModels, discovery }) => {
  // ...
  {rows.length === 0 && (
    <EmptyProviderHint liveModels={liveModels} discovery={discovery} />
  )}
})
```

Before:

```tsx
export function EmptyProviderHint({ liveModels }: { liveModels: boolean }) {
  // generic status row only
}
```

After:

```tsx
export function EmptyProviderHint({
  liveModels,
  discovery,
}: {
  liveModels: boolean;
  discovery?: ProviderDiscoverySummary;
}) {
  const t = useT();
  const failed = liveModels && discovery?.status === "failed";
  const reason = !failed
    ? ""
    : discovery.reason === "http" && discovery.httpStatus !== undefined
      ? t("models.discoveryFailedHttp", { status: discovery.httpStatus })
      : discovery.reason === "blocked"
        ? t("models.discoveryFailedBlocked")
        : discovery.reason === "invalid_response"
          ? t("models.discoveryFailedInvalidResponse")
          : discovery.reason === "network"
            ? t("models.discoveryFailedNetwork")
            : discovery.reason === "provider"
              ? t("models.discoveryFailedProvider")
              : t("models.discoveryFailedGeneric");

  return (
    <div className="row muted text-label leading-body" role="status" /* existing layout */>
      <IconInfo /* existing accessible decoration */ />
      <span>
        {failed && (
          <span className="badge badge-amber">{t("models.discoveryFailedBadge")}</span>
        )}
        {failed ? `${reason} ` : t(liveModels
          ? "models.emptyDiscovery"
          : "models.emptyDiscoveryDisabled") + " "}
        <a href="#providers">{t("models.openProviderSettings")}</a>
      </span>
    </div>
  );
}
```

Keep failure meaning in text as well as color. Use existing `.badge badge-amber`; **no
`gui/src/styles.css` change**. Exact JSX spacing may use nested spans rather than string
concatenation, but rendered text and accessible order must be: badge → reason → settings
link. An `ok` or absent discovery status renders no badge.

#### MODIFY `gui/tests/models-empty-provider.test.tsx`

Change `renderHint` to accept optional `ProviderDiscoverySummary`, then cover:

1. `liveModels=true` + failed/http/401 renders `Discovery failed`, `HTTP 401`, existing
   settings link, `badge badge-amber`, and `role="status"`.
2. `liveModels=true` + `{ status: "ok" }` renders existing generic empty guidance and no
   failure badge.
3. Existing `liveModels=false` test remains and renders no failure badge even if no status
   exists.

#### MODIFY `tests/models-page-groups.test.ts`

Extend the configured zero-row provider fixture with a failed discovery object and assert
the resulting group preserves it. This prevents the API metadata from being dropped at the
pure grouping seam.

### Claude helper UX

#### MODIFY `gui/src/pages/ClaudeCode.tsx`

Replace the helper-only use of the misleading old keys with new keys; keep the old keys in
dictionaries for compatibility and to avoid #337-adjacent edits.

Extract a focused render seam:

```tsx
export function SmallFastModelSetting({
  value,
  options,
  onChange,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const t = useT();
  return (
    <>
      <div className="h-section">{t("claude.smallFastModel")}</div>
      <p className="muted text-label" style={{ margin: "0 0 8px" }}>
        {t("claude.smallFastModelAccurateHint")}
      </p>
      <Select value={value} options={options} onChange={onChange}
        label={t("claude.smallFastModel")} style={{ maxWidth: 420 }} />
      {value === "" && (
        <p className="notice-warn" role="note" style={{ marginTop: 8 }}>
          {t("claude.smallFastModelNativeWarning")}
        </p>
      )}
    </>
  );
}
```

Import `SelectOption` as a type from `../ui`. Build the empty option with the new key:

```ts
return [
  { value: "", label: t("claude.smallFastModelUnsetOption") },
  ...options,
];
```

Replace `:348-356` with `SmallFastModelSetting`. The callback remains exactly
`smallFastModel => setState({ ...state, smallFastModel })`; saving and runtime behavior are
unchanged. A selected value hides only the warning, not the accurate neutral description.

#### NEW `gui/tests/claude-code-background-helper.test.tsx`

Use `renderToStaticMarkup` + `LanguageProvider`, matching
`gui/tests/claude-code-autoconnect.test.tsx:1-31`.

- Unset (`value=""`): rendered selected label says “Let Claude Code choose (native
  model)”; neutral description is present; warning says native Sonnet may be used and may
  incur provider charges; `role="note"` is present.
- Set (`value="gemini/gemini-3-flash"`): selected routed model remains visible; neutral
  description remains; native Sonnet/cost warning and `role="note"` are absent.

The runtime no-override behavior is already asserted at `tests/claude-cli.test.ts:214`; run
that file in focused C rather than duplicating the same backend assertion in a GUI test.

### GUI locale additions — six files, new keys only

#### MODIFY `gui/src/i18n/en.ts`

```ts
"models.discoveryFailedBadge": "Discovery failed",
"models.discoveryFailedHttp": "Model discovery failed (HTTP {status}).",
"models.discoveryFailedBlocked": "Model discovery was blocked by the destination policy.",
"models.discoveryFailedInvalidResponse": "Model discovery returned an invalid response.",
"models.discoveryFailedNetwork": "Model discovery failed due to a network error.",
"models.discoveryFailedProvider": "The provider reported a model discovery error.",
"models.discoveryFailedGeneric": "Model discovery failed.",
"claude.smallFastModelAccurateHint": "The model Claude Code uses for background work such as chat summaries and topic detection. The haiku subagent alias uses it too.",
"claude.smallFastModelUnsetOption": "Let Claude Code choose (native model)",
"claude.smallFastModelNativeWarning": "When unset, OpenCodex leaves the helper-model overrides unset. Claude Code may use its native Sonnet model, which may incur charges from your native provider.",
```

#### MODIFY `gui/src/i18n/de.ts`

```ts
"models.discoveryFailedBadge": "Erkennung fehlgeschlagen",
"models.discoveryFailedHttp": "Die Modellerkennung ist fehlgeschlagen (HTTP {status}).",
"models.discoveryFailedBlocked": "Die Modellerkennung wurde durch die Zielrichtlinie blockiert.",
"models.discoveryFailedInvalidResponse": "Die Modellerkennung lieferte eine ungültige Antwort.",
"models.discoveryFailedNetwork": "Die Modellerkennung ist an einem Netzwerkfehler gescheitert.",
"models.discoveryFailedProvider": "Der Anbieter meldete einen Fehler bei der Modellerkennung.",
"models.discoveryFailedGeneric": "Die Modellerkennung ist fehlgeschlagen.",
"claude.smallFastModelAccurateHint": "Das Modell, das Claude Code für Hintergrundaufgaben wie Chat-Zusammenfassungen und Themenerkennung verwendet. Auch der haiku-Alias der Subagenten nutzt es.",
"claude.smallFastModelUnsetOption": "Claude Code wählen lassen (natives Modell)",
"claude.smallFastModelNativeWarning": "Wenn kein Modell gewählt ist, setzt OpenCodex keine Hilfsmodell-Overrides. Claude Code kann dann sein natives Sonnet-Modell verwenden, wodurch Kosten bei deinem nativen Anbieter entstehen können.",
```

#### MODIFY `gui/src/i18n/ja.ts`

```ts
"models.discoveryFailedBadge": "検出に失敗",
"models.discoveryFailedHttp": "モデル検出に失敗しました（HTTP {status}）。",
"models.discoveryFailedBlocked": "モデル検出は宛先ポリシーによりブロックされました。",
"models.discoveryFailedInvalidResponse": "モデル検出が無効な応答を返しました。",
"models.discoveryFailedNetwork": "ネットワークエラーによりモデル検出に失敗しました。",
"models.discoveryFailedProvider": "プロバイダーがモデル検出エラーを報告しました。",
"models.discoveryFailedGeneric": "モデル検出に失敗しました。",
"claude.smallFastModelAccurateHint": "チャットの要約やトピック検出など、Claude Code がバックグラウンド処理に使うモデルです。サブエージェントの haiku エイリアスもこのモデルを使います。",
"claude.smallFastModelUnsetOption": "Claude Code に選択させる（ネイティブモデル）",
"claude.smallFastModelNativeWarning": "未設定の場合、OpenCodex はヘルパーモデルの上書きを設定しません。Claude Code がネイティブの Sonnet モデルを使用し、ネイティブプロバイダーで料金が発生する可能性があります。",
```

#### MODIFY `gui/src/i18n/ko.ts`

```ts
"models.discoveryFailedBadge": "검색 실패",
"models.discoveryFailedHttp": "모델 검색에 실패했습니다(HTTP {status}).",
"models.discoveryFailedBlocked": "대상 정책 때문에 모델 검색이 차단되었습니다.",
"models.discoveryFailedInvalidResponse": "모델 검색이 잘못된 응답을 받았습니다.",
"models.discoveryFailedNetwork": "네트워크 오류로 모델 검색에 실패했습니다.",
"models.discoveryFailedProvider": "프로바이더가 모델 검색 오류를 보고했습니다.",
"models.discoveryFailedGeneric": "모델 검색에 실패했습니다.",
"claude.smallFastModelAccurateHint": "Claude Code가 대화 요약, 주제 감지 같은 백그라운드 작업에 쓰는 모델입니다. 서브에이전트의 haiku 별칭도 이 모델을 사용합니다.",
"claude.smallFastModelUnsetOption": "Claude Code가 선택(네이티브 모델)",
"claude.smallFastModelNativeWarning": "비워 두면 OpenCodex가 보조 모델 환경 변수를 설정하지 않습니다. Claude Code가 네이티브 Sonnet 모델을 사용할 수 있으며, 네이티브 프로바이더 요금이 발생할 수 있습니다.",
```

#### MODIFY `gui/src/i18n/ru.ts`

```ts
"models.discoveryFailedBadge": "Ошибка обнаружения",
"models.discoveryFailedHttp": "Не удалось обнаружить модели (HTTP {status}).",
"models.discoveryFailedBlocked": "Обнаружение моделей заблокировано политикой назначения.",
"models.discoveryFailedInvalidResponse": "Обнаружение моделей вернуло недопустимый ответ.",
"models.discoveryFailedNetwork": "Обнаружение моделей не удалось из-за сетевой ошибки.",
"models.discoveryFailedProvider": "Провайдер сообщил об ошибке обнаружения моделей.",
"models.discoveryFailedGeneric": "Не удалось обнаружить модели.",
"claude.smallFastModelAccurateHint": "Модель, которую Claude Code использует для фоновых задач, например суммаризации чатов и определения тем. Её также использует алиас подагента haiku.",
"claude.smallFastModelUnsetOption": "Разрешить Claude Code выбрать нативную модель",
"claude.smallFastModelNativeWarning": "Если модель не выбрана, OpenCodex не задаёт переопределения вспомогательной модели. Claude Code может использовать нативную модель Sonnet, что может привести к расходам у вашего нативного провайдера.",
```

#### MODIFY `gui/src/i18n/zh.ts`

```ts
"models.discoveryFailedBadge": "发现失败",
"models.discoveryFailedHttp": "模型发现失败（HTTP {status}）。",
"models.discoveryFailedBlocked": "模型发现被目标策略阻止。",
"models.discoveryFailedInvalidResponse": "模型发现返回了无效响应。",
"models.discoveryFailedNetwork": "由于网络错误，模型发现失败。",
"models.discoveryFailedProvider": "提供方报告了模型发现错误。",
"models.discoveryFailedGeneric": "模型发现失败。",
"claude.smallFastModelAccurateHint": "Claude Code 用于聊天摘要、主题识别等后台工作的模型。子代理的 haiku 别名也使用此模型。",
"claude.smallFastModelUnsetOption": "让 Claude Code 选择（原生模型）",
"claude.smallFastModelNativeWarning": "留空时，OpenCodex 不会设置辅助模型覆盖项。Claude Code 可能使用其原生 Sonnet 模型，并可能产生原生提供方费用。",
```

Do not edit or delete existing `claude.smallFastModelHint` or `claude.slotUnset`; only this
component stops rendering them. Add the three `models.*` keys beside existing empty-discovery
keys and the three `claude.*` keys beside existing small-fast keys in every dictionary.

### Documentation sync

The runtime behavior does not change, but the user-facing meaning of “unset” is materially
corrected. AGENTS.md requires user-facing behavior documentation not to contradict the GUI,
so docs sync is **IN**. Add one sentence after each guide's effective-Haiku paragraph saying:
when both `tierModels.haiku` and `smallFastModel` are absent, OpenCodex leaves both helper
variables unset; Claude Code then chooses its native helper model (currently Sonnet), which
may incur native-provider charges.

#### MODIFY

- `docs-site/src/content/docs/guides/claude-code.md`
- `docs-site/src/content/docs/ko/guides/claude-code.md`
- `docs-site/src/content/docs/zh-cn/guides/claude-code.md`
- `docs-site/src/content/docs/ja/guides/claude-code.md`
- `docs-site/src/content/docs/ru/guides/claude-code.md`

There is no German docs locale in this repository; do not create one in this bugfix cycle.
Keep the five existing guide locales semantically equivalent. No Models-page guide change is
needed because the API field is additive and the existing recovery action remains provider
settings/manual model addition.

### Planning artifact rename

- **NEW** `devlog/_plan/260724_bugfix_train/040_ux_discovery_badge.md` — this document.
- **DELETE** `devlog/_plan/260724_bugfix_train/040_phase4.md` — empty scaffold replaced by
  the diff-level named phase document.

## #337 collision proof and landing discipline

Live command used on 2026-07-24:

```bash
gh pr diff 337 --repo lidge-jun/opencodex --name-only
gh pr diff 337 --repo lidge-jun/opencodex \
  | rg '^diff --git|^@@|^[+-]  "[^"]+"'
```

Observed #337 GUI ownership:

- files: `gui/src/components/CodexAccountPool.tsx`, `gui/src/codex-auto-switch.ts`, all
  six `gui/src/i18n/*.ts`, `gui/src/styles.css`, and
  `gui/tests/codex-account-auto-switch.test.tsx`;
- i18n hunk namespace: existing/new `codexAuth.autoSwitch*` keys plus
  `codexAuth.loadFailed` only (en hunk near line 896; analogous locale hunks);
- CSS hunks: additions near current lines 727 and 959 for `.toggle:disabled` and
  `.codex-auto-switch-*` rules;
- docs: localized `guides/web-dashboard.md`, not `guides/claude-code.md`.

Cycle 4 overlaps #337 only at the six locale **files**, not at keys or hunks. Cycle 4 adds
only these namespaces/keys:

```text
models.discoveryFailedBadge
models.discoveryFailedHttp
models.discoveryFailedGeneric
claude.smallFastModelAccurateHint
claude.smallFastModelUnsetOption
claude.smallFastModelNativeWarning
```

They are inserted beside `models.emptyDiscovery*` and `claude.smallFastModel*`, never in
the `codexAuth.*` hunk. Cycle 4 does not touch `CodexAccountPool.tsx`,
`codex-auto-switch.ts`, the auto-switch test, or `styles.css`; it reuses existing badge and
warning classes. Its docs files are `guides/claude-code.md`, disjoint from #337's
`guides/web-dashboard.md`. Before commit, rerun both diff commands and fail the cycle if
#337 has expanded into any listed Cycle 4 key, component, test, or docs hunk.

## Activation scenarios and test matrix

| Scenario | Trigger | Required observation |
|---|---|---|
| Failed discovery 401 | Live provider `/models` returns HTTP 401 with no stale/configured rows | `getProviderDiscoveryStatus` and `/api/providers` expose `failed/http/401`; Models retains the provider, renders `Discovery failed` + `HTTP 401` badge/warning + settings link |
| Destination blocked | `providerDestinationResolvedError` rejects a public-discovery fixture before `fetch` | status and `/api/providers` expose `failed/blocked` with no `httpStatus`; fetch is not called; empty provider renders failure badge + localized blocked reason + settings link |
| Invalid response | Table-driven 2xx fixtures: invalid JSON and valid JSON whose `data` is missing/malformed | each subcase exposes `failed/invalid_response` with no `httpStatus`; fallback rows are preserved; empty provider renders failure badge + localized invalid-response reason |
| Network failure | `fetch` rejects with a synthetic `TypeError` or timeout `DOMException` without sensitive message text entering state | status and API expose only `failed/network`; empty provider renders failure badge + localized network reason; thrown message/URL is absent |
| Provider-specific failure | Cursor `fetchCursorUsableModels` returns `{ ok:false, error:<sanitized fixture> }` | status and API expose only `failed/provider`; configured fallback remains; empty-provider fixture renders failure badge + localized provider reason without raw provider detail |
| Successful discovery | Same provider returns valid `{ data: [] }` or model rows after cache/status clear or cooldown expiry | status becomes `{ status: "ok" }`; empty authoritative result has generic guidance and no failure badge; model rows render normally |
| No attempt/static path | `liveModels: false` or provider has not attempted discovery | `discovery` omitted; existing static-disabled guidance; no failure badge |
| Helper unset | `smallFastModel === ""` | picker says Claude Code chooses a native model; native Sonnet/cost warning is visible; runtime helper env vars remain undefined |
| Helper set | `smallFastModel === "gemini/gemini-3-flash"` | selected routed model remains; warning is hidden; existing runtime maps both helper env vars to that value |

Focused commands:

```bash
bun test tests/codex-catalog.test.ts
bun test tests/management-provider-validation.test.ts
bun test tests/models-page-groups.test.ts
bun test gui/tests/models-empty-provider.test.tsx
bun test gui/tests/claude-code-background-helper.test.tsx
bun test tests/claude-cli.test.ts tests/claude-context-windows.test.ts
```

## C verification

Run from repository root, fresh, and retain exit codes/output in the parent evidence record:

```bash
bun run typecheck
bun run test
bun run lint:gui
bun run build:gui
bun run privacy:scan
```

Expected: exit 0 for all five. `privacy:scan` is a hard gate because discovery diagnostics
must not expose URLs, bodies, keys, account IDs, thrown messages, or upstream status text.

### C-ACTIVATION-GROUNDING-01

1. **401:** fault-inject a `Response(null, { status: 401 })`; observe both the backend
   status assertion and SSR badge/reason assertion execute.
2. **Blocked — mandatory named test:**
   `test("destination-blocked discovery exposes blocked status and badge", async () => { ... })`.
   Use a destination-policy rejection fixture, assert no fetch, exact API DTO
   `{status:"failed",reason:"blocked"}`, and SSR badge plus localized blocked reason.
3. **Invalid response — mandatory named test:**
   `test("invalid JSON or malformed model data exposes invalid-response status and badge", async () => { ... })`.
   Run invalid JSON and malformed-`data` 2xx subcases, assert exact API DTO
   `{status:"failed",reason:"invalid_response"}`, fallback preservation, and SSR badge/reason.
4. **Network — mandatory named test:**
   `test("network discovery failure exposes sanitized network status and badge", async () => { ... })`.
   Reject fetch with a synthetic error carrying a sentinel secret/message; assert exact API DTO
   `{status:"failed",reason:"network"}`, SSR badge/reason, and absence of the sentinel from JSON/HTML.
5. **Provider-specific — mandatory named test:**
   `test("Cursor discovery failure exposes provider status and badge", async () => { ... })`.
   Return Cursor `ok:false`, assert exact API DTO `{status:"failed",reason:"provider"}`, configured
   fallback preservation, and SSR badge/reason without raw provider error detail.
6. **Status reset — mandatory named test:**
   `test("successful discovery clears every prior failure reason", async () => { ... })`.
   Table-drive prior `blocked`, `http`, `invalid_response`, `network`, and `provider` statuses; perform
   the appropriate successful live attempt and assert `{status:"ok"}` plus no failure badge/reason.
   Then call `clearModelCache(provider)` and assert the provider returns to omitted/`unknown`, proving
   per-test/provider reset rather than status leakage.
7. **Recovery/ok:** perform a valid live response after clearing status/cache (or advancing
   beyond cooldown); observe `{ status: "ok" }` and an explicit no-badge assertion.
8. **Helper unset/set:** render the extracted setting twice and read both HTML outputs;
   assert warning presence only in the unset output. Run existing Claude runtime tests to
   confirm unset still emits no helper variables and set still emits both.

All eight activation items are mandatory. Backend cases may be table-driven, but the four non-HTTP
reason-code tests and status-reset test must retain the exact names, API assertions, and applicable
empty-provider SSR badge assertions above.

### C-RENDER-GROUNDING-01

After `bun run build:gui` succeeds:

1. Start an isolated mock provider whose `/v1/models` returns 401. Start an isolated
   OpenCodex runtime with both `OPENCODEX_HOME` and `CODEX_HOME` pointed at temporary
   directories, a non-live port, one enabled `liveModels` provider with `models: []`, and
   `allowPrivateNetwork: true`. Do not touch the user's live 10100 runtime.
2. Confirm via HTTP that isolated `GET /api/providers` contains
   `discovery: { status: "failed", reason: "http", httpStatus: 401 }` before browser QA.
3. Start Vite with `OPENCODEX_PROXY_TARGET` set to the isolated runtime. Use the native
   in-app browser QA ladder (do not install Playwright), open the Models page at 1280×720,
   expand the zero-model provider if needed, and capture a screenshot.
4. Open/read the screenshot. Record that the amber failure badge, `HTTP 401` reason,
   provider name, manual `+` action, and provider-settings link are visible without clipping,
   overlap, color-only meaning, or accidental collapse. Also inspect browser console/network.
5. If observation finds a defect, fix, rebuild, re-render, and re-observe; stop after one
   clean observation. Record screenshot path and observation in C evidence, then terminate
   Vite, mock provider, and isolated runtime and record teardown receipts.

Also visit the Claude page in the same render session and observe the unset native
Sonnet/cost warning; choose a routed helper model and observe the warning disappear. The
badge screenshot is the mandatory persisted artifact for this C2-C3 UI repair.

## Implementation order and atomicity

1. Add model-cache status lifecycle and provider-fetch recording; run catalog tests.
2. Add the management DTO field and API contract test.
3. Thread status through pure grouping and render the empty failure badge; run group/SSR
   tests.
4. Add new i18n keys, helper setting seam, and set/unset SSR tests.
5. Sync all existing Claude Code guide locales.
6. Run focused tests, all five gates, collision recheck, activation checks, and rendered QA.

Keep implementation commits atomic by the above boundaries. Do not push without the
parent's explicit authorization. Any divergence from this map is reported to the parent
before expanding scope.
