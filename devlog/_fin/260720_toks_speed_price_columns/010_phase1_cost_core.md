# 010 — WP1 비용 코어 구현 PRD

## 0. 목적과 경계

이 문서는 `000_plan.md`의 **260720 v2 확정 정책**을 구현하는 WP1의 copy-paste-executable PRD다.
코드 구현자는 이 문서의 5개 파일만 변경한다. GUI는 WP2/WP3 소유이므로 여기서는
`CostEstimate | null`을 소비한다는 한 줄 계약만 남기며 GUI 파일은 수정하지 않는다.

- 가격은 과거 청구 재현값이 아니라 표시 시점의 추정치다. GUI는 모든 숫자 비용에 `~$`를 붙인다.
- 캐시 상세가 하나도 없으면 `R=W=0`으로 input 전액을 계산한다.
- 부분 상세는 알려진 값만 쓴다: read-only면 `W=0`, write-only면 `R=0`.
- `R+W>I` 모순은 fail-closed(`null`)다. 단 명시적 `cacheReadInputTokens` 없이
  `cachedInputTokens`만 있는 implicit 형태는 legacy(read+write 합산형) 복원을 한 번
  재시도한 뒤에도 모순일 때만 `null`이다(§6 normalizeCostTokens). 비정상 usage,
  가격 미매칭, all-zero 가격+overlay 부재도 `null`이며 UI의 `—`다.
- 가격 snapshot은 `usage.jsonl`에 저장하지 않는다.
- combo는 attempt별 단가를 적용한다. 하나라도 가격을 못 찾으면 부분합을 반환하지 않고 `null`이다.

## 1. fresh HEAD 근거

다음 앵커는 2026-07-20의 이 워크트리 HEAD에서 다시 확인했다.

- generator 입력/출력과 현행 6칸 tuple: `scripts/generate-jawcode-metadata.ts:7-19`, `:41-53`, `:56-67`, `:94-103`.
- generated exact lookup은 `row[0] === modelId`: `src/generated/jawcode-model-metadata.ts:45-52`.
- `OcxUsage.inputTokens`는 cache read/write 포함 총 prompt이며 total은 input+output:
  `src/types.ts:227-244`.
- Anthropic adapter는 raw input에 read/write를 더해 inclusive `inputTokens`를 만든다:
  `src/adapters/anthropic.ts:292-307`.
- provider alias 원천은 `deriveJawcodeAliases()`: `src/providers/derive.ts:227-236`.
- 라우팅 후 로그의 `model/provider`는 native route identity다:
  `src/server/responses.ts:814-825`; slash 모델은 exact known-ID decode를 거쳐 native ID로 복원된다:
  `src/providers/slug-codec.ts:13-19`. 따라서 가격 lookup에 `requestedModel`, `resolvedModel`,
  `-`→`/` 추측 변환을 사용하지 않는다(002 §3 정책).
- jawcode 계산 단위는 USD/1M tokens: `../jawcode/packages/stats/src/db.ts:214-228`.

## 2. 변경 파일 manifest (5)

| 상태 | 파일 | 책임 |
| --- | --- | --- |
| MODIFY | `scripts/generate-jawcode-metadata.ts` | jawcode cost 4필드를 compact tuple 뒤에 생성 |
| MODIFY (generated) | `src/generated/jawcode-model-metadata.ts` | `cost` 공개 및 tuple decode; 직접 편집 금지 |
| NEW | `src/usage/expected-prices.ts` | 003이 채우는 expected-price overlay schema와 exact loader |
| NEW | `src/usage/cost.ts` | usage 정규화, 가격 선택, 비용 계산, combo 합산, tok/s helper |
| NEW | `tests/usage-cost.test.ts` | 비용/속도 순수함수 회귀 스위트 |

## 3. MODIFY — `scripts/generate-jawcode-metadata.ts`

### 3.1 Raw schema와 generated interface

```diff
 type RawModel = {
   id?: string;
   contextWindow?: number;
   maxTokens?: number;
   input?: ("text" | "image")[];
   reasoning?: boolean;
   wireModelId?: string;
+  cost?: {
+    input: number;
+    output: number;
+    cacheRead: number;
+    cacheWrite: number;
+  };
 };
```

```diff
 lines.push("  reasoning?: boolean;");
 lines.push("  wireModelId?: string;");
+lines.push("  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };");
 lines.push("}");
```

### 3.2 Row tuple — 기존 6칸 뒤에 cost 4칸

