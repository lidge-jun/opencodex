# 020 — wp2: PR #646 랜딩 (cursor/kimi-k3 에포트 티어 + max 기본값 보강)

## 목표

PR #646의 티어 추가를 유지하되, 머지 전에 Codex 리뷰가 지적한 P2 2건을 우리가 보강해
`dev`에 랜딩한다. 이 work-phase는 **실제 코드 패치를 포함**한다.

## 현재 상태 (실측)

```
PR #646  head 31c73265  base dev  DRAFT  UNSTABLE  reviewDecision CHANGES_REQUESTED
author koopmannleon19977-cmyk  maintainerCanModify true  commits 1  +18/-1  4파일
```

체크: `enforce-target success`, `label success`, `CodeRabbit pass`.
크로스플랫폼 CI는 **아직 이 head에서 돌지 않았다** (check-runs에 enforce-target/label만
존재). 즉 undraft 후 CI를 새로 받아야 한다.

`Wibias`의 메인테이너 리뷰: `CHANGES_REQUESTED`. 보안 리뷰는 **no medium+** —
정적 카탈로그/에포트 매핑 변경이고 auth·credential·SSRF·신뢰경계 변경 없음.

## 컨트리뷰터 변경 (유지)

```
src/adapters/cursor/effort-map.ts   "kimi-k3": ["low", "high", "max"]  추가
src/adapters/cursor/discovery.ts    CURSOR_STATIC_MODELS에 kimi-k3 시드
                                    (CONTEXT_262K, supportsReasoningEffort: true)
tests/cursor-effort-suffix.test.ts  케이스 추가
tests/cursor-discovery.test.ts      케이스 추가
```

티어 구성은 외부 근거로 확인됨: Kimi K3 공식 Quickstart가 `reasoning_effort`를
`low`/`high`/`max`로 문서화하고 **기본값 `max`**를 명시. Cursor 공식 모델 문서도
Kimi K3를 Low/High/Max 세 변형으로 노출한다.

## 결함 재현 (P2 #2 — 카탈로그 기본값이 high로 내려앉음)

경로 추적:

1. `cursorModelEffortLadder("kimi-k3")` → `["low","high","max"]`
   — `src/adapters/cursor/effort-map.ts:103-107`
2. cursor 레지스트리 엔트리는 `modelReasoningEfforts: cursorModelReasoningEfforts(...)`만
   제공 — `src/providers/registry.ts:386`
3. `modelDefaultReasoningEfforts`가 **없다** → `applyProviderConfigHints()`의
   `modelRecordValue(prov.modelDefaultReasoningEfforts, model.id)`가 undefined
   — `src/codex/catalog/provider-fetch.ts:140`
4. `applyReasoningLevels(entry, efforts, undefined, ...)`가 기본값 오버라이드 없이
   호출되어 카탈로그 `default_reasoning_level`이 `high`로 정착
   — `src/codex/catalog/effort.ts:144`
5. 픽커가 `high`를 **명시 전송** → 요청 빌더의 "에포트 없음 → `kimi-k3-max`" 폴백에
   도달 불가

대조군 (이미 올바른 경로):

```
src/providers/registry.ts:587   opencode-go   modelDefaultReasoningEfforts: { "kimi-k3": "max" }
src/providers/registry.ts:501   kimi          KIMI_CODING_DEFAULT_REASONING_EFFORTS
src/providers/registry.ts:1035  kimi-code     KIMI_CODING_DEFAULT_REASONING_EFFORTS
```

cursor만 누락 → 공식 기본값과 불일치 + 사내 경로 간 불일치.

## 변경 계획 (diff level)

### MODIFY `src/providers/registry.ts` — cursor 엔트리 (line ~386 부근)

```diff
     modelReasoningEfforts: cursorModelReasoningEfforts(CURSOR_STATIC_MODELS),
+    // Kimi K3 documents `max` as its API default (low/high/max ladder); without this the
+    // catalog default settles on `high` and the picker sends it explicitly, so the request
+    // builder's no-effort fallback to `kimi-k3-max` is never reached. Mirrors the other
+    // K3 routes (kimi, kimi-code, opencode-go).
+    modelDefaultReasoningEfforts: { "kimi-k3": "max" },
```

