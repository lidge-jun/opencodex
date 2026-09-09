# wp3 — PR #3332 재구현 carry: Claude combo capability + provider output budget

대상: PR [#3332](https://github.com/lidge-jun/opencodex/pull/3332) (@full999),
head `f05c23e06`, base `dev`, 상태 `OPEN` / `mergeable: CONFLICTING` / `mergeStateStatus: DIRTY`.

체리픽이 불가능하므로 **재구현(carry)** 한다. 원 diff 5파일 중 4파일을 가져오고,
그중 한 hunk는 결함이 있어 고쳐서 가져온다.

작업 브랜치: `codex/priority65-closeout` (base `origin/dev` = `2421e44ce`, package 2.43.0).

---

## 1. 왜 재구현인가

`gh pr view 3332` 확인 결과:

```
{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","headRefOid":"f05c23e06fa14534a983472b22e7477e98e135e7","baseRefName":"dev"}
```

PR이 작성된 뒤 dev가 같은 영역을 움직였다. 특히 `src/providers/registry.ts` 의
Anthropic 엔트리에는 PR 작성 시점에 없던 `modelReasoningEfforts: { ...ANTHROPIC_MODEL_REASONING_EFFORTS }`
가 이미 들어와 있다(현재 `registry.ts:1371`, `:1388`, PR #3454로 추가됨).
따라서 PR의 registry hunk는 컨텍스트가 어긋나 그대로 적용되지 않는다.

---

## 2. 확인된 결함 — PR의 `vendorMetadataComboFallback` 이 OUTPUT 상한을 INPUT 상한에 매핑한다

### 2.1 결함 hunk

원 PR `src/codex/catalog/provider-fetch.ts` 의 `vendorMetadataComboFallback` 안:

```ts
    ...(typeof metadata.maxTokens === "number" && metadata.maxTokens > 0
      ? { maxInputTokens: metadata.maxTokens }   // ← 결함
      : {}),
```

`ModelMetadata.maxTokens` 는 OUTPUT 상한이다. `src/generated/model-metadata.ts:4-13` 의
타입 정의에서 `contextWindow` 와 `maxTokens` 는 별도 필드이고, 같은 파일 안의 기존 소비자
`provider-fetch.ts:2516` 은 이미 올바른 방향으로 매핑하고 있다:

```ts
...(typeof meta.maxTokens === "number" && meta.maxTokens > 0 ? { maxOutputTokens: meta.maxTokens } : {}),
```

즉 PR 혼자만 반대 방향으로 쓴다.

### 2.2 실제 값으로 확인

`bun -e` 로 vendor 테이블을 직접 읽었다:

```
claude-opus-5   {"contextWindow":1000000,"maxTokens":128000,"input":["text","image"],"reasoning":true}
claude-sonnet-5 {"contextWindow":1000000,"maxTokens":128000,...}
claude-haiku-4-5{"contextWindow":200000, "maxTokens":64000, ...}
claude-fable-5-1 undefined      ← 테이블에 없음. point-release 폴백이 실제로 필요하다는 증거
```

### 2.3 결함이 어떻게 전파되는가

`aggregation.ts:161-164`:

```ts
  const maxInputTokens = Math.min(
    contextWindow,
    ...members.map(member => member.maxInputTokens ?? member.contextWindow!),
  );
```

`Math.min` 이므로 멤버 하나가 128k를 들고 오면 combo 전체 입력창이 128k로 내려앉는다.
1M 창을 가진 다른 타깃까지 같이 끌려 내려간다.

**실측(스크래치 프로브, `.tmp/` 에서 실행 후 삭제):**

| 시나리오 | member ctx | member maxIn | member maxOut | combo maxIn | combo autoCompact |
|---|---|---|---|---|---|
| PR 그대로 (`maxInputTokens`) | 1,000,000 | **128,000** | (없음) | **128,000** | **128,000** |
| 수정안 (`maxOutputTokens`) | 1,000,000 | 1,000,000 | 128,000 | **1,000,000** | **900,000** |

autoCompact까지 900k → 128k로 무너진다. `clampAutoCompactTokenLimit`
(`src/providers/auto-compact-budget.ts:15-24`)이 후보에 `maxInputTokens` 를 넣고
`Math.min` 하기 때문이다. 즉 PR을 그대로 머지하면 Claude combo 사용자는
입력 컨텍스트의 87%를 잃는다.

### 2.4 수정

`maxInputTokens` → `maxOutputTokens`. 슬롯은 이미 존재한다
(`ComboCatalogMemberFallback.maxOutputTokens`, `provider-fetch.ts:858`), 소비 경로도
이미 배선되어 있다(`:896-898` 의 `addMaxOutput`, `:918`, `:996-997`).
새 필드를 만들 필요가 없다.

---

## 3. 스코프

### IN

- `src/codex/catalog/provider-fetch.ts` — vendor metadata combo 폴백 신규 추가 (결함 수정본).
- `src/adapters/anthropic.ts` — 생략된 `max_tokens` 에 provider output budget 적용.
- `src/providers/registry.ts` — Anthropic 두 엔트리에 `defaultMaxOutputTokens` 추가.
- `tests/codex-catalog.test.ts` — 폴백 회귀 테스트 + **2.3 결함을 잡는 단정**.
- `tests/anthropic-reasoning.test.ts` — output budget 회귀 테스트.

### OUT

- `aggregation.ts:161` 의 `Math.min` 자체는 건드리지 않는다. 그 로직은 옳다
  (combo 입력창은 최소 멤버가 결정). 잘못된 것은 그 자리에 들어가는 값이지 연산이 아니다.
- Anthropic 외 프로바이더의 `defaultMaxOutputTokens` 추가.
- `ROUTED_COMBO_MEMBER_REASONING_EFFORTS` 를 Grok 등 다른 벤더로 확장하는 일반화.
- `devlog/` 외 문서 변경, docs-site 갱신.
- 릴리스, 태그, 푸시.

---

## 4. 파일 변경 맵

### 4.1 MODIFY `src/codex/catalog/provider-fetch.ts`

#### hunk A — import에 `ModelMetadata` 타입 추가 (line 35)

before:

```ts
import { getModelMetadata, getModelMetadataCaseInsensitive, listModelMetadata, resolveMetadataProvider } from "../../generated/model-metadata";
```

after:

```ts
import { getModelMetadata, getModelMetadataCaseInsensitive, listModelMetadata, resolveMetadataProvider, type ModelMetadata } from "../../generated/model-metadata";
```

#### hunk B — `ComboCatalogMemberFallback` 선언(`:855-863`) 뒤, `resolveComboCatalogMember` JSDoc(`:865`) 앞에 삽입

before (현재 `:863-875`):

```ts
  readonly reasoningEfforts?: readonly string[];
}

/**
 * Resolve a combo target to a catalog member for derivation.
```

after:

```ts
  readonly reasoningEfforts?: readonly string[];
}

/**
 * Ladder advertised for a combo member whose vendor metadata says it reasons but
 * carries no explicit ladder (Claude, Grok). Codex needs a non-empty ladder to show
 * the effort control; the routed adapters clamp to the real upstream top rung.
 */
const ROUTED_COMBO_MEMBER_REASONING_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Vendor-table lookup tolerant of point releases and date pins. Configured combo
 * targets often name a variant the table does not carry (`claude-fable-5-1`,
 * `claude-opus-4-5-20251101`); the base family row still describes its modality
 * and reasoning capability, so fall back to it before giving up.
 */
function comboMemberVendorMetadata(provider: string, modelId: string): ModelMetadata | undefined {
  const exact = getModelMetadataCaseInsensitive(provider, modelId);
  if (exact) return exact;
  let candidate = modelId.replace(/\[[^\]]*\]$/, "");
  while (true) {
    const trimmed = candidate.replace(/-\d+$/, "");
    if (trimmed === candidate || !trimmed.includes("-")) return undefined;
    const hit = getModelMetadataCaseInsensitive(provider, trimmed);
    if (hit) return hit;
    candidate = trimmed;
  }
}

/**
 * Combo members are usually thin discovery rows (id + context window). Without a
 * capability source the combo intersection collapses to text-only / no effort ladder,
 * and the Codex app then refuses image attachments and hides the effort picker for
 * every Claude combo. The generated vendor table knows both, so use it as the
 * last-resort fallback when the caller supplied none.
 *
 * `ModelMetadata.maxTokens` is the OUTPUT ceiling, so it fills `maxOutputTokens`.
 * Mapping it onto `maxInputTokens` would be read by the combo intersection
 * (`aggregation.ts` `Math.min` over member input ceilings) as a 128k input limit and
 * shrink a 1M Claude combo window to 128k, taking autoCompactTokenLimit down with it.
 */
function vendorMetadataComboFallback(target: { provider: string; model: string }): ComboCatalogMemberFallback | undefined {
  const metadataProvider = resolveMetadataProvider(target.provider);
  const metadata = metadataProvider ? comboMemberVendorMetadata(metadataProvider, target.model) : undefined;
  if (!metadata) return undefined;
  return {
    ...(typeof metadata.contextWindow === "number" && metadata.contextWindow > 0
      ? { contextWindow: metadata.contextWindow }
      : {}),
    ...(typeof metadata.maxTokens === "number" && metadata.maxTokens > 0
      ? { maxOutputTokens: metadata.maxTokens }
      : {}),
    ...(Array.isArray(metadata.input) && metadata.input.length > 0
      ? { inputModalities: [...metadata.input] }
      : {}),
    ...(metadata.reasoning === true ? { reasoningEfforts: [...ROUTED_COMBO_MEMBER_REASONING_EFFORTS] } : {}),
  };
}

/**
 * Resolve a combo target to a catalog member for derivation.
```

**원 PR과의 유일한 차이는 `maxInputTokens:` → `maxOutputTokens:` 한 줄과 그 이유를 적은 JSDoc 문단이다.**

#### hunk C — `resolveComboCatalogMember` 시그니처와 폴백 결정 (`:875-887`)

before:

```ts
export function resolveComboCatalogMember(
  target: { provider: string; model: string },
  memberByKey: ReadonlyMap<string, CatalogModel>,
  providers: ReadonlyMap<string, OcxProviderConfig>,
  contextCap?: number,
  fallback?: ComboCatalogMemberFallback,
  metadataModelIdCaseFold?: boolean,
): CatalogModel | undefined {
  const existing = memberByKey.get(targetKey(target));
  const prov = providers.get(target.provider);
  // Disabled providers never contribute members — even a complete discovery row
  // is unusable for catalog derivation while the provider is off.
  if (prov?.disabled === true) return undefined;
```

after:

```ts
export function resolveComboCatalogMember(
  target: { provider: string; model: string },
  memberByKey: ReadonlyMap<string, CatalogModel>,
  providers: ReadonlyMap<string, OcxProviderConfig>,
  contextCap?: number,
  callerFallback?: ComboCatalogMemberFallback,
  metadataModelIdCaseFold?: boolean,
): CatalogModel | undefined {
  const existing = memberByKey.get(targetKey(target));
  const prov = providers.get(target.provider);
  const fallback = callerFallback ?? vendorMetadataComboFallback(target);
  // Disabled providers never contribute members — even a complete discovery row
  // is unusable for catalog derivation while the provider is off.
  if (prov?.disabled === true) return undefined;
```

파라미터 이름만 바뀌고 함수 본문 나머지는 `fallback` 이라는 지역 상수를 계속 쓰므로
아래 코드는 손대지 않는다. 유일한 외부 호출부는 `provider-fetch.ts:2153-2160` 이고
positional 인자를 쓰므로 시그니처 호환이 유지된다.

`callerFallback ?? ...` 순서가 중요하다. native alias 폴백
(`:2140-2151` 의 `nativeAliasFallback`)이 넘어오면 그것이 이기고,
vendor 테이블은 caller가 아무것도 주지 않았을 때만 쓰인다.

### 4.2 MODIFY `src/adapters/anthropic.ts`

`modelRecordValue` 는 이미 `:30` 에서 import되어 있다. 추가 import 없음.

#### hunk D — `:898-903`

before:

```ts
      const tools = toolsToAnthropicFormat(parsed, toolNames);

      const body: Record<string, unknown> = {
        model: parsed.modelId,
        messages,
        stream: parsed.stream,
        max_tokens: parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      };
```

after:

```ts
      const tools = toolsToAnthropicFormat(parsed, toolNames);

      // Codex never sends `max_output_tokens`, so the omitted-limit default decides how
      // long a Claude answer may run. Honor the provider's configured output budget
      // (`modelMaxOutputTokens` / `defaultMaxOutputTokens`) before falling back to the
      // conservative 8192, which truncates long answers with stop_reason=max_tokens.
      const configuredMaxOut = modelRecordValue(provider.modelMaxOutputTokens, parsed.modelId)
        ?? provider.defaultMaxOutputTokens;
      const omittedMaxTokens = typeof configuredMaxOut === "number" && configuredMaxOut > 0
        ? configuredMaxOut
        : DEFAULT_MAX_TOKENS;
      const body: Record<string, unknown> = {
        model: parsed.modelId,
        messages,
        stream: parsed.stream,
        max_tokens: parsed.options.maxOutputTokens ?? omittedMaxTokens,
      };
```

#### hunk E — adaptive thinking 분기 `:945`

before:

```ts
          body.max_tokens = explicitMaxOut !== undefined
            ? explicitMaxOut
            : Math.min(ADAPTIVE_THINKING_CEILING, Math.max(DEFAULT_MAX_TOKENS, floor));
```

after:

```ts
          body.max_tokens = explicitMaxOut !== undefined
            ? explicitMaxOut
            : Math.max(omittedMaxTokens, Math.min(ADAPTIVE_THINKING_CEILING, Math.max(DEFAULT_MAX_TOKENS, floor)));
```

#### hunk F — budget thinking 분기 `:951`

before:

```ts
          const maxOut = parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
```

after:

```ts
          const maxOut = parsed.options.maxOutputTokens ?? omittedMaxTokens;
```

세 hunk 모두 원 PR 그대로다. 수정 없음.

### 4.3 MODIFY `src/providers/registry.ts`

#### hunk G — 상수 추가, `:351` (`ANTHROPIC_MODEL_CONTEXT_WINDOWS`) 바로 뒤

before:

```ts
const ANTHROPIC_MODEL_CONTEXT_WINDOWS: Record<string, number> = { "claude-fable-5-1": 1_000_000, ... "claude-haiku-4-5": 200_000 };

/**
 * The effort rungs opencodex exposes for native Anthropic models.
```

after:

```ts
const ANTHROPIC_MODEL_CONTEXT_WINDOWS: Record<string, number> = { "claude-fable-5-1": 1_000_000, ... "claude-haiku-4-5": 200_000 };
// Every current Claude family accepts at least 64k output tokens (Haiku 4.5 / Sonnet 4.x
// through Opus 5 and Fable 5). Anthropic caps max_tokens per model server-side, so a
// larger request never over-allocates; it only stops the 8192 truncation.
const ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/**
 * The effort rungs opencodex exposes for native Anthropic models.
```

#### hunk H — `anthropic` 엔트리 (`:1369-1373`)

**원 PR과 컨텍스트가 다르다.** dev가 `modelReasoningEfforts` 줄을 추가했으므로
그 줄을 보존한 채 삽입한다.

before:

```ts
    models: [...ANTHROPIC_MODELS],
    modelContextWindows: { ...ANTHROPIC_MODEL_CONTEXT_WINDOWS },
    modelReasoningEfforts: { ...ANTHROPIC_MODEL_REASONING_EFFORTS },
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "anthropic-apikey",
```

after:

```ts
    models: [...ANTHROPIC_MODELS],
    modelContextWindows: { ...ANTHROPIC_MODEL_CONTEXT_WINDOWS },
    modelReasoningEfforts: { ...ANTHROPIC_MODEL_REASONING_EFFORTS },
    // Codex omits max_output_tokens; without a provider budget the Anthropic adapter
    // falls back to 8192, which truncates long answers with stop_reason=max_tokens.
    defaultMaxOutputTokens: ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS,
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "anthropic-apikey",
```

#### hunk I — `anthropic-apikey` 엔트리 (`:1385-1390`)

before:

```ts
    models: [...ANTHROPIC_MODELS],
    liveModels: true,
    modelContextWindows: { ...ANTHROPIC_MODEL_CONTEXT_WINDOWS },
    modelReasoningEfforts: { ...ANTHROPIC_MODEL_REASONING_EFFORTS },
    defaultModel: "claude-sonnet-5",
  },
```

after:

```ts
    models: [...ANTHROPIC_MODELS],
    liveModels: true,
    modelContextWindows: { ...ANTHROPIC_MODEL_CONTEXT_WINDOWS },
    modelReasoningEfforts: { ...ANTHROPIC_MODEL_REASONING_EFFORTS },
    defaultMaxOutputTokens: ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS,
    defaultModel: "claude-sonnet-5",
  },
```

주의: `registry.ts:1354` 에 이미 `defaultMaxOutputTokens: 64_000` 이 있지만
그것은 `command-code` 엔트리다. Anthropic과 무관하므로 이 hunk는 여전히 필요하다.

### 4.4 MODIFY `tests/codex-catalog.test.ts` — 5장 참조

### 4.5 MODIFY `tests/anthropic-reasoning.test.ts` — 5장 참조

### DELETE

없음.

---

## 5. 회귀 테스트

### 5.1 원 PR 테스트로는 결함이 안 잡힌다

원 PR이 `tests/codex-catalog.test.ts` 에 넣은 단정은 이렇다:

```ts
    )).toMatchObject({
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
```

`toMatchObject` 는 **열거한 키만** 본다. `maxInputTokens` 를 적지 않았으므로
그 값이 128k로 오염되어도 통과한다. `contextWindow` 는 1M 그대로 살아남기 때문에
(`Math.min` 붕괴는 `maxInputTokens` 에서 일어난다) 이 단정은 결함을 볼 수 없다.

실측으로 확인: PR 폴백을 넣은 member는
`{ctx: 1000000, maxIn: 128000}` 이다. `contextWindow` 단정은 초록이다.

### 5.2 ADD — 결함 저격 테스트

`tests/codex-catalog.test.ts` 의 `describe("combo catalog capability intersection")`
(`:170` 시작) 안, `:1552` 의 `resolveComboCatalogMember ... toBeUndefined()` 를
닫는 `});` (`:1557`) 뒤에 추가한다.

```ts
  test("resolveComboCatalogMember restores vendor image and effort capabilities for thin Claude rows", () => {
    const providers = new Map([["anthropic", {
      adapter: "anthropic" as const,
      baseUrl: "https://api.anthropic.com",
    }]]);
    // A discovery row that only carries id + window (the live Anthropic /models shape).
    expect(resolveComboCatalogMember(
      { provider: "anthropic", model: "claude-opus-5" },
      new Map([["anthropic/claude-opus-5", { provider: "anthropic", id: "claude-opus-5", contextWindow: 1_000_000 }]]),
      providers,
    )).toMatchObject({
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
    // Point-release ids fall back to their family row in the vendor table.
    expect(resolveComboCatalogMember(
      { provider: "anthropic", model: "claude-fable-5-1" },
      new Map([["anthropic/claude-fable-5-1", { provider: "anthropic", id: "claude-fable-5-1", contextWindow: 1_000_000 }]]),
      providers,
    )).toMatchObject({
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
    // An explicit caller fallback still wins over the vendor table.
    expect(resolveComboCatalogMember(
      { provider: "anthropic", model: "claude-opus-5" },
      new Map([["anthropic/claude-opus-5", { provider: "anthropic", id: "claude-opus-5", contextWindow: 1_000_000 }]]),
      providers,
      undefined,
      { inputModalities: ["text"], reasoningEfforts: [] },
    )).toMatchObject({ inputModalities: ["text"], reasoningEfforts: [] });
    // Unknown ids keep their unknown ladder rather than inventing one.
    expect(resolveComboCatalogMember(
      { provider: "a", model: "ghost" },
      new Map(),
      new Map([["a", { adapter: "openai-chat" as const, baseUrl: "https://a.example/v1" }]]),
    )).not.toHaveProperty("reasoningEfforts");
  });

  // 2.3의 결함을 저격한다. 위 테스트는 toMatchObject라 maxInputTokens를 보지 않으므로
  // 이 테스트가 없으면 OUTPUT 상한을 INPUT 슬롯에 넣는 회귀가 초록으로 통과한다.
  test("vendor metadata fills the OUTPUT ceiling and never shrinks the combo input window", () => {
    const providers = new Map([["anthropic", {
      adapter: "anthropic" as const,
      baseUrl: "https://api.anthropic.com",
    }]]);
    const member = resolveComboCatalogMember(
      { provider: "anthropic", model: "claude-opus-5" },
      new Map([["anthropic/claude-opus-5", { provider: "anthropic", id: "claude-opus-5", contextWindow: 1_000_000 }]]),
      providers,
    );
    // claude-opus-5 vendor row is { contextWindow: 1e6, maxTokens: 128_000 }.
    // maxTokens is the OUTPUT ceiling: it must land on maxOutputTokens, never maxInputTokens.
    expect(member?.maxOutputTokens).toBe(128_000);
    expect(member?.maxInputTokens ?? 1_000_000).toBe(1_000_000);

    // The intersection in deriveComboCatalogModel takes Math.min over member input
    // ceilings, so a misplaced 128k would collapse a 1M combo window (and its
    // autoCompact budget) for every other target in the group.
    const peer: CatalogModel = {
      provider: "xai",
      id: "grok-4.6",
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    };
    const derived = deriveComboCatalogModel("claude-grok", normalizedCombo({
      targets: [
        { provider: "anthropic", model: "claude-opus-5", weight: 1 },
        { provider: "xai", model: "grok-4.6", weight: 1 },
      ],
    }), [member!, peer]);
    expect(derived).toMatchObject({
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      autoCompactTokenLimit: 900_000,
    });
  });
```

`deriveComboCatalogModel`, `resolveComboCatalogMember`, `CatalogModel` 은 이미
`tests/codex-catalog.test.ts:10` 에서 import되어 있고 `normalizedCombo` 헬퍼는
`:74-89` 에 있다. 추가 import 불필요.

**이 테스트가 결함을 실제로 잡는지 확인한 근거:** `.tmp/` 프로브에서 PR 원본 매핑을 흉내내
`maxInputTokens: 128000` 폴백을 주입하면 combo가
`{ctx: 1000000, maxIn: 128000, acl: 128000}` 로 나온다.
위 단정은 `maxIn: 1000000`, `acl: 900000` 을 요구하므로 **두 줄이 동시에 빨개진다.**
수정본에서는 `{ctx: 1000000, maxIn: 1000000, maxOut: 128000, acl: 900000}` 로 초록이다.

### 5.3 ADD — output budget 테스트

`tests/anthropic-reasoning.test.ts` `:283` (adaptive-thinking 관련 테스트 사이)에
원 PR 테스트를 그대로 추가한다:

```ts
  test("configured provider output budget replaces the 8192 default when the caller omits max_output_tokens", async () => {
    const budgeted = { ...provider, defaultMaxOutputTokens: 64_000, modelMaxOutputTokens: { "claude-fable-5": 32_000 } };
    // No reasoning: the configured budget is the wire max_tokens.
    expect((await bodyOf(parsed("none", {}, "claude-opus-5"), budgeted)).max_tokens).toBe(64_000);
    expect((await bodyOf(parsed("none", {}, "claude-fable-5"), budgeted)).max_tokens).toBe(32_000);
    // Adaptive thinking: the budget still wins over the headroom-derived ceiling.
    expect((await bodyOf(parsed("max", {}, "claude-opus-5"), budgeted)).max_tokens).toBe(64_000);
    // Budget thinking on an older family keeps max_tokens above the thinking budget.
    const legacy = await bodyOf(parsed("high", {}, "claude-haiku-4-5"), budgeted);
    expect(legacy.max_tokens as number).toBeGreaterThan((legacy.thinking as { budget_tokens: number }).budget_tokens);
    // An explicit caller limit still wins over the configured budget.
    expect((await bodyOf(parsed("none", { maxOutputTokens: 512 }, "claude-opus-5"), budgeted)).max_tokens).toBe(512);
  });
```

`bodyOf` 는 `:23` 에서 두 번째 인자로 provider를 받도록 이미 정의되어 있다
(`configuredProvider = provider`). 헬퍼 수정 불필요.

**현재 코드에서 이 테스트가 빨간지 확인함.** 어댑터를 고치기 전 실측값:

| 케이스 | 현재 (budget 무시) | 테스트 기대 |
|---|---|---|
| `none` / opus-5 | 8192 | 64000 |
| `none` / fable-5 | 8192 | 32000 |
| `max` / opus-5 | 40192 | 64000 |
| `high` / haiku-4-5 | 24576 (budget 16384) | > budget — 현재도 통과 |
| explicit 512 | 512 | 512 — 현재도 통과 |

앞의 세 줄이 실패하므로 테스트는 vacuous하지 않다.

---

## 6. 조건 분기 activation scenario

새로 생기는 분기는 셋이다.

### 분기 1 — `callerFallback ?? vendorMetadataComboFallback(target)`

- **발화 조건:** combo 타깃을 resolve할 때 caller가 fallback을 주지 않은 경우.
  native alias combo가 아닌 모든 일반 combo가 여기 해당한다
  (`provider-fetch.ts:2144` 의 `nativeAliasFallback` 은
  `combo.nativeAlias && combo.alias && nativeContextWindow !== undefined` 일 때만 값이 있다).
- **C가 어떻게 발화시키는가:** `ocx` 설정에 Claude 타깃을 포함한 combo를 정의하고
  Anthropic 프로바이더를 켠 뒤 카탈로그를 재생성한다. 라이브 Anthropic `/models` 는
  id와 컨텍스트 창만 주므로 thin row가 된다.
- **관측 대상:** `GET /v1/models` 의 해당 combo 항목.
  before: `inputModalities: ["text"]`, `reasoningEfforts: []`.
  after: `["text","image"]`, `["low","medium","high","xhigh","max"]`,
  그리고 `maxInputTokens` 는 1,000,000 유지.
- **비발화 확인:** native alias combo는 caller fallback이 있으므로 vendor 테이블을 타지 않는다.
  5.2의 세 번째 단정이 이것을 고정한다.

### 분기 2 — `comboMemberVendorMetadata` 의 point-release 트리밍 루프

- **발화 조건:** 정확 일치가 없고 모델 id가 `-<숫자>` 로 끝날 때.
- **C가 어떻게 발화시키는가:** combo 타깃으로 `anthropic/claude-fable-5-1` 을 쓴다.
  이 id는 vendor 테이블에 **없다** (`getModelMetadataCaseInsensitive("anthropic", "claude-fable-5-1")`
  → `undefined`, 실측 확인). 한 번 트리밍하면 `claude-fable-5` 가 되고 그 행은 존재한다.
- **관측 대상:** 해당 멤버가 `inputModalities: ["text","image"]` 와 5단 ladder를 얻는다.
- **종료 보장:** `trimmed === candidate` (더 깎을 게 없음) 또는
  `!trimmed.includes("-")` 에서 `undefined` 반환. 매 반복마다 문자열이 짧아지므로 무한루프 없음.
- **비발화 확인:** `ghost` 같은 하이픈 없는 미지의 id는 첫 반복에서
  `trimmed === candidate` 로 즉시 빠진다. 5.2의 네 번째 단정이 고정한다.

### 분기 3 — `omittedMaxTokens` (adapter)

- **발화 조건:** `parsed.options.maxOutputTokens` 가 undefined이고
  프로바이더에 `modelMaxOutputTokens[model]` 또는 `defaultMaxOutputTokens` 가 양수로 있을 때.
- **C가 어떻게 발화시키는가:** Codex는 `max_output_tokens` 를 보내지 않는다.
  따라서 Anthropic 프로바이더로 라우팅되는 **모든 Codex 요청**이 발화 조건이고,
  hunk G~I가 registry에 64k를 넣는 순간 기본 발화한다.
- **관측 대상:** 업스트림 요청 body의 `max_tokens`.
  8192 → 64000. 사용자가 보는 증상으로는 긴 답변이 `stop_reason: "max_tokens"` 로
  잘리던 것이 멈춘다.
- **비발화 확인:** 호출자가 명시적으로 `maxOutputTokens: 512` 를 주면 512가 유지된다
  (5.3의 마지막 단정). 프로바이더에 budget이 없으면 `DEFAULT_MAX_TOKENS` = 8192 그대로다
  (`tests/anthropic-reasoning.test.ts` 의 기존 40192/24576 단정이 이를 고정한다 —
  그 테스트들은 budget 없는 `provider` 를 쓴다).

---

## 7. 필드 체인 (PLAN-FIELD-CHAIN-01)

**새 필드는 추가하지 않는다.** `ComboCatalogMemberFallback.maxOutputTokens` 는
`provider-fetch.ts:858` 에 이미 있고, `CatalogModel.maxOutputTokens` 는
`parsing.ts:116` 에 이미 있다. registry의 `defaultMaxOutputTokens` 도
`registry.ts:282` 에 이미 선언된 필드다. 이 작업은 **기존 필드에 값을 채우는 일**이다.

그래도 값이 흐르는 경로 전체를 열거한다.

### 7.1 `maxOutputTokens` 체인 (combo 폴백 경로)

| 단계 | 위치 | 하는 일 |
|---|---|---|
| creation | `provider-fetch.ts` `vendorMetadataComboFallback` (신규) | vendor `metadata.maxTokens` → `maxOutputTokens` |
| 주입 | `resolveComboCatalogMember:885` (수정) | `callerFallback ?? vendor` |
| 소비 A (완전한 row) | `:896-898` `addMaxOutput`, `:918` | 멤버에 `maxOutputTokens` 가 없을 때만 채움 |
| 소비 B (합성 row) | `:996-997` | `positiveSafeInteger(hinted, base) ?? fallback` |
| 출력 | `:1025` | `CatalogModel` 에 실림 |
| combo 집계 | `aggregation.ts:165-169` | **모든** 멤버가 값을 가질 때만 `Math.min`, 아니면 `undefined` |
| combo 출력 | `aggregation.ts:189` | `...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})` |
| serialization | `aggregation.ts:330` `normalizedOpenAiApiSignature` | `maxOutputTokens ?? null` — 시그니처에 포함 |
| serialization | `parsing.ts:116` `CatalogModel` | 카탈로그 JSON 필드 |

**주의점 두 가지.**

1. `aggregation.ts:168` 은 `knownMaxOutputTokens.length === members.length` 를 요구한다.
   Claude 멤버 하나에만 값이 생기고 다른 멤버에 없으면 combo의 `maxOutputTokens` 는
   여전히 `undefined` 다. 이는 **의도된 보수적 동작**이고 기존 로직이며 이번 변경 대상이 아니다.
2. `comboCatalogWarningSignature` (`aggregation.ts:225-247`)에는
   `maxOutputTokens` 가 **없다**. 반면 `maxInputTokens` 와
   `autoCompactTokenLimit` 은 있다(`:239-240`).
   따라서 PR 원본을 그대로 머지하면 이 경고 시그니처까지 값이 바뀌어
   `warnUncataloguedComboOnce` 의 dedupe 키가 달라진다. 수정본은
   `maxInputTokens` 를 건드리지 않으므로 시그니처가 변하지 않는다 — carry 수정의 부수 이득이다.

### 7.2 `defaultMaxOutputTokens` 체인 (registry → adapter)

| 단계 | 위치 |
|---|---|
| creation | `registry.ts:1373, 1389` (신규 값), 타입은 `:282` 에 기존 |
| seed 전파 | `providers/derive.ts:237, 297, 488` — 프로바이더 설정에 없으면 registry 값 주입 |
| 런타임 병합 | `router.ts:452-453` — `provider.defaultMaxOutputTokens === undefined` 일 때 registry 값 |
| login 경로 | `oauth/login-cli.ts:110`, `oauth/index.ts:1190` (허용 키 목록) |
| config 검증 | `config.ts:1388`, `server/auth-cors.ts:688, 808` (editor 권한) |
| rename 마이그레이션 | `providers/model-rename-migration.ts:86` (`modelMaxOutputTokens` 만 해당) |
| **소비 (이번에 신규)** | `adapters/anthropic.ts` hunk D/E/F |
| 기존 소비자 (변경 없음) | `openai-chat.ts:1403-1404`, `ollama-native.ts:1065-1066`, `command-code.ts:510` |
| 진단 표면 | `routing/compatibility/behavior.ts:185`, `provider-fetch.ts:586` (`maxOut` 진단 필드) |

anthropic 어댑터가 쓰는 `modelRecordValue → defaultMaxOutputTokens` 우선순위는
`openai-chat.ts:1403-1404` 와 동일한 패턴이다. 새 규약이 아니다.

---

## 8. 건전성 재확인 (요청 항목)

### 8.1 adapter output budget — 건전함

`modelRecordValue` (`src/reasoning-effort.ts:115-127`)는 정확 일치 → `:` 앞 family →
대소문자 무시 순으로 찾는다. `parsed.modelId` 는 어댑터 시점에서 프로바이더 접두사가 벗겨진
순수 모델 id다(`body.model = parsed.modelId` 로 그대로 업스트림에 나감). 따라서
registry의 `"claude-opus-5"` 키와 맞는다.

세 hunk의 우선순위가 일관된다: **명시적 caller 값 > 설정된 budget > 8192**.
hunk E의 `Math.max(omittedMaxTokens, ...)` 는 budget이 adaptive 천장(40192)보다
작을 때 천장을 유지하므로 thinking headroom을 깎지 않는다. budget 64k면 64k가 이긴다.

hunk F의 `REASONING_MAX_TOKENS_CEILING = 32_000` 클램프는 그대로 살아있어
legacy budget-thinking 경로에서 `max_tokens` 가 32k를 넘지 않는다. 실측에서
`high/haiku-4-5` 가 24576, budget 16384로 부등식이 유지됨을 확인했다.

### 8.2 registry `defaultMaxOutputTokens = 64_000` — 건전함

vendor 테이블 기준 현행 Claude 계열 OUTPUT 상한: opus-5 / sonnet-5 / fable-5 /
opus-4-6 / opus-4-8 / sonnet-4-6 = 128,000, haiku-4-5 = 64,000.
**64k는 전 계열의 최소값 이하**이므로 어떤 모델에서도 서버 상한을 넘지 않는다.
128k로 올리면 haiku-4-5에서 초과하므로 64k 선택이 맞다.

`command-code` 가 같은 64k를 쓰고 있어(`:1354`) 선례도 있다.

### 8.3 남는 비대칭 하나 (기록만, 이번 스코프 아님)

`ANTHROPIC_MODEL_CONTEXT_WINDOWS` 는 `claude-fable-5-1` 을 포함하지만
vendor 테이블에는 그 행이 없다. 그래서 registry 경유 경로는 창을 알고
vendor 경유 폴백은 family 트리밍에 의존한다. 분기 2가 이를 흡수하므로
동작 결함은 아니다. 테이블 갱신은 별도 작업.

---

## 9. Verifier (PLAN-VERIFIER-REAL-01)

**모두 실제로 실행했다.** 전체 스위트(`bun run test`, bare `bun test`)는 금지이므로
focused 파일만 쓴다.

| # | 커맨드 | exit | 이 커맨드가 변경 대상을 실제로 읽는가 |
|---|---|---|---|
| V1 | `bun test tests/codex-catalog.test.ts` | **0** (266 pass / 0 fail, 5.83s) | 읽는다 — `:10` 에서 `resolveComboCatalogMember`, `deriveComboCatalogModel` 을 `src/codex/catalog` 에서 직접 import하므로 hunk B/C를 실행 경로로 통과한다. |
| V2 | `bun test tests/anthropic-reasoning.test.ts` | **0** (66 pass / 0 fail, 111ms) | 읽는다 — `:2` 에서 `createAnthropicAdapter` 를 `src/adapters/anthropic` 에서 import하고 `buildRequest` 로 실제 body를 만든다. hunk D/E/F가 그 안이다. |
| V3 | `bun run typecheck` | 아래 참조 | 읽는다 — `tsc --noEmit` 가 저장소 전체를 검사하므로 `ModelMetadata` 타입 import(hunk A)와 `ComboCatalogMemberFallback` 구조 적합성을 강제한다. |
| V4 | `bun -e` vendor 테이블 조회 | **0** | 읽는다 — `src/generated/model-metadata.ts` 를 직접 로드해 `maxTokens` 가 OUTPUT임을 확인한 근거. |
| V5 | `.tmp/` 스크래치 프로브 | **0** | 읽는다 — `src/codex/catalog` 를 로드해 2.3 표의 실측값을 산출. **검증용이며 커밋하지 않는다.** |

V1/V2는 **변경 전 baseline**으로 실행했다. 둘 다 초록이므로 이후 실패는 이번 변경이 원인이다.

V3은 baseline에서 실행하지 않았다 — 변경 후 1회 실행이 필요하다. hunk A의
`type ModelMetadata` import가 `verbatimModuleSyntax` 계열 설정과 충돌하지 않는지,
그리고 `callerFallback` 리네임이 호출부(`:2153`, positional)와 어긋나지 않는지를
잡는 유일한 게이트다.

### 실행 순서

```bash
bun run typecheck
bun test tests/codex-catalog.test.ts
bun test tests/anthropic-reasoning.test.ts
```

`bun run test:changed` 는 이 변경에 대해 위 두 파일을 포함하는 상위집합이므로
추가 정보가 없다. 스코프 변경이므로 전체 스위트는 돌리지 않는다.

### 빨간지 먼저 확인 (vacuous 방지)

5.2와 5.3의 신규 테스트는 **프로덕션 코드를 고치기 전에** 먼저 추가해서
빨간 것을 확인한 뒤 코드를 고친다. 5.3의 기대 실패는 8192 vs 64000 / 8192 vs 32000 /
40192 vs 64000 세 줄이다(실측 표 참조).

---

## 10. Accept criteria

1. `bun run typecheck` exit 0.
2. `bun test tests/codex-catalog.test.ts` exit 0, 신규 테스트 2개 포함해 268 pass 이상.
3. `bun test tests/anthropic-reasoning.test.ts` exit 0, 신규 테스트 1개 포함해 67 pass 이상.
4. `rg -n 'maxInputTokens: metadata.maxTokens' src/` 가 **아무것도 찾지 못한다** —
   결함이 재유입되지 않았다는 기계적 증거.
5. `rg -n 'maxOutputTokens: metadata.maxTokens' src/codex/catalog/provider-fetch.ts` 가 1건 매치.
6. thin Claude row가 `inputModalities: ["text","image"]` 와 5단 ladder를 얻고
   `maxInputTokens` 는 1,000,000을 유지한다 (5.2 단정).
7. combo 집계 결과 `autoCompactTokenLimit` 이 900,000이다 (128,000이 아니다).
8. budget이 설정된 Anthropic 프로바이더에서 caller가 `maxOutputTokens` 를 생략하면
   wire `max_tokens` 가 64,000이다.
9. budget이 **없는** 프로바이더의 기존 단정(40192 / 32768 / 24576)이 전부 그대로 통과한다 —
   회귀 없음.
10. 커밋 본문에 co-author 트레일러가 있다 (11장).
11. `git status` 에 `.tmp/` 산출물이 스테이징되지 않았다.

---

## 11. 커밋 / PR 규약

원 저자는 `full999`(PR #3332). 트레일러에 쓸 이메일은 구현 시점에 다음으로 조회한다 —
**이 문서에 평문으로 적지 않는다.** `privacy:scan`이 devlog를 스캔하므로 여기에 이메일을
박으면 CI가 막는다.

```
gh api repos/lidge-jun/opencodex/pulls/3332/commits --jq '.[].commit.author'
```

커밋 본문에 반드시 포함(스쿼시 후에도 살아남도록 브랜치 커밋 본문에 넣는다):

```
Co-authored-by: full999 <조회한 이메일>
```

`AGENTS.md` "Landing another author's work" 규정상 재구현/carry는 트레일러가 필수다.
산문으로 "reimplements #3332"라고만 쓰면 contributor 그래프에 잡히지 않는다
(`CREDITS.md` 의 27건이 그렇게 누락된 사례).

PR 설명에는 `.github/PULL_REQUEST_TEMPLATE.md` 의 Summary / Verification / Checklist를
모두 채우고, 다음을 명시한다:

- 이 PR이 #3332의 재구현이며 원 PR은 CONFLICTING/DIRTY라 체리픽 불가였다는 점.
- 원 PR 대비 **의도적으로 바꾼 한 줄**(`maxInputTokens` → `maxOutputTokens`)과
  그것이 없으면 Claude combo 입력창이 1M → 128k로 붕괴한다는 근거.
- `Closes #3332` 가 아니라, dev 타깃이므로 머지 후 #3332를 수동으로 닫는다.
- base는 `dev`.

---

## 12. 실행 순서 요약

1. 신규 테스트 2개를 먼저 추가하고 V1/V2를 돌려 **빨간 것을 확인**한다.
2. hunk A/B/C 적용 (`provider-fetch.ts`).
3. hunk D/E/F 적용 (`anthropic.ts`).
4. hunk G/H/I 적용 (`registry.ts`).
5. V3 → V1 → V2 순서로 실행, 전부 exit 0 확인.
6. Accept criteria 4/5의 `rg` 두 줄 확인.
7. `.tmp/` 스크래치 삭제 확인, `git status` 로 의도한 5파일만 변경되었는지 확인.
8. co-author 트레일러 포함해 커밋, `dev` 타깃 PR 생성.