cost 뒤에 다른 필드를 끼우지 않는다. 앞 optional 칸이 비어 있는데 뒤 cost가 존재하면
`JSON.stringify()`가 hole을 `null`로 쓰므로 tuple의 앞 6칸은 `null`을 허용해야 한다.

```diff
-lines.push("type Row = readonly [id: string, contextWindow?: number, maxTokens?: number, input?: string, reasoning?: 0 | 1, wireModelId?: string];");
+lines.push("type Row = readonly [id: string, contextWindow?: number | null, maxTokens?: number | null, input?: string | null, reasoning?: 0 | 1 | null, wireModelId?: string | null, costInput?: number | null, costOutput?: number | null, costCacheRead?: number | null, costCacheWrite?: number | null];");
```

```diff
       model.reasoning === undefined ? undefined : (model.reasoning ? 1 : 0),
       model.wireModelId,
+      model.cost?.input,
+      model.cost?.output,
+      model.cost?.cacheRead,
+      model.cost?.cacheWrite,
     ]));
```

### 3.3 tuple decode

```diff
 function rowToMetadata(provider: string, row: Row): JawcodeModelMetadata {
-  const [id, contextWindow, maxTokens, input, reasoning, wireModelId] = row;
+  const [
+    id, contextWindow, maxTokens, input, reasoning, wireModelId,
+    costInput, costOutput, costCacheRead, costCacheWrite,
+  ] = row;
   return {
     provider, id,
-    ...(contextWindow !== undefined ? { contextWindow } : {}),
-    ...(maxTokens !== undefined ? { maxTokens } : {}),
+    ...(contextWindow != null ? { contextWindow } : {}),
+    ...(maxTokens != null ? { maxTokens } : {}),
     ...(input ? { input: input.split(",") as ("text" | "image")[] } : {}),
-    ...(reasoning !== undefined ? { reasoning: reasoning === 1 } : {}),
-    ...(wireModelId !== undefined ? { wireModelId } : {}),
+    ...(reasoning != null ? { reasoning: reasoning === 1 } : {}),
+    ...(wireModelId != null ? { wireModelId } : {}),
+    ...(costInput != null && costOutput != null && costCacheRead != null && costCacheWrite != null
+      ? { cost: { input: costInput, output: costOutput, cacheRead: costCacheRead, cacheWrite: costCacheWrite } }
+      : {}),
   };
 }
```

재생성은 저장소 루트에서 아래 한 명령으로 한다. generated 파일은 손으로 고치지 않는다.

```sh
bun run generate:jawcode-metadata
```

## 4. MODIFY (generated) — `src/generated/jawcode-model-metadata.ts`

이 파일의 diff는 §3 generator 실행 결과여야 한다. review 시 최소한 다음 구조가 실제로 생성됐는지
확인한다. DATA 전체의 수동 patch는 금지한다.

```diff
 export interface JawcodeModelMetadata {
   provider: string;
   id: string;
   contextWindow?: number;
   maxTokens?: number;
   input?: ("text" | "image")[];
   reasoning?: boolean;
   wireModelId?: string;
+  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
 }
```

```diff
-type Row = readonly [id: string, contextWindow?: number, maxTokens?: number, input?: string, reasoning?: 0 | 1, wireModelId?: string];
+type Row = readonly [id: string, contextWindow?: number | null, maxTokens?: number | null, input?: string | null, reasoning?: 0 | 1 | null, wireModelId?: string | null, costInput?: number | null, costOutput?: number | null, costCacheRead?: number | null, costCacheWrite?: number | null];
```

각 DATA row는 기존 6칸 뒤에 `[cost.input,cost.output,cost.cacheRead,cost.cacheWrite]`가 붙는다.
예를 들어 wireModelId가 없으면 `...,null,<input>,<output>,<cacheRead>,<cacheWrite>` 형태다.
`rowToMetadata()`는 §3.3과 동일해야 한다. 기존 exact/case-insensitive/list API는 삭제·rename하지 않는다.

## 5. NEW — `src/usage/expected-prices.ts`

003 Luna 조사 결과가 이 파일의 `EXPECTED_PRICE_OVERLAYS` 배열만 채운다. 이 WP 문서는 가격값을
추측하지 않으며, 아래 schema/loader를 그대로 만든다. 빈 배열도 유효한 fail-closed 상태다.