정확한 삽입 위치는 `modelReasoningEfforts` 직후. 다른 필드 순서는 건드리지 않는다.

### MODIFY `tests/codex-catalog.test.ts`

회귀 케이스 추가 — **카탈로그 엔트리의 기본값**을 검증한다. 래더만 검증하면 이 결함을
못 잡는다는 점이 핵심이다(PR의 기존 테스트가 래더만 본다).

조립 헬퍼는 이 파일이 이미 쓰는 `buildCatalogEntries`를 재사용한다
(용례: `tests/codex-catalog.test.ts:251-262`의 "preserves exact combo ladders…" 케이스가
`buildCatalogEntries(template, [], [model], undefined, false, "default", exact)`로 조립하고
`row?.default_reasoning_level`을 단정한다). 새 헬퍼를 만들지 않는다.

추가할 케이스:

검증된 실제 시그니처 (B 단계에서 이 이름들을 그대로 쓴다):

```
src/providers/derive.ts:224     enrichProviderFromRegistry(name: string, prov: OcxProviderConfig): void
                                  ← prov를 제자리 변형(mutate)한다. 반환값이 없다
src/codex/catalog/provider-fetch.ts:126
        applyProviderConfigHints(name: string, prov: OcxProviderConfig,
                                 model: CatalogModel, providerCap?: number): CatalogModel
src/codex/catalog/sync.ts:229   buildCatalogEntries(template: RawEntry | null, gptSlugs: string[],
                                 goModels: CatalogModel[], featured?: string[], wsEnabled = false,
                                 multiAgentMode: MultiAgentMode = "default", ...)
```

두 번의 오기를 거쳐 확정했다(정직하게 기록):

- 초판 `deriveProviderFromRegistry` — **존재하지 않는 함수**
- 개정 1판 `providerConfigSeed(entry)` — 존재하지만 `void`가 아니라 시드를 반환하는
  하위 함수이며, 레지스트리 보강 경로로 쓰기엔 부적절
- 확정: `enrichProviderFromRegistry(name, prov)` — `void` 반환 + 제자리 변형이므로
  **인자 표현식으로 쓸 수 없다.** 반드시 별도 문장으로 호출한 뒤 `prov`를 넘긴다

임포트는 이미 테스트 파일에 있다: `enrichProviderFromRegistry`는
`tests/codex-catalog.test.ts:26`, `applyProviderConfigHints`는 `:5`(카탈로그 배럴 경유).
용례는 `:683`의 `enrichProviderFromRegistry("google", google)`.

```ts
test("cursor kimi-k3 keeps max as its catalog default reasoning level", () => {
  const prov = { adapter: "cursor" } as OcxProviderConfig;
  enrichProviderFromRegistry("cursor", prov);   // void — 별도 문장으로 호출
  const hinted = applyProviderConfigHints("cursor", prov, {
    id: "kimi-k3",
    provider: "cursor",
  } as CatalogModel);

  // 1) 래더는 PR이 넣은 3단이 유지된다
  expect(hinted.reasoningEfforts).toEqual(["low", "high", "max"]);
  // 2) 기본값이 max로 내려온다 — 보강 전에는 undefined 였고 카탈로그가 high로 정착했다
  expect(hinted.defaultReasoningEffort).toBe("max");

  // 3) 카탈로그 행까지 조립해 확인한다 (여기가 실제 회귀 지점)
  const row = buildCatalogEntries(null, [], [hinted])
    .find(e => e.slug === "cursor/kimi-k3");
  expect(row?.default_reasoning_level).toBe("max");
});
```

감사자가 이 로직을 실제 헬퍼로 실행해 단정값을 확인했다:

```
PR #646 적용, 보강 없음(ablation):  defaultReasoningEffort=undefined  row.default_reasoning_level=high
PR #646 + { "kimi-k3": "max" }:     defaultReasoningEffort="max"      row.default_reasoning_level=max
```

