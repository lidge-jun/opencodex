# 020 — WP2 Logs 테이블 `tok/s` + `~$` 2열 구현 명세

## 0. 범위와 선행조건

이 문서는 WP2 구현자가 그대로 따라갈 수 있는 diff-level PRD다. 코드 변경 대상은 아래 8개 파일이며, 이 문서 작성 단계에서는 코드를 변경하지 않는다.

| 구분 | 파일 | 책임 |
| --- | --- | --- |
| MODIFY | `src/server/management-api.ts` | `/api/logs` 응답 시점의 파생 지표 계산. request log 객체/JSONL에는 저장하지 않는다. |
| NEW | `tests/management-api-logs-metrics.test.ts` | additive API 계약, 미매칭, estimated, combo 파생 결과 검증 |
| MODIFY | `gui/src/pages/Logs.tsx` | API 타입, 두 열, 포맷, colSpan |
| MODIFY | `gui/src/styles.css` | 두 수치 열과 좁은 화면의 최소 폭 |
| MODIFY | `gui/src/i18n/en.ts` | 원본 locale 키 |
| MODIFY | `gui/src/i18n/ko.ts` | 한국어 locale 키 |
| MODIFY | `gui/src/i18n/zh.ts` | 중국어 locale 키 |
| MODIFY | `gui/src/i18n/de.ts` | 독일어 locale 키 |

선행조건은 WP1 완료다. WP1이 생성하는 `src/usage/cost.ts`와 generated cost metadata의 내부 구현은 010 소관이며 이 문서에서 변경하지 않는다.

> **WP2 P-phase stale-check (2026-07-20, WP1 landed 커밋 1e5af20b 대조):**
> 아래 "소비 계약" 블록은 concurrent 작성 시점의 가정이며 실제 landed API와 다음이 다르다.
> 구현은 landed API를 따른다:
>
> 1. `estimateUsageCost()` 단일 함수는 **없다**. landed export는
>    `estimateRequestCost({provider, model, usage, usageStatus}, overlays?)`(non-combo)와
>    `estimateComboCost(attempts, overlays?)`(combo)다. `/api/logs` adapter가
>    `entry.attempts?.length` 유무로 분기해 호출한다.
> 2. `MatchedPrice.status`는 `"verified" | "verified-derived"`다. `"unverified"`는
>    resolver가 아예 반환하지 않으므로(fail-closed가 코드로 강제됨) §3-4의
>    `expected_price_unverified` unavailable 분기와 `matched` 필드는 **삭제**한다 —
>    unverified는 estimate=null(→`price_unmatched`)로 이미 흡수된다.
>    DTO의 price.status 타입은 `"verified" | "verified-derived"`로 쓰고,
>    verified-derived면 `estimate.estimated`가 이미 true로 전파된다.
> 3. `CostEstimate.price`는 non-combo에만 있고 combo는 `attempts[].price`다(landed와 동일).

아래는 원래의 소비 계약 스케치다(위 stale-check가 우선).

```ts
// src/usage/cost.ts — WP1 소유, 020은 아래 export만 소비한다.
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
  source: "jawcode" | "expected";
  sourceRef?: string;
  verifiedAt?: string;
  status: "verified" | "unverified";
}

export interface CostEstimate {
  cost: CostBreakdown;
  estimated: boolean;
  attempts?: AttemptCostEstimate[];
  price?: MatchedPrice;
  // tokens도 존재하나 GUI는 raw usage 및 cost breakdown을 별도로 사용한다.
}

export function normalizeCostTokens(usage: OcxUsage): CostTokens | null;
export function resolveMatchedPrice(provider: string, modelId: string): MatchedPrice | null;
export function estimateUsageCost(input: {
  provider: string;
  model: string;
  usage?: OcxUsage;
  usageStatus: UsageStatus;
  attempts?: readonly PersistedUsageAttempt[];
}): CostEstimate | null;
export function tokensPerSecond(outputTokens: number, durationMs: number): number | null;
```

WP1의 `CostEstimate`는 JSON-safe plain data이고 combo top-level 비용을 attempt별 계산 후 합산한다. 하나라도 계산 불가하면 `null`이다. **stale-check #2에 따라 unverified 분기는 adapter에 필요 없다** — landed cost.ts가 unverified를 반환하지 않는다. cost.ts 내부를 수정하지 않는다.

