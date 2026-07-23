# 041 — Fix issue #300: multi-agent guidance kill switch

Date: 2026-07-23 (Asia/Seoul)
Scope: issue #300 only; implement after/rebase over 040
Implementation file count: **19 MODIFY, 0 NEW**
Automated regression count: **11 cases**

## 1. Acceptance contract

1. `multiAgentGuidanceEnabled: false` prevents all proxy-authored v1 and v2 multi-agent developer-message injection.
2. `undefined` and `true` preserve existing activation behavior; existing configs need no migration.
3. The first implementation change is to make `PUT /api/injection-model` a true partial update: absent `model`, `effort`, and `prompt` preserve stored values; explicit model clear still clears effort.
4. The handler validates the complete payload before mutating the in-memory config or saving it.
5. A Dashboard flag-only PUT cannot clear `injectionModel`, `injectionEffort`, or `injectionPrompt`.
6. False leaves `multiAgentMode`, `subagentModels`, catalog sync/version/priority, effort caps, routing, and Claude definitions unchanged.
7. The setting survives API save, model sync, process reload, and Dashboard reload.

## 2. Dependency-ordered file map

| Order | Action | Current anchor | Path | Exact change |
|---:|---|---|---|---|
| 1 | MODIFY | `:1115-1143` | `src/server/management-api.ts` | First fix absent-key preservation and validate-before-mutate; then add the flag to GET/PUT responses. |
| 2 | MODIFY | `:374-448` | `src/types.ts` | Add optional `multiAgentGuidanceEnabled?: boolean` beside guidance configuration. |
| 3 | MODIFY | `:412-419`, `:727-753` | `src/config.ts` | Add explicit optional boolean validation, effective-default helper, and fresh-config true. |
| 4 | MODIFY | `:201-235`, `:897-910` | `src/server/responses.ts` | Refactor guidance arguments to an options object and return `null` before surface/roster work when false. |
| 5 | MODIFY | `:194-198`, `:261-269`, `:732-792` | `gui/src/pages/Dashboard.tsx` | Load effective state, add the flag-only switch, preserve displayed settings, and disable guidance selectors while off. |
| 6 | MODIFY | `:79-84` | `gui/src/i18n/en.ts` | Add exact keys `dash.multiAgentGuidance` and `dash.multiAgentGuidanceHint`. |
| 7 | MODIFY | `:70-75` | `gui/src/i18n/de.ts` | Add the same two keys in German. |
| 8 | MODIFY | `:74-79` | `gui/src/i18n/ko.ts` | Add the same two keys in Korean. |
| 9 | MODIFY | `:74-79` | `gui/src/i18n/zh.ts` | Add the same two keys in Chinese. |
| 10 | MODIFY | `:79-84` | `gui/src/i18n/ru.ts` | Add the same two keys in Russian. |
| 11 | MODIFY | `:79-84` | `gui/src/i18n/ja.ts` | Add the same two keys in Japanese. |
| 12 | MODIFY | `:81-109`, config-invalid cases near `:279-390` | `tests/config.test.ts` | Add default/helper and schema-validation regressions. |
| 13 | MODIFY | `:28-108` | `tests/injection-model-api.test.ts` | Test the actual handler's partial-update, atomicity, preservation, and persistence paths. |
| 14 | MODIFY | `:60-323` | `tests/multi-agent-compat.test.ts` | Update calls to the options object and add disabled/unset/true behavior cases. |
| 15 | MODIFY | after `injectionPrompt` row `:40` | `docs-site/src/content/docs/reference/configuration.md` | Add the boolean row and API/default semantics. |
| 16 | MODIFY | after `injectionPrompt` row `:38` | `docs-site/src/content/docs/ja/reference/configuration.md` | Add the same configuration contract in Japanese. |
| 17 | MODIFY | after `injectionPrompt` row `:39` | `docs-site/src/content/docs/ko/reference/configuration.md` | Add the same configuration contract in Korean. |
| 18 | MODIFY | after `injectionPrompt` row `:43` | `docs-site/src/content/docs/ru/reference/configuration.md` | Add the same configuration contract in Russian. |
| 19 | MODIFY | after `injectionPrompt` row `:37` | `docs-site/src/content/docs/zh-cn/reference/configuration.md` | Add the same configuration contract in Chinese. |

## 3. `src/server/management-api.ts` — mandatory first change

### Current failure anchor

At `src/server/management-api.ts:1119-1134`, `model` lacks key-presence semantics:

```ts
const model = typeof body.model === "string" && body.model.length > 0 ? body.model : undefined;
let effort = config.injectionEffort;
if ("effort" in body) {
  const requestedEffort = typeof body.effort === "string" && body.effort.length > 0 ? body.effort : undefined;
  if (requestedEffort !== undefined && !isCodexReasoningEffort(requestedEffort)) {
    return jsonResponse({ error: `unknown reasoning effort "${requestedEffort}"` }, 400);
  }
  effort = requestedEffort;
}
if (!model) effort = undefined;
if (model) config.injectionModel = model;
else delete config.injectionModel;
if (effort) config.injectionEffort = effort;
else delete config.injectionEffort;
```