```ts
export interface Cost4 {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ExpectedPriceStatus = "verified" | "verified-derived" | "unverified";
// verified: 공식 페이지 직접 열람. verified-derived: suffix→기반 모델 등 유도 매핑
// (source에 derivation 근거 필수, GUI 상세에 표시). unverified: lead — 등재 금지,
// production resolver가 거부한다 (audit blocker #2/#4 fold).

export interface ExpectedPriceOverlay {
  provider: string;
  modelId: string;
  cost4: Cost4;
  source: string;
  verifiedAt: string;
  status: ExpectedPriceStatus;
}

/**
 * Source-reviewed expected list prices for zero/missing jawcode rows.
 * 003_luna_expected_prices.md owns the concrete entries.
 */
export const EXPECTED_PRICE_OVERLAYS: readonly ExpectedPriceOverlay[] = [];

// 구현 시 003 §4의 verified/verified-derived 행으로 채운다. exact key 11개
// (audit blocker #3 fold — provider는 registry의 실제 로그 provider id):
//   minimax        / MiniMax-M2.1-highspeed          (verified)
//   minimax-cn     / MiniMax-M2.1-highspeed          (verified)
//   google-antigravity / gemini-3.1-pro-low          (verified-derived: gemini-3.1-pro ≤200k)
//   google-antigravity / gemini-3.1-pro-high         (verified-derived)
//   google-antigravity / gemini-3.5-flash-extra-low  (verified-derived: gemini-3.5-flash)
//   google-antigravity / gemini-3.5-flash-low        (verified-derived)
//   google-antigravity / gemini-3.5-flash-mid        (verified-derived)
//   google-antigravity / gemini-3.5-flash-high       (verified-derived)
//   google-antigravity / gemini-3-flash-agent        (verified-derived: gemini-3-flash, Agent 과금 원칙)
//   deepseek       / deepseek-chat                   (verified — 2026-07-24 전환 후 재검증)
//   deepseek       / deepseek-reasoner               (verified)
// google-antigravity의 claude-*/gpt-oss-*/gemini-pro-agent/gemini-3-pro는 등재 금지(003 §2).

export function findExpectedPriceOverlay(
  provider: string,
  modelId: string,
  overlays: readonly ExpectedPriceOverlay[] = EXPECTED_PRICE_OVERLAYS,
): ExpectedPriceOverlay | undefined {
  // production 경로는 unverified를 반환하지 않는다(fail-closed를 코드로 강제 —
  // audit blocker #4 fold). unverified는 문서/백로그 전용 상태다.
  const exact = overlays.filter(row => row.provider === provider && row.modelId === modelId);
  return exact.find(row => row.status === "verified")
    ?? exact.find(row => row.status === "verified-derived");
}
```

loader는 provider와 native model ID 모두 exact 비교한다. 우선순위는 verified →
verified-derived이며 **unverified는 반환하지 않는다**(overlay 배열에 등재하지도 않는다 —
미검증 가격은 003 §5 조사 백로그에만 기록). fuzzy/case-fold/wire-model fallback은 금지한다.

## 6. NEW — `src/usage/cost.ts`

아래 public API와 동작을 그대로 구현한다. `null`은 모든 consumer에서 `—`다.