메인 세션이 조립 경로를 실측해 확정한 값 (스크래치 테스트, 워크트리 미변경):

```
catalogModelSlug({ id: "kimi-k3", provider: "cursor" })  ->  "cursor/kimi-k3"
buildCatalogEntries(null, [], [model])  ->  row slugs ["cursor/kimi-k3"]        (3인자 호출 유효)
row.default_reasoning_level  ->  "max"      (defaultReasoningEffort: "max" 주입 시)
row.supported_reasoning_levels ->  ["low","high","max","ultra"]
```

따라서 `.find(e => e.slug === "cursor/kimi-k3")`는 실제로 매칭된다 — slug는
`catalogModelSlug`가 `provider/id`로 만든다(`src/codex/catalog/parsing.ts`).
`buildCatalogEntries`의 4~7번 인자는 모두 기본값이 있어 3인자 호출이 유효하다
(`src/codex/catalog/sync.ts:229-237`).

B 단계 주의: 조립된 행의 래더에는 `ultra`가 포함된다(mock-top-tier 블록이 더한다).
단정 1은 `hinted.reasoningEfforts`를 보므로 영향받지 않지만, 행의 래더를 단정하려면
`ultra`를 포함해야 한다.

위 구조(래더 → 기본값 → 조립된 행의 `default_reasoning_level`)가 요구사항이며, 세 번째
단정이 없으면 이 회귀를 못 잡는다.

**역방향 확인 (필수)**: `modelDefaultReasoningEfforts` 한 줄을 지운 상태에서 이 테스트가
`high`를 보고 **실패해야** 한다. 실패를 확인한 뒤 되돌린다.

### MODIFY docs-site — Cursor 커버리지 (P2 #1)

영문 소스가 기준이고 번역 로케일이 모순되지 않게 함께 갱신한다.

```
docs-site/src/content/docs/guides/providers.md:256      | Cursor | cursor/gpt-5.6-* | 1,000,000 |
docs-site/src/content/docs/ko/guides/providers.md:186
docs-site/src/content/docs/ja/guides/providers.md:186
docs-site/src/content/docs/ru/guides/providers.md:199
docs-site/src/content/docs/zh-cn/guides/providers.md:174
```

주의: 이 표는 **GPT-5.6 경로 커버리지 표**다. `kimi-k3`를 이 표에 끼워넣으면 표의
의미가 깨진다(감사도 같은 결론). 대신 Cursor 어댑터 절에 시드 모델을 추가한다.

영문 소스의 해당 문장(`docs-site/src/content/docs/guides/providers.md:277-279`):

```
Its v2.7.1 fallback seed includes `gpt-5.6-sol` / `terra` / `luna` (1M context)
plus `grok-4.5` / `grok-4.5-fast` (500K); live discovery decides which remain visible for the
account.
```

개정 문구 (확정):

```diff
-Its v2.7.1 fallback seed includes `gpt-5.6-sol` / `terra` / `luna` (1M context)
-plus `grok-4.5` / `grok-4.5-fast` (500K); live discovery decides which remain visible for the
-account.
+Its v2.7.1 fallback seed includes `gpt-5.6-sol` / `terra` / `luna` (1M context),
+`grok-4.5` / `grok-4.5-fast` (500K), and `kimi-k3` (262K); live discovery decides which
+remain visible for the account. Cursor serves Kimi K3 only as effort-suffixed wire ids, so
+`cursor/kimi-k3` exposes a `low` / `high` / `max` ladder and defaults to `max`, matching the
+model's documented API default.
```

4개 로케일의 대응 문장도 같은 내용으로 맞춘다. 실측한 위치(초판이 적은 줄번호는
GPT-5.6 표의 것이며 이 문장의 것이 아니었다 — 감사 지적):