Therefore `{ "multiAgentGuidanceEnabled": false }` would currently derive `model = undefined`, delete `injectionModel`, and clear `injectionEffort`.

### Required after state

Replace the whole PUT parse/validate/mutate block at `:1115-1143`; do not patch only the new flag:

```ts
if (url.pathname === "/api/injection-model" && req.method === "PUT") {
  let parsedBody: unknown;
  try { parsedBody = await req.json(); } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return jsonResponse({ error: "body must be a JSON object" }, 400);
  }
  const body = parsedBody as {
    multiAgentGuidanceEnabled?: unknown;
    model?: unknown;
    effort?: unknown;
    prompt?: unknown;
  };
  const { isCodexReasoningEffort } = await import("../reasoning-effort");

  let nextEnabled = config.multiAgentGuidanceEnabled;
  let nextModel = config.injectionModel;
  let nextEffort = config.injectionEffort;
  let nextPrompt = config.injectionPrompt;

  if ("multiAgentGuidanceEnabled" in body) {
    if (typeof body.multiAgentGuidanceEnabled !== "boolean") {
      return jsonResponse({ error: "multiAgentGuidanceEnabled must be a boolean" }, 400);
    }
    nextEnabled = body.multiAgentGuidanceEnabled;
  }
  if ("model" in body) {
    if (body.model === null || body.model === "") nextModel = undefined;
    else if (typeof body.model === "string" && body.model.length > 0) nextModel = body.model;
    else return jsonResponse({ error: "model must be a non-empty string or null" }, 400);
  }
  if ("effort" in body) {
    if (body.effort === null || body.effort === "") nextEffort = undefined;
    else if (typeof body.effort === "string" && isCodexReasoningEffort(body.effort)) {
      nextEffort = body.effort;
    } else {
      return jsonResponse({ error: `unknown reasoning effort "${String(body.effort)}"` }, 400);
    }
  }
  if ("prompt" in body) {
    if (typeof body.prompt === "string" && body.prompt.trim().length > 0) nextPrompt = body.prompt;
    else if (body.prompt === null || body.prompt === "") nextPrompt = undefined;
    else return jsonResponse({ error: "prompt must be a string or null" }, 400);
  }
  if (!nextModel) nextEffort = undefined;

  config.multiAgentGuidanceEnabled = nextEnabled;
  if (nextModel) config.injectionModel = nextModel;
  else delete config.injectionModel;
  if (nextEffort) config.injectionEffort = nextEffort;
  else delete config.injectionEffort;
  if (nextPrompt) config.injectionPrompt = nextPrompt;
  else delete config.injectionPrompt;

  saveConfig(config);
  return jsonResponse({
    ok: true,
    multiAgentGuidanceEnabled: multiAgentGuidanceEnabled(config),
    model: config.injectionModel ?? null,
    effort: config.injectionEffort ?? null,
    prompt: config.injectionPrompt ?? null,
  });
}
```

Before using `multiAgentGuidanceEnabled`, add it to the existing import from `../config` at `src/server/management-api.ts:4-12`.

Extend current GET response at `:1107-1113`:

```ts
return jsonResponse({
  multiAgentGuidanceEnabled: multiAgentGuidanceEnabled(config),
  model: config.injectionModel ?? null,
  effort: config.injectionEffort ?? null,
  prompt: config.injectionPrompt ?? null,
  efforts: CODEX_REASONING_LEVELS.map(level => level.effort),
  available: [...nativeModels, ...routedModels],
});
```

### Handler truth table

| Payload key state | Result |
|---|---|
| `model` absent | Preserve model and effort. |
| `model: null` or `""` | Clear model and effort. |
| valid non-empty `model` | Set model; absent effort remains preserved. |
| `effort` absent | Preserve effort unless model is explicitly cleared. |
| `effort: null` or `""` | Clear effort only. |
| `prompt` absent | Preserve prompt. |
| flag absent | Preserve stored flag. |
| flag true/false | Persist exact boolean. |
| top-level `null`, array, or scalar | HTTP 400 before any `in` check. |
| malformed field | HTTP 400 with no mutation and no disk write. |

## 4. Config/type diff

### `src/types.ts:400-407`

Before: `injectionPrompt?` is followed directly by `effortCap?`.

After:

```ts
injectionPrompt?: string;
/**
 * Proxy-authored multi-agent developer guidance. Undefined/true = enabled for
 * backward compatibility; false suppresses both v1 and v2 guidance injection.
 */
multiAgentGuidanceEnabled?: boolean;
```