```ts
import {
  getJawcodeModelMetadata,
  resolveJawcodeProvider,
} from "../generated/jawcode-model-metadata";
import type { OcxUsage } from "../types";
import type { PersistedUsageAttempt, UsageStatus } from "./log";
import {
  findExpectedPriceOverlay,
  type Cost4,
  type ExpectedPriceOverlay,
  type ExpectedPriceStatus,
} from "./expected-prices";

export interface CostTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface MatchedPrice {
  provider: string;
  modelId: string;
  jawcodeProvider?: string;
  cost4: Cost4;
  source: "jawcode" | "expected";
  sourceRef?: string;
  verifiedAt?: string;
  status: "verified" | "verified-derived";
}

export interface AttemptCostEstimate {
  ordinal: number;
  provider: string;
  model: string;
  tokens: CostTokens;
  price: MatchedPrice;
  cost: CostBreakdown;
  estimated: boolean;
}

export interface CostEstimate {
  tokens: CostTokens;
  cost: CostBreakdown;
  estimated: boolean;
  attempts?: AttemptCostEstimate[];
  price?: MatchedPrice;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validCost4(cost: Cost4 | undefined): cost is Cost4 {
  return !!cost
    && finiteNonNegative(cost.input)
    && finiteNonNegative(cost.output)
    && finiteNonNegative(cost.cacheRead)
    && finiteNonNegative(cost.cacheWrite);
}

function hasNonZeroCost(cost: Cost4): boolean {
  return cost.input !== 0 || cost.output !== 0
    || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

export function normalizeCostTokens(usage: OcxUsage): CostTokens | null {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  // canonical 계약(src/types.ts:231)은 cachedInputTokens 자체가 read다. legacy
  // claude-route 행만 cachedInputTokens=read+write였다(devlog 070). 두 형태는 필드만으로
  // 구별 불가하므로(재감사 blocker #2): canonical 해석을 우선 적용하고, 그 해석이
  // R+W>I 모순을 만들 때만 legacy 복원(cached−creation)을 한 번 재시도한다.
  // 재시도도 모순이면 fail-closed(null). 정상 canonical 행(read-only mirror 포함)은
  // 첫 해석으로 통과하므로 과소계산이 없고, legacy 행은 재시도로 복원된다.
  const primaryRead = usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0;
  const candidates: number[] = [primaryRead];
  if (typeof usage.cacheReadInputTokens !== "number"
    && typeof usage.cachedInputTokens === "number"
    && typeof usage.cacheCreationInputTokens === "number") {
    candidates.push(Math.max(0, usage.cachedInputTokens - usage.cacheCreationInputTokens));
  }
  for (const cacheRead of candidates) {
    if (![input, output, cacheRead, cacheWrite].every(finiteNonNegative)) return null;
    if (cacheRead + cacheWrite > input) continue;
    return {
      input: Math.max(0, input - cacheRead - cacheWrite),
      output,
      cacheRead,
      cacheWrite,
    };
  }
  return null;
}

export function calculateCost(tokens: CostTokens, cost4: Cost4): CostBreakdown {
  const input = cost4.input * tokens.input / 1_000_000;
  const output = cost4.output * tokens.output / 1_000_000;
  const cacheRead = cost4.cacheRead * tokens.cacheRead / 1_000_000;
  const cacheWrite = cost4.cacheWrite * tokens.cacheWrite / 1_000_000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

export function resolveMatchedPrice(
  provider: string,
  modelId: string,
  overlays?: readonly ExpectedPriceOverlay[],
): MatchedPrice | null {
  const jawcodeProvider = resolveJawcodeProvider(provider);
  const jawcode = jawcodeProvider
    ? getJawcodeModelMetadata(jawcodeProvider, modelId)
    : undefined;
  if (validCost4(jawcode?.cost) && hasNonZeroCost(jawcode.cost)) {
    return {
      provider,
      modelId,
      jawcodeProvider,
      cost4: jawcode.cost,
      source: "jawcode",
      status: "verified",
    };
  }

  const overlay = findExpectedPriceOverlay(provider, modelId, overlays);
  if (!overlay || !validCost4(overlay.cost4) || !hasNonZeroCost(overlay.cost4)) return null;
  return {
    provider,
    modelId,
    cost4: overlay.cost4,
    source: "expected",
    sourceRef: overlay.source,
    verifiedAt: overlay.verifiedAt,
    status: overlay.status,
  };
}

function isEstimated(usage: OcxUsage, usageStatus: UsageStatus, priceStatus: ExpectedPriceStatus): boolean {
  return usage.estimated === true || usageStatus === "estimated" || priceStatus === "verified-derived";
}

export function estimateAttemptCost(
  attempt: Pick<PersistedUsageAttempt, "ordinal" | "provider" | "model" | "usage" | "usageStatus">,
  overlays?: readonly ExpectedPriceOverlay[],
): AttemptCostEstimate | null {
  if (!attempt.usage) return null;
  const tokens = normalizeCostTokens(attempt.usage);
  const price = resolveMatchedPrice(attempt.provider, attempt.model, overlays);
  if (!tokens || !price) return null;
  return {
    ordinal: attempt.ordinal,
    provider: attempt.provider,
    model: attempt.model,
    tokens,
    price,
    cost: calculateCost(tokens, price.cost4),
    estimated: isEstimated(attempt.usage, attempt.usageStatus, price.status),
  };
}

function sumTokens(attempts: readonly AttemptCostEstimate[]): CostTokens {
  return attempts.reduce((sum, attempt) => ({
    input: sum.input + attempt.tokens.input,
    output: sum.output + attempt.tokens.output,
    cacheRead: sum.cacheRead + attempt.tokens.cacheRead,
    cacheWrite: sum.cacheWrite + attempt.tokens.cacheWrite,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
}

function sumCosts(attempts: readonly AttemptCostEstimate[]): CostBreakdown {
  return attempts.reduce((sum, attempt) => ({
    input: sum.input + attempt.cost.input,
    output: sum.output + attempt.cost.output,
    cacheRead: sum.cacheRead + attempt.cost.cacheRead,
    cacheWrite: sum.cacheWrite + attempt.cost.cacheWrite,
    total: sum.total + attempt.cost.total,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
}

export function estimateComboCost(
  attempts: readonly Pick<PersistedUsageAttempt, "ordinal" | "provider" | "model" | "usage" | "usageStatus">[],
  overlays?: readonly ExpectedPriceOverlay[],
): CostEstimate | null {
  if (attempts.length === 0) return null;
  const estimated = attempts.map(attempt => estimateAttemptCost(attempt, overlays));
  if (estimated.some(attempt => attempt === null)) return null;
  const matched = estimated as AttemptCostEstimate[];
  return {
    tokens: sumTokens(matched),
    cost: sumCosts(matched),
    estimated: matched.some(attempt => attempt.estimated),
    attempts: matched,
  };
}

export function estimateUsageCost(
  input: {
    provider: string;
    model: string;
    usage?: OcxUsage;
    usageStatus: UsageStatus;
    attempts?: readonly PersistedUsageAttempt[];
  },
  overlays?: readonly ExpectedPriceOverlay[],
): CostEstimate | null {
  if (input.attempts?.length) return estimateComboCost(input.attempts, overlays);
  if (!input.usage) return null;
  const tokens = normalizeCostTokens(input.usage);
  const price = resolveMatchedPrice(input.provider, input.model, overlays);
  if (!tokens || !price) return null;
  return {
    tokens,
    price,
    cost: calculateCost(tokens, price.cost4),
    estimated: isEstimated(input.usage, input.usageStatus, price.status),
  };
}

export function tokensPerSecond(outputTokens: number, durationMs: number): number | null {
  if (!finiteNonNegative(outputTokens) || !finiteNonNegative(durationMs)) return null;
  if (outputTokens <= 0 || durationMs <= 0) return null;
  return outputTokens / (durationMs / 1_000);
}
```