020이 소유하는 API DTO는 §4의 `TokPerSecondResult`/`CostResult` discriminated union이다. unavailable/estimate 사유 분류는 §3 `unavailableCostReason()`이 SSOT다: usage 부재/unsupported → combo(attempt 단위 실패) → normalizer null(비유한 값 vs 양쪽 해석 모순) → exact price 미매칭. **normalizer 성공 여부를 먼저 확정**하고(legacy retry 복원 행을 오분류하지 않기 위해 — 감사 blocker #2) 이 adapter는 계산식을 복제하지 않고 이유만 분류한다.

## 1. fresh 현행 앵커

- `gui/src/pages/Logs.tsx:10-43`: `UsageBreakdown`, `LogUsageStatus`, `LogEntry`. 현재 `attempts`와 파생 지표 필드는 없다.
- `gui/src/pages/Logs.tsx:193-203`: thead는 `time / tokens / model / effort / provider / status / request / duration` 8열이다.
- `gui/src/pages/Logs.tsx:206-210`, `272-276`: virtual padding 위/아래 행이 각각 `colSpan={8}`이다.
- `gui/src/pages/Logs.tsx:220-246`: tokens cell은 `usageStatus === "estimated"`이면 `~`를 접두한다. 새 tok/s도 이 관행을 그대로 따른다.
- `gui/src/pages/Logs.tsx:149`: virtual row 예상 높이는 44px이며 실제 행은 `measureElement`로 재측정한다.
- `gui/src/styles.css:478-485`: `.tbl .num`은 우측 정렬, monospace, tabular nums를 제공하고 `.tbl-wrap`은 horizontal overflow를 허용한다.
- `gui/src/styles.css:699-707`: Logs 전용 model/tokens/status/detail 스타일이 이미 있다.
- `gui/src/styles.css:791-838`: 760px 이하에서 generic `.tbl { min-width: 460px; }`만 적용된다. 10열 Logs에는 부족하다.
- `gui/src/i18n/en.ts:283-314`: 실제 `logs.col.*`, token 상태/tooltip, 상세 키 위치. `en.ts`가 `TKey` 원본이고 4 locale 동기화가 필수다 (`gui/AGENTS.md:3-20`).
- `src/server/request-log.ts:63-89`: API 원본 `RequestLogEntry`는 duration, usage, usageStatus, attempts를 이미 갖는다.
- `src/server/management-api.ts:313-315`: `/api/logs`는 현재 `filterRequestLogs(getRequestLogEntries(), ...)`를 그대로 JSON 응답한다.
- `src/server/request-log.ts:95-125`: request log의 JSONL 투영 지점. WP2는 이 경로를 수정하지 않는다.

## 2. 계산 위치 결정: `/api/logs` 응답 파생

### 비교

| 안 | 장점 | 문제 | 결정 |
| --- | --- | --- | --- |
| GUI에서 `src/usage/cost.ts` 직접 import | 브라우저에서 즉시 계산, API shape 변화 없음 | GUI는 별도 Vite root/package다. `gui/vite.config.ts:11-25`에 parent source alias와 `server.fs.allow`가 없고 `gui/tsconfig.app.json:24` include도 `src`뿐이다. cost metadata와 서버 타입을 브라우저 번들에 결합하고 Vite dev boundary 변경이 필요하다. 실제 외부 import build는 현재 GUI dependencies 미설치로 **미확인**이다. | 기각 |
| `/api/logs`가 응답 직전에 파생 | WP1 코어를 서버에서 한 번만 재사용. GUI는 JSON 계약만 소비. request log와 JSONL 불변 | API에 additive JSON field가 생기며 매 refresh마다 최대 200행을 계산 | **채택** |

채택안은 “표시 시점 계산, 스냅샷 저장 없음” 정책과 일치한다. 계산 결과를 `RequestLogEntry`에 mutate하지 말고 map으로 새 DTO를 만든다. `addRequestLog`, `PersistedUsageEntry`, `usage.jsonl`에는 `displayMetrics`가 절대 들어가면 안 된다.

## 3. `/api/logs` 파생 DTO diff

### `src/server/management-api.ts` — MODIFY

before (`:49`, `:313-315`):

```ts
import { filterRequestLogs, getRequestLogEntries } from "./request-log";

if (url.pathname === "/api/logs" && req.method === "GET") {
  return jsonResponse(filterRequestLogs(getRequestLogEntries(), url.searchParams));
}
```

after:

```ts
import {
  estimateComboCost,
  estimateRequestCost,
  normalizeCostTokens,
  tokensPerSecond,
} from "../usage/cost";
import { filterRequestLogs, getRequestLogEntries, type RequestLogEntry } from "./request-log";

function tokPerSecondResult(entry: Pick<RequestLogEntry, "durationMs" | "usageStatus" | "usage">) {
  if (!entry.usage) return { kind: "unavailable" as const, reason: "usage_missing" as const };
  if (entry.usageStatus === "unsupported") return { kind: "unavailable" as const, reason: "usage_unsupported" as const };
  const value = tokensPerSecond(entry.usage.outputTokens, entry.durationMs);
  if (value === null) {
    return {
      kind: "unavailable" as const,
      reason: entry.usage.outputTokens <= 0 ? "output_missing" as const : "invalid_duration" as const,
    };
  }
  return { kind: "value" as const, value, estimated: entry.usageStatus === "estimated" || entry.usage.estimated === true };
}

function unavailableCostReason(entry: Pick<RequestLogEntry, "provider" | "model" | "usageStatus" | "usage" | "attempts">) {
  // 감사 blocker #2 fold: normalizeCostTokens() 성공 여부를 먼저 확정한다 —
  // landed normalizer는 canonical 실패 후 legacy retry로 복원하므로 raw read+write>input
  // 선검사는 복원 가능한 행을 오분류한다. combo는 attempt 단위로 같은 로직을 적용한
  // 뒤에도 실패 사유를 특정할 수 없으면 combo_attempt_unavailable로 뭉뚱그린다.
  if (!entry.usage && !entry.attempts?.length) return "usage_missing" as const;
  if (entry.usageStatus === "unsupported") return "usage_unsupported" as const;
  if (entry.attempts?.length) return "combo_attempt_unavailable" as const;
  if (!entry.usage) return "usage_missing" as const;
  if (!normalizeCostTokens(entry.usage)) {
    // normalizer가 null이면: 비유한/음수 값(invalid_usage) 또는 양쪽 해석 모두 모순
    // (invalid_cache_breakdown). normalizer가 실제 소비하는 effective 필드 전부의
    // 비음수 유한성으로 구분한다(재감사 blocker: optional cache 필드 NaN/음수 포함).
    const effectiveRead = entry.usage.cacheReadInputTokens ?? entry.usage.cachedInputTokens ?? 0;
    const effectiveWrite = entry.usage.cacheCreationInputTokens ?? 0;
    const finite = [entry.usage.inputTokens, entry.usage.outputTokens, effectiveRead, effectiveWrite]
      .every(v => Number.isFinite(v) && v >= 0);
    return finite ? "invalid_cache_breakdown" as const : "invalid_usage" as const;
  }
  return "price_unmatched" as const;
}

function costResult(entry: Pick<RequestLogEntry, "provider" | "model" | "usageStatus" | "usage" | "attempts">) {
  // 감사 blocker #1 fold — landed API 직결: combo는 estimateComboCost, 그 외 estimateRequestCost.
  const estimate = entry.attempts?.length
    ? estimateComboCost(entry.attempts)
    : estimateRequestCost({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus });
  if (!estimate) return { kind: "unavailable" as const, reason: unavailableCostReason(entry) };
  const estimateReasons = [
    entry.usageStatus === "estimated" || entry.usage?.estimated ? "usage_estimated" as const : undefined,
    entry.usage && entry.usage.cachedInputTokens === undefined
      && entry.usage.cacheReadInputTokens === undefined
      && entry.usage.cacheCreationInputTokens === undefined ? "cache_detail_missing" as const : undefined,
    estimate.price?.source === "expected" || estimate.attempts?.some(a => a.price.source === "expected")
      ? "expected_price_overlay" as const : undefined,
  ].filter((reason): reason is NonNullable<typeof reason> => reason !== undefined);
  return { kind: "value" as const, estimate, estimateReasons };
}

function displayMetricsForLog(entry: RequestLogEntry) {
  return {
    tokPerSecond: tokPerSecondResult(entry),
    cost: costResult(entry),
  };
}

function logDto(entry: RequestLogEntry) {
  return {
    ...entry,
    displayMetrics: displayMetricsForLog(entry),
    ...(entry.attempts?.length
      ? {
          attempts: entry.attempts.map(attempt => ({
            ...attempt,
            displayMetrics: {
              tokPerSecond: tokPerSecondResult(attempt),
              cost: costResult(attempt),
            },
          })),
        }
      : {}),
  };
}

if (url.pathname === "/api/logs" && req.method === "GET") {
  const logs = filterRequestLogs(getRequestLogEntries(), url.searchParams);
  return jsonResponse(logs.map(logDto));
}
```

top-level combo에는 원본 `attempts`가 전달되어야 하고, attempt DTO에는 개별 attempt 결과가 붙어야 030이 재계산 없이 소테이블을 렌더할 수 있다. 실제 구현에서는 위 local helper의 반환 타입을 export하지 말고 module-local explicit type으로 고정한다. `CostEstimate`의 field를 재명명하지 않고 API DTO의 `estimate` 아래 그대로 둔다.

### `tests/management-api-logs-metrics.test.ts` — NEW

테스트는 `handleManagementAPI` + request-log test reset을 사용해 다음을 고정한다.

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import { addRequestLog, clearRequestLogsForTests } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";

const config = {} as OcxConfig;

afterEach(() => clearRequestLogsForTests());

async function readLogs() {
  const url = new URL("http://localhost/api/logs");
  const response = await handleManagementAPI(new Request(url), url, config);
  expect(response?.status).toBe(200);
  return await response!.json() as Array<Record<string, any>>;
}

describe("GET /api/logs display metrics", () => {
  test("adds tok/s and cost without mutating the stored log", async () => {
    // fixture model은 WP1 exact-match fixture와 같은 verified-priced key를 사용한다.
    // outputTokens=240, durationMs=2000 => 120 tok/s를 고정한다.
  });

  test("estimated positive output marks tok/s estimated and keeps cost estimated", async () => {
    // usageStatus=estimated; tokPerSecond.kind=value/estimated=true; cost.kind=value.
  });

  test("unmatched price is unavailable instead of zero", async () => {
    // cost === { kind:"unavailable", reason:"price_unmatched" }.
  });

  test("enriches combo attempts and fails top-level cost closed", async () => {
    // attempts 각각 displayMetrics가 있고 한 attempt 미매칭이면 top-level combo cost 불가.
  });
});
```

테스트에서 `any`를 쓰지 말고 최종 010 export DTO 타입을 import해 구체화한다. 위 블록의 `any`는 test skeleton에서만 shape 위치를 설명하기 위한 표기다. 저장 원본 확인은 `getRequestLogEntries()[0]`에 `displayMetrics`가 없음을 `Object.hasOwn`으로 검증한다.

## 4. GUI 타입과 formatter diff

### `gui/src/pages/Logs.tsx` — MODIFY (타입)

`UsageBreakdown`에 현재 빠진 서버 값도 함께 정렬한다.

before (`:10-18`, `:22-43`):

```ts
interface UsageBreakdown { /* token fields */ }
interface LogEntry { /* ... */ totalTokens?: number; }
```

after:

```ts
type MetricUnavailableReason =
  | "usage_missing" | "usage_unsupported" | "output_missing" | "invalid_duration"
  | "price_unmatched" | "invalid_cache_breakdown"
  | "invalid_usage" | "combo_attempt_unavailable";

type TokPerSecondResult =
  | { kind: "value"; value: number; estimated: boolean }
  | { kind: "unavailable"; reason: MetricUnavailableReason };

type CostResult =
  | {
      kind: "value";
      estimate: {
        cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
        estimated: boolean;
        price?: { provider: string; modelId: string; jawcodeProvider?: string; source: "jawcode" | "expected"; status: "verified" | "verified-derived" };
        attempts?: Array<{ ordinal: number; price: { provider: string; modelId: string; jawcodeProvider?: string; source: "jawcode" | "expected"; status: "verified" | "verified-derived" } }>;
      };
      estimateReasons: Array<"usage_estimated" | "cache_detail_missing" | "expected_price_overlay">;
    }
  | {
      kind: "unavailable";
      reason: MetricUnavailableReason;
    };

interface LogDisplayMetrics {
  tokPerSecond: TokPerSecondResult;
  cost: CostResult;
}

interface LogEntry {
  // existing fields unchanged
  displayMetrics?: LogDisplayMetrics; // optional for rolling upgrade/older server
}
```

020에서는 `attempts` 타입을 아직 추가하지 않는다. 서버가 additive attempt metrics를 보내도 JS가 무시하며, 030이 정확한 `LogAttempt[]` 계약을 추가한다.

formatter는 `speedLabel()` 아래에 둔다.

```ts
function formatTokPerSecond(result: TokPerSecondResult | undefined, locale: string): string {
  if (!result || result.kind === "unavailable" || !Number.isFinite(result.value) || result.value <= 0) return "—";
  const digits = result.value >= 100 ? 0 : 1;
  const value = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(result.value);
  return `${result.estimated ? "~" : ""}${value}`;
}

function formatEstimatedUsd(result: CostResult | undefined, locale: string): string {
  if (!result || result.kind === "unavailable" || !Number.isFinite(result.estimate.cost.total) || result.estimate.cost.total < 0) return "—";
  const totalUsd = result.estimate.cost.total;
  const fractionDigits = totalUsd >= 1 ? 2 : totalUsd >= 0.01 ? 4 : 6;
  return `~$${new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(totalUsd)}`;
}
```

정책:

- tok/s 공식은 WP1 helper가 `outputTokens / (durationMs / 1000)`로 계산한다. TTFT를 빼지 않는다.
- `outputTokens <= 0`, usage 부재, unreported/unsupported, duration <= 0은 `—`다.
- `usageStatus=estimated`이면서 output > 0이면 `~12.3`; reported면 `12.3`이다. 100 이상은 정수, 100 미만은 소수 1자리다.
- 비용은 성공한 `CostResult`라면 source와 무관하게 항상 `~$` 접두다. verified expected 정가도 `~$`; 미매칭/unverified expected만 `—`다.
- monetary formatting은 locale grouping/decimal separator를 쓰되 currency symbol은 정책상 ASCII `$`를 앞에 고정한다.

## 5. 10열 table diff

배치는 다음으로 확정한다.

```text
time | tokens | tok/s | ~$ | model | effort | provider | status | request | duration
```

tokens 바로 뒤에 두 파생 수치를 묶으면 토큰량→속도→추정비용을 한 번에 스캔할 수 있고, duration은 기존 마지막 열을 유지한다. 두 열 모두 `num mono` 정렬을 쓴다.

before (`gui/src/pages/Logs.tsx:195-202`):

```tsx
<th>{t("logs.col.time")}</th>
<th className="num log-col-tokens">{t("logs.col.tokens")}</th>
<th className="log-col-model">{t("logs.col.model")}</th>
```

after:

```tsx
<table className="tbl logs-table">
  {/* ... */}
  <th>{t("logs.col.time")}</th>
  <th className="num log-col-tokens">{t("logs.col.tokens")}</th>
  <th className="num log-col-rate" title={t("logs.metric.tokPerSecTitle")}>{t("logs.col.tokPerSec")}</th>
  <th className="num log-col-cost" title={t("logs.metric.estimatedCostTitle")}>{t("logs.col.estimatedCost")}</th>
  <th className="log-col-model">{t("logs.col.model")}</th>
```

row의 tokens `</td>` 뒤:

```tsx
<td className="num mono log-col-rate">
  {formatTokPerSecond(log.displayMetrics?.tokPerSecond, localeTag ?? locale)}
</td>
<td className="num mono log-col-cost">
  {formatEstimatedUsd(log.displayMetrics?.cost, localeTag ?? locale)}
</td>
```

virtual padding 두 곳은 반드시 함께 수정한다.

```diff
- <td colSpan={8} ... />
+ <td colSpan={10} ... />
```

### `gui/src/styles.css` — MODIFY

기존 Logs 전용 블록(`:694-714`)에 최소 규칙만 추가한다.

```css
table.logs-table { min-width: 960px; }
.log-col-rate { min-width: 7ch; white-space: nowrap; }
.log-col-cost { min-width: 10ch; white-space: nowrap; }
```

10열을 760px 아래에서 억지로 압축하지 않는다. `.tbl-wrap`의 기존 horizontal scroll을 사용하고, 960px 최소 폭으로 model/request가 한 글자씩 찢어지는 것을 막는다. 새 셀은 한 줄이라 virtual row의 44px 기준을 늘리지 않는다. 390px/320px에서는 좌우 스크롤이 생기는 것이 의도된 동작이다.

## 6. i18n 4 locale diff

`logs.col.tokens` 직후에 같은 순서로 4개 키를 추가한다.

| key | en | ko | zh | de |
| --- | --- | --- | --- | --- |
| `logs.col.tokPerSec` | `tok/s` | `tok/s` | `tok/s` | `tok/s` |
| `logs.col.estimatedCost` | `~$` | `~$` | `~$` | `~$` |
| `logs.metric.tokPerSecTitle` | `Output tokens per second over the full request duration` | `전체 요청 시간 기준 초당 출력 토큰` | `按完整请求耗时计算的每秒输出 token` | `Ausgabe-Tokens pro Sekunde über die gesamte Anfragedauer` |
| `logs.metric.estimatedCostTitle` | `Estimated cost; unmatched pricing is unavailable` | `추정 비용이며 가격 미매칭은 표시하지 않음` | `预估费用；价格未匹配时不显示` | `Geschätzte Kosten; bei fehlendem Preisabgleich nicht verfügbar` |

`tok/s`, `~$`, `—`, 모델 ID는 기술 표기이므로 본문 데이터에 추가 번역 키를 만들지 않는다. `en.ts`의 새 key가 `TKey`를 확장하므로 ko/zh/de 중 하나라도 빠지면 compile/lint 실패해야 한다.

## 7. close gate

### 정적/계약 검증

워크트리 루트에서 순서대로 실행한다.

```bash
bun run typecheck
bun test --isolate tests/usage-cost* tests/management-api-logs-metrics.test.ts
(cd gui && bun run lint:i18n)
(cd gui && bun run build)
```

모두 exit 0이어야 한다. 추가로 `tests/management-api-logs-metrics.test.ts`에서 다음 JSON 계약을 assert한다.

1. 성공: `displayMetrics.tokPerSecond={kind:"value",value:120,estimated:false}`, 비용 `kind:"value"`.
2. estimated: 양수 output이면 tok/s `estimated:true`, 비용 숫자는 유지하고 UI가 `~`/`~$`를 붙인다.
3. 미매칭: `cost={kind:"unavailable",reason:"price_unmatched"}`이며 `$0`이 아니다.
4. 저장 원본: `getRequestLogEntries()`와 usage JSONL projection에 `displayMetrics`가 없다.

### 렌더 그라운딩 스크린샷

1. `/api/logs`에 success/estimated/unmatched 세 행이 동시에 보이도록 실제 요청을 만들거나, `handleManagementAPI` test fixture와 동일한 JSON을 반환하는 임시 local mock을 사용한다. fixture의 필수 기대값:
   - success: 240 output / 2000ms, matched cost → `120`, `~$...`
   - estimated: 25 output / 2000ms → `~12.5`, `~$...`
   - unmatched: positive output, unknown provider/model → tok/s 숫자, 비용 `—`
2. `OPENCODEX_PROXY_TARGET=http://127.0.0.1:<mock-port> bun run dev:gui`로 GUI를 띄운다. mock은 파일을 저장하지 않는 `bun -e 'Bun.serve(...)'` one-shot을 사용해도 된다.
3. native browser QA 도구로 Logs를 열고 1440×1000, 1024×768, 390×844, 320×700을 캡처한다.
4. 각 캡처에서 열 순서, 숫자 우측 정렬, estimated 접두, 미매칭 `—`, sticky header, horizontal scroll을 확인한다. 390/320에서 model/request 글자가 세로 한 글자 단위로 찢어지면 실패다.
5. 결과 경로를 구현 devlog에 아래 형식으로 기록한다.

```text
desktop-success-estimated-unmatched (1440): <path>
split-screen (1024): <path>
mobile-horizontal-scroll (390): <path>
narrow-horizontal-scroll (320): <path>
```

### WP2 close 판정

- [ ] diff 대상은 위 8파일뿐이며 `src/usage/cost.ts`, generated metadata, request-log/usage JSONL은 WP2에서 수정하지 않았다.
- [ ] table은 정확히 10열이고 두 padding `colSpan` 모두 10이다.
- [ ] 비용 숫자는 전부 `~$`; 미매칭/unverified는 `—`다.
- [ ] tok/s는 전체 duration 기준이고 estimated에만 `~`가 붙는다.
- [ ] 4 locale key parity, root typecheck, cost/API tests, GUI build가 exit 0이다.
- [ ] success/estimated/unmatched와 좁은 viewport 스크린샷이 실제 렌더를 증명한다.