### `src/config.ts:412-419`

Before:

```ts
contextCapValue: z.number().int().positive().optional(),
}).passthrough().superRefine((config, ctx) => {
```

After:

```ts
contextCapValue: z.number().int().positive().optional(),
multiAgentGuidanceEnabled: z.boolean().optional(),
}).passthrough().superRefine((config, ctx) => {
```

Add beside `codexAutoStartEnabled()` at `:727-729`:

```ts
export function multiAgentGuidanceEnabled(
  config: Pick<OcxConfig, "multiAgentGuidanceEnabled">,
): boolean {
  return config.multiAgentGuidanceEnabled !== false;
}
```

Add to `getDefaultConfig()` immediately after `subagentModels` at `:750`:

```ts
multiAgentGuidanceEnabled: true,
```

Do not add a migration or a Zod default. Existing valid files remain valid and can retain `undefined`; all effective reads use the helper.

## 5. `src/server/responses.ts` diff

Current function/call anchors are `:201` and `:905`. After 040 lands, replace the complete function, including its 040 roster interdiff, with the following deterministic body.

```ts
import type { EffectiveSubagentRoster, SpawnAgentSurface } from "../codex/catalog";

export interface MultiAgentGuidanceOptions {
  multiAgentGuidanceEnabled?: boolean;
  injectionModel?: string;
  injectionEffort?: string;
  subagentModels?: string[];
  injectionPrompt?: string;
}

export interface MultiAgentGuidanceDeps {
  resolveEffectiveSubagentRoster?: (
    configuredModels: readonly string[],
    surface: SpawnAgentSurface,
  ) => EffectiveSubagentRoster | Promise<EffectiveSubagentRoster>;
}

async function resolveEffectiveSubagentRoster(
  configuredModels: readonly string[],
  surface: SpawnAgentSurface,
): Promise<EffectiveSubagentRoster> {
  const { effectiveSubagentRoster } = await import("../codex/catalog");
  return effectiveSubagentRoster(configuredModels, surface);
}

export async function multiAgentGuidanceText(
  parsed: OcxParsedRequest,
  options: MultiAgentGuidanceOptions = {},
  deps: MultiAgentGuidanceDeps = {},
): Promise<string | null> {
  if (options.multiAgentGuidanceEnabled === false) return null;
  const {
    injectionModel,
    injectionEffort,
    subagentModels,
    injectionPrompt,
  } = options;
  const surface = collabSurface(parsed);
  if (surface === null) return null;

  if (surface === "v2") {
    const configuredForGuidance = [
      ...(subagentModels ?? []),
      ...(injectionModel ? [injectionModel] : []),
    ];
    const resolveRoster = deps.resolveEffectiveSubagentRoster ?? resolveEffectiveSubagentRoster;
    const effective = await resolveRoster(configuredForGuidance, "v2");
    const rosterModels = effective.advertised.filter(candidate =>
      (subagentModels ?? []).some(model => slugsEquivalent(model, candidate.model))
    );
    const roster = subagentRosterText(rosterModels);
    const preferred = injectionModel
      ? effective.candidates.find(candidate => slugsEquivalent(injectionModel, candidate.model))
      : undefined;

    if (isInjectionDebugEnabled() && effective.excluded.length > 0) {
      injectionDebugLog(`[opencodex] multi-agent guidance excluded: ${effective.excluded
        .map(item => `${item.configured}:${item.reason}`)
        .join(", ")}`);
    }
    if (!injectionModel && roster === "") return null;
    if (injectionPrompt) {
      return `<multi_agent_mode>${applyInjectionPlaceholders(
        injectionPrompt,
        injectionModel,
        injectionEffort,
        roster,
      )}</multi_agent_mode>`;
    }
    if (!preferred && roster === "") return null;

    let text = "When the active spawn_agent tool supports optional \"model\" or \"reasoning_effort\" overrides, "
      + "use only models listed for this collaboration surface. "
      + "When setting either override, set fork_turns to \"none\" "
      + "(or a positive turn count such as \"3\"; full-history forks reject overrides) "
      + "and make the task message self-contained.";
    if (preferred) {
      text += ` Preferred sub-agent: model "${preferred.model}"`
        + (injectionEffort ? `, reasoning_effort "${injectionEffort}"` : "")
        + " — use it unless the user names another.";
    }
    text += roster;
    if (text.length > V2_GUIDANCE_CHAR_BUDGET) {
      text = text.slice(0, text.length - roster.length);
    }
    return `<multi_agent_mode>${text}</multi_agent_mode>`;
  }

  const effort = parsed.options.reasoning;
  if (effort !== "max" && effort !== "ultra") return null;
  return `<multi_agent_mode>${PROACTIVE_MULTI_AGENT_MODE_TEXT}</multi_agent_mode>`;
}
```