`resolveMatchedPrice()`의 순서는 고정이다: jawcode exact nonzero → overlay verified →
overlay verified-derived → `null`. **unverified는 resolver가 반환하지 않는다**(fail-closed를
코드로 강제). jawcode all-zero는 무료가 아니라 overlay 후보이며, overlay도 없으면 `null`이다.
`estimated`는 usage 추정 또는 verified-derived price가 하나라도 있으면 true다. v2 GUI는
true 여부와 무관하게 모든 비용 숫자에 `~$`를 붙이고, true는 상세 사유에 사용한다.

## 7. NEW — `tests/usage-cost.test.ts`

`bun:test`로 다음 케이스를 한 파일에 둔다. 실제 함수명은 §6과 일치해야 한다.

1. **OpenAI형 cached⊂input**: `I=100,R=40,W=0,O=10` → cost input token은 60, read는 40.
2. **Anthropic inclusive 이중과금 회귀**: raw=100, R=40, W=20인 adapter 결과
   `inputTokens=160` fixture를 넣는다. rate `{input:3,output:15,cacheRead:.3,cacheWrite:3.75}`에서
   input 비용이 `100*3/1e6`이고 total이 `(300+150+12+75)/1e6 = 0.000537`인지 검증한다.
   `inputTokens=160` 전체에 input rate를 곱한 값이 아님을 별도 assertion한다.
3. **read-only 부분 상세**: R만 존재하면 W=0, input=`I-R`.
4. **write-only 부분 상세**: W만 존재하면 R=0, input=`I-W`.
5. **모순**: 명시적 `cacheReadInputTokens`가 있는 fixture에서 `R+W>I`는 즉시 `null`.
   implicit(cached만) 형태의 모순 처리는 테스트 13(b)/(c)가 소유한다.
6. **미매칭**: 존재하지 않는 provider/model exact key는 `null`.
7. **all-zero**: all-zero jawcode row에 overlays `[]`를 넘기면 `null`; `$0` 금지.
8. **expected overlay 우선순위**: 같은 exact key의 unverified+verified fixture에서 verified가
   선택되고, **unverified-only fixture는 선택되지 않는다(`undefined` — fail-closed 강제)**.
   verified-derived-only fixture는 선택되며 estimate의 `estimated=true`가 된다.
   jawcode nonzero key에 overlay를 주면 jawcode가 이긴다.
9. **native slash exact**: `openrouter`의 실제 slash model ID exact 조회는 성공하고,
   slash를 hyphen으로 바꾼 ID는 실패한다.