```
docs-site/src/content/docs/ko/guides/providers.md:208     "v2.7.1 폴백 목록에는 1M 컨텍스트의 …"
docs-site/src/content/docs/ja/guides/providers.md:207     "v2.7.1 フォールバックリストには 1M コンテキストの …"
docs-site/src/content/docs/ru/guides/providers.md:221     "Его резервный список версии v2.7.1 включает …"
docs-site/src/content/docs/zh-cn/guides/providers.md:193  "v2.7.1 回退列表包含上下文为 …"
```

각 파일에서 해당 문장이 걸쳐 있는 다음 1~2행까지 함께 읽고, `kimi-k3` (262K)와
`max` 기본값 문장을 그 언어의 기존 문체로 추가한다. 영문 소스가 기준이며 번역이
영문과 모순되지 않아야 한다(AGENTS.md docs-sync).

**커밋 결합 규칙 (감사 지적)**: 이 docs 문장은 래더와 `max` 기본값을 산문으로 단정한다.
따라서 `modelDefaultReasoningEfforts` 한 줄과 **같은 커밋**에 들어가야 한다. 문서만
먼저 들어가면 그 커밋 시점에 문장이 거짓이 된다.

숫자 검증: `262K`는 정확하다 — PR #646이 `{ id: "kimi-k3", contextWindow: CONTEXT_262K,
supportsReasoningEffort: true }`로 시드하고 `CONTEXT_262K = 262_144`
(`src/adapters/cursor/discovery.ts:17`). "defaults to max"도 보강 후 정확하다
(감사에서 `applyReasoningLevels` 실행으로 검증됨).

## 실행 계획

1. 로컬에서 컨트리뷰터 브랜치를 가져와 `dev` 위에서 확인
   ```bash
   gh pr checkout 646   # 또는 fetch + 별도 브랜치
   ```
   `maintainerCanModify: true`이므로 컨트리뷰터 브랜치에 직접 보강 커밋을 push할 수 있다.
2. 위 3개 변경 적용 → 로컬 검증
   ```bash
   bun x tsc --noEmit
   bun test tests/cursor-effort-suffix.test.ts tests/cursor-discovery.test.ts
   bun test tests/codex-catalog.test.ts tests/provider-registry-parity.test.ts tests/reasoning-effort.test.ts
   ```
   주의: `cursor-effort-suffix.test.ts`는 `@bufbuild/protobuf`가 필요하다(리뷰어가
   워크트리에서 겪은 실패). `bun install` 상태를 먼저 확인한다.
3. 보강 커밋을 PR 브랜치에 push (사용자가 이 4건 범위로 push를 승인함)
4. undraft → CI 대기
   ```bash
   gh pr ready 646
   gh pr checks 646 --watch    # 또는 폴링
   ```
5. CI green + CHANGES_REQUESTED 해소 후 승인 + squash 머지

## 수용 기준

- 새 회귀 테스트가 `default_reasoning_level === "max"`를 검증하고 pass
- **패치 이전 상태에서 그 테스트가 실제로 fail** (활성화 증명)
- `tsc` exit 0, cursor + 카탈로그 스위트 green
- docs-site 영문 + 4개 로케일이 서로 모순 없음
- `gh pr view 646` → `mergedAt` non-null, draft 아님

## 활성화 근거 (C-ACTIVATION-GROUNDING-01)

추가하는 것은 **기본값 오버라이드 분기**다. 트리거는 "cursor/kimi-k3 카탈로그 엔트리
조립". 관측 효과는 `default_reasoning_level`이 `high` → `max`로 바뀌는 것.
`modelDefaultReasoningEfforts` 한 줄을 제거하면 테스트가 `high`를 보고 실패해야 한다 —
이 역방향 확인으로 분기가 실제로 발화함을 증명한다. "테스트 전부 green"만으로는
불충분하다.

## 범위 경계

- IN: cursor 엔트리 기본값 1줄, 회귀 테스트 1건, docs Cursor 절 갱신, #646 랜딩
- OUT: 다른 cursor 모델의 티어 변경, `CURSOR_MODEL_EFFORT_TIERS` 재구조화,
  GPT-5.6 커버리지 표 스키마 변경, live discovery 로직 변경