The early return occurs before `collabSurface`, the default resolver's dynamic catalog import, placeholder substitution, and both v1/v2 branches. The dependency seam is production-neutral and exists so the regression can prove that false performs no catalog work.

Replace current call at `:905`:

```ts
const guidance = await multiAgentGuidanceText(parsed, {
  multiAgentGuidanceEnabled: config.multiAgentGuidanceEnabled,
  injectionModel: config.injectionModel,
  injectionEffort: config.injectionEffort,
  subagentModels: config.subagentModels,
  injectionPrompt: config.injectionPrompt,
});
```

Keep `if (guidance) injectDeveloperMessage(...)`. Add `guidanceEnabled=${multiAgentGuidanceEnabled(config)}` to the existing silent debug line at `:909-910`; import the helper into `responses.ts` from `../config`.

## 6. Dashboard and i18n diff

### Dashboard state/load

At `Dashboard.tsx:194-198`, add:

```tsx
const [multiAgentGuidanceEnabled, setMultiAgentGuidanceEnabled] = useState(true);
```

Replace the one-line GET type at `:264` with:

```tsx
const imData = await imRes.json() as {
  multiAgentGuidanceEnabled?: boolean;
  model?: string | null;
  effort?: string | null;
  efforts?: string[];
  available?: Array<{ provider: string; model: string; namespaced: string }>;
};
setMultiAgentGuidanceEnabled(imData.multiAgentGuidanceEnabled !== false);
```

### Dashboard switch

Insert at the start of the existing panel (`:732-735`), before the model selector row:

```tsx
<div className="spread setting-row">
  <div className="setting-copy" style={{ flex: 1 }}>
    <div className="font-semibold">{t("dash.multiAgentGuidance")}</div>
    <div className="muted setting-hint">{t("dash.multiAgentGuidanceHint")}</div>
  </div>
  <button
    type="button"
    className={`switch ${multiAgentGuidanceEnabled ? "on" : ""}`}
    onClick={async () => {
      if (injectionSaving) return;
      setInjectionSaving(true);
      try {
        const res = await fetch(`${apiBase}/api/injection-model`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ multiAgentGuidanceEnabled: !multiAgentGuidanceEnabled }),
        });
        if (res.ok) {
          const data = await res.json() as { multiAgentGuidanceEnabled?: boolean };
          setMultiAgentGuidanceEnabled(data.multiAgentGuidanceEnabled !== false);
        }
      } catch { /* keep current value */ }
      finally { setInjectionSaving(false); }
    }}
    disabled={injectionSaving}
    aria-label={t("dash.multiAgentGuidance")}
    aria-pressed={multiAgentGuidanceEnabled}
  >
    <span className="knob" />
  </button>
</div>
```

Change both current selector `disabled={injectionSaving}` expressions (`:758`, `:785`) to `disabled={injectionSaving || !multiAgentGuidanceEnabled}`. Change the active badge condition at `:789` to `multiAgentGuidanceEnabled && injectionModel`. Keep values rendered; false must not blank local state.

### Exact locale keys

For each file, replace the literal one-line anchor with the three-line block shown.

`gui/src/i18n/en.ts:80` before:

```ts
"dash.injectionHint": "Pick a routed model to inject into the delegation prompt. The agent will be told to use it for sub-tasks.",
```

After:

```ts
"dash.injectionHint": "Pick a routed model to inject into the delegation prompt. The agent will be told to use it for sub-tasks.",
"dash.multiAgentGuidance": "OpenCodex multi-agent guidance",
"dash.multiAgentGuidanceHint": "Adds OpenCodex-authored delegation instructions. Turning this off keeps the v1/v2 surface, sub-agent roster, routing, and effort caps unchanged.",
```

`gui/src/i18n/de.ts:71` before:

```ts
"dash.injectionHint": "Wähle ein geroutetes Modell für den Delegations-Prompt. Der Agent wird angewiesen, es für Teilaufgaben zu nutzen.",
```

After:

```ts
"dash.injectionHint": "Wähle ein geroutetes Modell für den Delegations-Prompt. Der Agent wird angewiesen, es für Teilaufgaben zu nutzen.",
"dash.multiAgentGuidance": "OpenCodex-Multi-Agent-Anleitung",
"dash.multiAgentGuidanceHint": "Fügt von OpenCodex erstellte Delegationshinweise hinzu. Beim Ausschalten bleiben v1/v2-Oberfläche, Sub-Agent-Liste, Routing und Aufwandsgrenzen unverändert.",
```

`gui/src/i18n/ko.ts:75` before:

```ts
"dash.injectionHint": "위임 프롬프트에 주입할 라우팅 모델을 선택합니다. 에이전트가 서브태스크에 이 모델을 사용하도록 안내됩니다.",
```