10. **combo 합산**: 서로 다른 두 provider/model attempt 비용을 각 rate로 계산해 four-way/total을
    합산한다. 하나가 usage estimated 또는 verified-derived overlay면 전체 `estimated=true`다.
11. **combo fail-closed**: 한 attempt 가격이 미매칭이면 반환값 전체가 `null`; matched attempt의
    부분합을 노출하지 않는다.
12. **tok/s**: `100,2000`→50; output `0`, duration `0`, 음수, `NaN`, `Infinity`는 `null`.
13. **cachedInputTokens 모호성 처리** (audit blocker #1 + 재감사 #2): (a) canonical-우선 —
    `I=160, cachedInputTokens=60, cacheCreationInputTokens=20, cacheReadInputTokens` 없음
    fixture는 첫 해석 `R=60,W=20`이 모순 없으므로 그대로 `input=80` (canonical 계약 존중,
    이중 차감 `I−R−2W=60` 아님을 별도 assertion). (b) legacy 복원 재시도 — `I=70,
    cachedInputTokens=60, cacheCreationInputTokens=20` fixture는 첫 해석 `R=60,W=20`이
    `R+W=80>70` 모순이므로 legacy 재시도 `R=40,W=20` → `input=10`. (c) 재시도도 모순인
    fixture(`I=50, cached=60, creation=20` → 재시도 R=40, 40+20>50)는 `null`.
14. **usage 없는 attempt / 0-attempt combo** (audit blocker #5): `usage`가 없는 attempt는
    `estimateAttemptCost()`가 `null`, attempts 빈 배열 combo는 전체 `null`.
15. **비유한 usage 값** (audit blocker #5): `inputTokens=NaN`/`Infinity`/음수 각각에서
    `normalizeCostTokens()`가 `null`.
16. **오버레이 등재 membership** (audit blocker #3): exported `EXPECTED_PRICE_OVERLAYS`가
    §5 주석의 11개 exact key를 정확히 포함하고(순서 무관), status가 verified 또는
    verified-derived뿐이며 unverified 행이 없음을 검증.

테스트 fixture는 외부 network를 쓰지 않는다. jawcode snapshot을 쓰는 exact/all-zero 테스트 외의
단가 계산은 `calculateCost()`에 명시적 fixture rate를 주어 catalog drift와 분리한다.

## 8. 구현 순서

1. generator를 patch하고 `bun run generate:jawcode-metadata`로 generated artifact를 갱신한다.
2. `expected-prices.ts` schema/loader를 추가하고 003의 확정 테이블을 배열에 반영한다.
3. `cost.ts` 순수함수를 추가한다.
4. `usage-cost.test.ts`를 추가하고 targeted test를 통과시킨다.
5. typecheck를 실행한다. GUI 소비는 WP2/WP3에서만 한다.

## 9. close gate

저장소 루트 `/Users/jun/Developer/new/700_projects/opencodex-toksdev`에서 순서대로 실행한다.

```sh
bun run generate:jawcode-metadata
bun run typecheck
bun test --isolate tests/usage-cost.test.ts
```

통과 조건:

- 세 명령 모두 exit 0.
- generated diff에 각 DATA row의 cost 4칸과 `JawcodeModelMetadata.cost`가 존재한다.
- Anthropic inclusive fixture가 input 단가를 raw input 100에만 적용한다.
- combo 미매칭 테스트가 `null`을 반환한다.
- `git diff --stat` 확인은 부모 orchestration의 WP close 절차가 수행하며, 이 문서의 구현자는
  GUI 파일을 건드리지 않는다.

## 10. 리스크와 금지사항

1. optional tuple 뒤에 cost를 붙이며 `null` hole 타입을 허용하지 않으면 generated TS가 깨진다.
2. `getJawcodeModelMetadataCaseInsensitive()` 또는 `resolvedModel` fallback을 쓰면 native exact
   정책과 slash ID 안전성이 깨진다.
3. deepseek 오버레이는 2026-07-24 V4 Flash alias 전환 예정(003 §5) — 등재 시 `source`에
   전환 예정 비고를 남기고 후속 재검증 백로그에 연결한다.
4. all-zero를 `$0`으로 처리하거나 combo 부분합을 반환하면 사용자에게 실제 총비용처럼 보인다.
5. 003에서 검증 못 한 price는 **overlay 배열에 넣지 않는다** — 003 §5 백로그에만 기록하고,
   verified 승격 후에 등재한다. source/verifiedAt을 꾸며내지 않는다.