After:

```ts
"dash.injectionHint": "위임 프롬프트에 주입할 라우팅 모델을 선택합니다. 에이전트가 서브태스크에 이 모델을 사용하도록 안내됩니다.",
"dash.multiAgentGuidance": "OpenCodex 멀티 에이전트 가이던스",
"dash.multiAgentGuidanceHint": "OpenCodex가 작성한 위임 안내를 추가합니다. 꺼도 v1/v2 표면, 서브에이전트 로스터, 라우팅, effort 상한은 바뀌지 않습니다.",
```

`gui/src/i18n/zh.ts:75` before:

```ts
"dash.injectionHint": "选择要注入委托提示的路由模型。代理将被告知在子任务中使用它。",
```

After:

```ts
"dash.injectionHint": "选择要注入委托提示的路由模型。代理将被告知在子任务中使用它。",
"dash.multiAgentGuidance": "OpenCodex 多代理指引",
"dash.multiAgentGuidanceHint": "添加由 OpenCodex 编写的委派指令。关闭后仍保留 v1/v2 界面、子代理清单、路由和 effort 上限。",
```

`gui/src/i18n/ru.ts:80` before:

```ts
"dash.injectionHint": "Выберите маршрутизируемую модель для внедрения в промпт делегирования. Агенту будет указано использовать её для подзадач.",
```

After:

```ts
"dash.injectionHint": "Выберите маршрутизируемую модель для внедрения в промпт делегирования. Агенту будет указано использовать её для подзадач.",
"dash.multiAgentGuidance": "Мультиагентное руководство OpenCodex",
"dash.multiAgentGuidanceHint": "Добавляет инструкции делегирования от OpenCodex. Отключение не меняет поверхность v1/v2, список подагентов, маршрутизацию и пределы effort.",
```

`gui/src/i18n/ja.ts:80` before:

```ts
"dash.injectionHint": "委任プロンプトに注入するルーティングモデルを選択します。エージェントはサブタスクにそれを使うよう指示されます。",
```

After:

```ts
"dash.injectionHint": "委任プロンプトに注入するルーティングモデルを選択します。エージェントはサブタスクにそれを使うよう指示されます。",
"dash.multiAgentGuidance": "OpenCodex マルチエージェントガイダンス",
"dash.multiAgentGuidanceHint": "OpenCodex が作成する委任指示を追加します。オフにしても v1/v2 サーフェス、サブエージェントロスター、ルーティング、effort 上限は変わりません。",
```

## 7. i18n fallback decision

- Runtime evidence: `gui/src/i18n/provider.tsx:15` resolves `DICTS[locale][key] ?? en[key] ?? key`, so a missing translated value would fall back to English at runtime.
- Compile-time evidence: `gui/src/i18n/shared.ts:12` declares `DICTS: Record<Locale, Record<TKey, string>>`; `TKey` comes from English, and `ko/zh/ru/ja` explicitly declare `Record<TKey, string>`. The German inferred object is also assigned to that complete record.
- Decision: update all six locale files in scope. Runtime fallback does not make omission acceptable because `bun run build:gui`/TypeScript requires every English key in every locale dictionary.

## 8. Executable test diff — 11 automated cases

### 8.1 `tests/config.test.ts` — cases 1–2

Add `multiAgentGuidanceEnabled` to the existing import from `../src/config` at `:5-23`, then insert beside the Codex autostart tests at `:81-89`:

```ts
test("multi-agent guidance is default-on and false is the only off state", () => {
  expect(getDefaultConfig().multiAgentGuidanceEnabled).toBe(true);
  expect(multiAgentGuidanceEnabled({})).toBe(true);
  expect(multiAgentGuidanceEnabled({ multiAgentGuidanceEnabled: true })).toBe(true);
  expect(multiAgentGuidanceEnabled({ multiAgentGuidanceEnabled: false })).toBe(false);
});

test("multiAgentGuidanceEnabled loads false and rejects non-booleans", () => {
  const base = {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
  };
  writeConfig({ ...base, multiAgentGuidanceEnabled: false });
  expect(loadConfig().multiAgentGuidanceEnabled).toBe(false);

  for (const invalid of [null, "false"]) {
    writeConfig({ ...base, multiAgentGuidanceEnabled: invalid });
    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("multiAgentGuidanceEnabled");
  }
});
```

### 8.2 `tests/injection-model-api.test.ts` harness

Replace the fs/config imports at `:7-12` with the following superset:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { getConfigPath, loadConfig } from "../src/config";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
```

The existing `put(config, body)` helper at `:32-41` is valid for object, null, array, and scalar JSON and is reused unchanged.

### 8.3 Case 3 — exact flag-only blocker regression

Insert in the existing `/api/injection-model` describe block:

```ts
test("flag-only PUT preserves model, effort, and prompt in memory and on disk", async () => {
  isolatedHome();
  const config = makeConfig({
    multiAgentGuidanceEnabled: true,
    injectionModel: "gpt-5.6-terra",
    injectionEffort: "max",
    injectionPrompt: "RULES {{model}} {{roster}}",
  });

  const response = await put(config, { multiAgentGuidanceEnabled: false });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    multiAgentGuidanceEnabled: false,
    model: "gpt-5.6-terra",
    effort: "max",
    prompt: "RULES {{model}} {{roster}}",
  });
  expect(config).toMatchObject({
    multiAgentGuidanceEnabled: false,
    injectionModel: "gpt-5.6-terra",
    injectionEffort: "max",
    injectionPrompt: "RULES {{model}} {{roster}}",
  });
  const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
  expect(persisted).toMatchObject({
    multiAgentGuidanceEnabled: false,
    injectionModel: "gpt-5.6-terra",
    injectionEffort: "max",
    injectionPrompt: "RULES {{model}} {{roster}}",
  });
});
```

### 8.4 Case 4 — explicit clears remain explicit

```ts
test("explicit model clear clears effort but preserves prompt and guidance flag", async () => {
  isolatedHome();
  const config = makeConfig({
    multiAgentGuidanceEnabled: false,
    injectionModel: "gpt-5.6-terra",
    injectionEffort: "max",
    injectionPrompt: "RULES {{roster}}",
  });

  const response = await put(config, { model: null });
  expect(await response.json()).toEqual({
    ok: true,
    multiAgentGuidanceEnabled: false,
    model: null,
    effort: null,
    prompt: "RULES {{roster}}",
  });
  expect(config.injectionModel).toBeUndefined();
  expect(config.injectionEffort).toBeUndefined();
  expect(config.injectionPrompt).toBe("RULES {{roster}}");
  expect(config.multiAgentGuidanceEnabled).toBe(false);
});
```

### 8.5 Cases 5–7 — top-level malformed JSON shapes

`test.each` creates one regression case for each required shape:

```ts
test.each([
  ["null", null],
  ["array", []],
  ["scalar", "text"],
] as const)("rejects top-level %s before any partial-update key check", async (_label, body) => {
  isolatedHome();
  const config = makeConfig({
    multiAgentGuidanceEnabled: true,
    injectionModel: "gpt-5.6-terra",
    injectionEffort: "high",
    injectionPrompt: "RULES",
  });
  const before = structuredClone(config);

  const response = await put(config, body);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "body must be a JSON object" });
  expect(config).toEqual(before);
  expect(existsSync(getConfigPath())).toBe(false);
});
```

### 8.6 Case 8 — save, sync, restart

```ts
test("guidance flag and injection settings survive save, catalog sync, and reload", async () => {
  isolatedHome();
  const config = makeConfig({
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    multiAgentGuidanceEnabled: true,
    multiAgentMode: "v2",
    subagentModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
    injectionModel: "gpt-5.6-terra",
    injectionEffort: "max",
    injectionPrompt: "RULES {{roster}}",
  });
  await put(config, { multiAgentGuidanceEnabled: false });

  let flagSeenBySync: boolean | undefined;
  await refreshCodexModelCatalog(config, {
    syncCatalogModels: async syncedConfig => {
      flagSeenBySync = syncedConfig.multiAgentGuidanceEnabled;
      return { added: 0, path: join(tempHome!, "missing-catalog.json") };
    },
    invalidateCodexModelsCache: () => {},
    existsSync: () => false,
  });
  expect(flagSeenBySync).toBe(false);
  expect(config.multiAgentMode).toBe("v2");

  const reloaded = loadConfig();
  expect(reloaded).toMatchObject({
    multiAgentGuidanceEnabled: false,
    multiAgentMode: "v2",
    subagentModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
    injectionModel: "gpt-5.6-terra",
    injectionEffort: "max",
    injectionPrompt: "RULES {{roster}}",
  });
});
```

### 8.7 `tests/multi-agent-compat.test.ts` cases 9–11

After converting all existing positional calls to `MultiAgentGuidanceOptions`, insert:

```ts
test("false suppresses v1 top-tier guidance", async () => {
  const text = await multiAgentGuidanceText(
    parsedFixture({
      reasoning: "max",
      tools: [
        { name: "spawn_agent", namespace: "agents" },
        { name: "send_input", namespace: "agents" },
      ],
    }),
    { multiAgentGuidanceEnabled: false },
  );
  expect(text).toBeNull();
});

test("false suppresses v2 before catalog resolution", async () => {
  let rosterCalls = 0;
  const text = await multiAgentGuidanceText(
    parsedFixture({ tools: [{ name: "spawn_agent" }] }),
    {
      multiAgentGuidanceEnabled: false,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      subagentModels: ["gpt-5.6-terra"],
      injectionPrompt: "CUSTOM {{roster}}",
    },
    {
      resolveEffectiveSubagentRoster: () => {
        rosterCalls += 1;
        throw new Error("catalog resolver must not run while guidance is disabled");
      },
    },
  );
  expect(text).toBeNull();
  expect(rosterCalls).toBe(0);
});

test("unset and true preserve identical v1 and v2 guidance", async () => {
  const dir = codexHomeFixture(V2_ON);
  catalogFixture(dir, [{
    slug: "gpt-5.6-terra",
    efforts: ["high", "max"],
    priority: 0,
    multiAgentVersion: "v2",
  }]);
  const v1 = parsedFixture({
    reasoning: "max",
    tools: [
      { name: "spawn_agent", namespace: "agents" },
      { name: "send_input", namespace: "agents" },
    ],
  });
  expect(await multiAgentGuidanceText(v1)).toBe(
    await multiAgentGuidanceText(v1, { multiAgentGuidanceEnabled: true }),
  );

  const v2Options = {
    injectionModel: "gpt-5.6-terra",
    subagentModels: ["gpt-5.6-terra"],
  };
  expect(await multiAgentGuidanceText(
    parsedFixture({ tools: [{ name: "spawn_agent" }] }),
    v2Options,
  )).toBe(await multiAgentGuidanceText(
    parsedFixture({ tools: [{ name: "spawn_agent" }] }),
    { ...v2Options, multiAgentGuidanceEnabled: true },
  ));
});
```

Mechanical call conversion rule for every retained existing case:

```ts
// Before
multiAgentGuidanceText(parsed, model, effort, roster, prompt)
// After
multiAgentGuidanceText(parsed, {
  injectionModel: model,
  injectionEffort: effort,
  subagentModels: roster,
  injectionPrompt: prompt,
})
```

Do not retain a positional compatibility overload.

## 9. Conditional-path activation matrix

| Conditional path | Activation | Expected |
|---|---|---|
| Disabled early return | false with any/no collaboration tools | `null` before surface/roster work. |
| Enabled, no/contradictory surface | unset/true with no valid collab surface | Existing `null`. |
| Enabled v1 below top | unset/true, v1 tools, effort below max/ultra | Existing `null`. |
| Enabled v1 top | unset/true, v1 tools, max/ultra | Existing Proactive text. |
| Enabled v2 no trigger | unset/true, no model/effective roster | Existing `null`. |
| Enabled v2 built-in/custom | unset/true with existing trigger | Existing 040 behavior, including custom placeholders. |
| Flag-only API update | body contains only boolean | Preserve model/effort/prompt, persist flag. |
| Explicit model clear | `model:null` | Clear model + effort, preserve prompt/flag. |
| Invalid partial update | any malformed supplied field | 400, zero mutation/save. |
| Dashboard reload/restart | false persisted on disk | Switch remains off; settings remain visible. |

## 10. Configuration documentation diff

Insert one row immediately after each current `injectionPrompt` row.

### `docs-site/src/content/docs/reference/configuration.md:40`

Before:

```md
| `injectionPrompt?` | `string` | — | Custom override for the injected v2 guidance body. Replaces the built-in text; `{{model}}`, `{{effort}}`, and `{{roster}}` placeholders are substituted. Firing gates are unchanged. Settable via `PUT /api/injection-model` (`prompt` key). |
```

After:

```md
| `injectionPrompt?` | `string` | — | Custom override for the injected v2 guidance body. Replaces the built-in text; `{{model}}`, `{{effort}}`, and `{{roster}}` placeholders are substituted. Firing gates are unchanged. Settable via `PUT /api/injection-model` (`prompt` key). |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | Controls only OpenCodex-authored multi-agent developer guidance. Unset/`true` preserves v1/v2 guidance; `false` suppresses both without changing the collaboration surface, `subagentModels`, routing, or effort caps. `GET/PUT /api/injection-model` exposes the effective value; PUT is a partial update. |
```

### `docs-site/src/content/docs/ja/reference/configuration.md:38`

Before:

```md
| `injectionPrompt?` | `string` | — | 注入される v2 案内本文を丸ごと差し替えるカスタムテキスト。`{{model}}`、`{{effort}}`、`{{roster}}` placeholder が置換され、発火条件はそのままです。`PUT /api/injection-model` の `prompt` キーでも設定できます。 |
```

After:

```md
| `injectionPrompt?` | `string` | — | 注入される v2 案内本文を丸ごと差し替えるカスタムテキスト。`{{model}}`、`{{effort}}`、`{{roster}}` placeholder が置換され、発火条件はそのままです。`PUT /api/injection-model` の `prompt` キーでも設定できます。 |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | OpenCodex が作成する multi-agent developer ガイダンスだけを制御します。未設定/`true` は v1/v2 ガイダンスを維持し、`false` は collaboration surface、`subagentModels`、routing、effort cap を変えずに両方を抑止します。`GET/PUT /api/injection-model` は有効値を返し、PUT は部分更新です。 |
```

### `docs-site/src/content/docs/ko/reference/configuration.md:39`

Before:

```md
| `injectionPrompt?` | `string` | — | 주입되는 v2 안내 본문을 통째로 교체하는 커스텀 텍스트. `{{model}}`, `{{effort}}`, `{{roster}}` 플레이스홀더가 치환되며 발화 조건은 그대로입니다. `PUT /api/injection-model`의 `prompt` 키로도 설정할 수 있습니다. |
```

After:

```md
| `injectionPrompt?` | `string` | — | 주입되는 v2 안내 본문을 통째로 교체하는 커스텀 텍스트. `{{model}}`, `{{effort}}`, `{{roster}}` 플레이스홀더가 치환되며 발화 조건은 그대로입니다. `PUT /api/injection-model`의 `prompt` 키로도 설정할 수 있습니다. |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | OpenCodex가 작성하는 multi-agent developer 가이던스만 제어합니다. 미설정/`true`는 v1/v2 가이던스를 유지하고, `false`는 collaboration surface, `subagentModels`, routing, effort cap을 바꾸지 않고 둘 다 억제합니다. `GET/PUT /api/injection-model`은 유효값을 제공하며 PUT은 부분 업데이트입니다. |
```

### `docs-site/src/content/docs/ru/reference/configuration.md:43`

Before:

```md
| `injectionPrompt?` | `string` | — | Пользовательская замена текста внедряемого v2-руководства. Заменяет встроенный текст; плейсхолдеры `{{model}}`, `{{effort}}` и `{{roster}}` подставляются. Условия срабатывания не меняются. Настраивается через `PUT /api/injection-model` (ключ `prompt`). |
```

After:

```md
| `injectionPrompt?` | `string` | — | Пользовательская замена текста внедряемого v2-руководства. Заменяет встроенный текст; плейсхолдеры `{{model}}`, `{{effort}}` и `{{roster}}` подставляются. Условия срабатывания не меняются. Настраивается через `PUT /api/injection-model` (ключ `prompt`). |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | Управляет только developer-руководством multi-agent, добавляемым OpenCodex. Отсутствующее значение/`true` сохраняет руководство v1/v2; `false` подавляет оба варианта, не меняя поверхность совместной работы, `subagentModels`, маршрутизацию и пределы effort. `GET/PUT /api/injection-model` возвращает эффективное значение; PUT является частичным обновлением. |
```

### `docs-site/src/content/docs/zh-cn/reference/configuration.md:37`

Before:

```md
| `injectionPrompt?` | `string` | — | 整体替换注入的 v2 指南正文的自定义文本。`{{model}}`、`{{effort}}`、`{{roster}}` 占位符会被替换，触发条件保持不变。也可通过 `PUT /api/injection-model` 的 `prompt` 键设置。 |
```

After:

```md
| `injectionPrompt?` | `string` | — | 整体替换注入的 v2 指南正文的自定义文本。`{{model}}`、`{{effort}}`、`{{roster}}` 占位符会被替换，触发条件保持不变。也可通过 `PUT /api/injection-model` 的 `prompt` 键设置。 |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | 仅控制由 OpenCodex 添加的 multi-agent developer 指引。未设置/`true` 保持 v1/v2 指引；`false` 会同时禁止两者，但不改变协作界面、`subagentModels`、路由或 effort 上限。`GET/PUT /api/injection-model` 返回有效值，PUT 为部分更新。 |
```

## 11. Backward compatibility

- Optional schema field plus `!== false` preserves every existing valid config.
- Fresh configs write true for discoverability; no startup migration or config rewrite is added.
- GET response is additive. PUT absent-key semantics become correctly partial; explicit clear behavior remains supported.
- False is read only by the response-guidance boundary. No catalog, mode, roster, routing, effort-cap, or Claude code path reads it.
- Stored custom prompt/model/effort resume automatically when the switch returns to true.

## 12. Verification

```bash
bun test tests/config.test.ts
bun test tests/injection-model-api.test.ts
bun test tests/multi-agent-compat.test.ts
bun run typecheck
bun run lint:gui
bun run build:gui
bun run test
bun run privacy:scan
```

Manual smoke: save model/effort/custom prompt, toggle off with the Dashboard, verify settings survive reload/sync/process restart, verify no v1 or v2 developer message is added, then toggle on and verify the saved custom prompt resumes.

## Follow-up (out of scope)

- CLI shorthand for the guidance switch.
- README marketing copy for the opt-out; the localized configuration references are the source-of-truth documentation for this setting.
- A dedicated GUI editor for `injectionPrompt`.
