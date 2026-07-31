# 001 — 비용 회계 발산 실측

오라클은 `src/usage/*`, 대상은 `go/internal/usage/*`. 기준 커밋 `bb5aa976e`.
모든 주장에 `path:line`을 붙였다. 시나리오는 실제 숫자로 적었다.

## 측정 방법

카탈로그 크기:

```bash
bun -e '
const m = await import("./src/generated/jawcode-model-metadata.ts");
const src = await Bun.file("src/generated/jawcode-model-metadata.ts").text();
const providers = [...src.matchAll(/^  "([a-z0-9-]+)": \[/gm)].map(x=>x[1]);
let total=0, priced=0;
for (const p of providers) for (const r of m.listJawcodeModelMetadata(p)) {
  total++; if (r.cost && (r.cost.input||r.cost.output||r.cost.cacheRead||r.cost.cacheWrite)) priced++;
}
console.log(providers.length, total, priced);
'
# → provider bundles: 15 | jawcode rows: 724 | nonzero-priced rows: 652
```

Go 번들 부재:

```bash
find go -name '*jawcode*'   # 출력 없음
```

## G1 — jawcode 카탈로그 전체가 Go에서 가격을 못 낸다 (최상위)

TS 해석 우선순위는 주석에 명시돼 있다: jawcode 0 아님 → 오버레이 verified →
오버레이 verified-derived → jawcode 모델 단위 벤더 폴백 → null
(`src/usage/cost.ts:139-145`). 진입점은 `resolveMatchedPrice`(`src/usage/cost.ts:146`)이고
실제 조회는 `resolveMatchedPriceExact`(`src/usage/cost.ts:186`)에서
`resolveJawcodeProvider` → `getJawcodeModelMetadata` 순으로 일어난다
(`src/usage/cost.ts:190-193`).

Go는 `FindPrice`(`go/internal/usage/prices.go:101`)가 전부이고, 이 함수는 인자로 받은
오버레이 슬라이스만 순회한다(`prices.go:103-120`). 기본값은 48행
`ExpectedPriceOverlays`(`prices.go:50-99`).

**시나리오**: `openai` / `gpt-5.6-sol`, usage `{inputTokens: 1000000, outputTokens: 0}`, 표준 티어.

- TS: jawcode openai 번들에 `gpt-5.6-sol` 행이 있고 입력가 `5`.
  `calculateCost`가 `5 * 1000000 / 1e6`을 계산해 **`$5.00`**(`src/usage/cost.ts:131-136`).
- Go: 오버레이에 openai 행이 없다(`prices.go:50-99`). `FindPrice`는 `false`를 반환하고
  `EstimateCostWithTier`가 즉시 실패한다(`go/internal/usage/cost.go:101-104`). **가격 없음**.

영향: `/api/usage`의 `estimatedCostUsd`, `/api/logs`의 `displayMetrics.cost`가
카탈로그로 가격이 매겨지는 모델 전부에서 `price_unmatched`가 된다.

## G2 — 크로스 프로바이더 벤더 폴백 부재

TS는 오버레이까지 실패하면 모델 ID만으로 벤더 우선순위 번들을 훑는다:
`findJawcodeCostByModelId(modelId)`, 실패 시 점을 대시로 바꿔 한 번 더
(`src/usage/cost.ts:221-226`). 결과는 요청 프로바이더를 유지한 채
`source: "jawcode"`, `status: "verified-derived"`로 반환된다(`src/usage/cost.ts:228-235`).
정책 근거는 "모델은 서빙 프로바이더와 무관하게 공식 벤더 가격을 따른다"
(`src/generated/jawcode-model-metadata.ts:76-78`).

Go에는 대응이 없다. 오버레이 실패 시 그냥 `PriceOverlay{}, false`(`prices.go:117-119`).

**시나리오**: `kiro` / `claude-opus-4.6`, 1M 입력.
TS는 점→대시 재시도로 anthropic 번들의 `claude-opus-4-6`(입력가 `5`)를 찾아 **`$5.00`**.
Go는 가격 없음.

## G3 — base provider 정규화가 usage 패키지에서만 다르다

이건 특히 아깝다. **Go에 이미 정확한 포트가 있는데 usage가 안 쓴다.**

`providers.BaseProviderLabel`(`go/internal/providers/label.go:16`)은 TS
`baseProviderLabel`(`src/providers/label.ts:7`)의 충실한 포트다: `chatgpt`/`openai-multi`를
`openai`로 접고, `-main` 접미사와 `^p[a-f0-9]{6}$` 계정 라벨을 벗긴다
(`label.go:8`, `label.go:21-28` 대 `label.ts:2-4`, `label.ts:10-18`).

그런데 usage 패키지는 자체 `BaseProvider`(`go/internal/usage/cost.go:160`)를 쓴다.
이쪽은 `google-antigravity`, `openai`, `cursor`, `kimi` 네 접두어만 하드코딩하고
`prefix+"-p"`로 시작하는지만 본다(`cost.go:161-166`). 호출처는 10곳이다
(`cost.go:106`, `prices.go:102`, `summary.go:256,305,357,422,462,467,481`).

**시나리오**: `kimi-code-pabcdef` / `k3`, 1M 입력.
TS는 접미사 `pabcdef`가 계정 라벨 정규식에 걸려 `kimi-code`로 접히고,
오버레이 `{kimi-code, k3}`(입력가 `3`)에 매치돼 **`$3.00`**.
Go의 `BaseProvider`는 `kimi-p...`만 보므로 `kimi-code-pabcdef` 그대로 조회 → 가격 없음.

부수 영향: 요약 행이 프로바이더별로 쪼개진다(`summary.go:256,305,357`).

## G4 — 토큰 정규화의 zero-vs-null 발산

TS는 nullish 병합만 쓴다: `cacheReadInputTokens ?? cachedInputTokens ?? 0`
(`src/usage/cost.ts:109-110`). 즉 **명시적 `0`은 권위 있는 값**이다.
레거시 재시도는 `cacheReadInputTokens`가 number가 아닐 때만 후보에 추가된다
(`src/usage/cost.ts:112-116`).

Go는 0을 미지정으로 취급한다: `if read == 0 { read = value.CachedInputTokens }`
(`go/internal/usage/cost.go:57-61`).

**시나리오 A**: `deepseek`/`deepseek-chat`,
usage `{input: 100, output: 0, cacheRead: 0, cached: 50, cacheCreation: 0}`.
deepseek 오버레이는 입력 `0.27`, 캐시읽기 `0.07`(`prices.go:56`, `expected-prices.ts:73`).

- TS 토큰 `{input: 100, cacheRead: 0}` → `100*0.27/1e6` = **`$0.000027`**
- Go 토큰 `{Input: 50, CacheRead: 50}` → `(50*0.27 + 50*0.07)/1e6` = **`$0.000017`**

**시나리오 B**: 같은 모델, `{input: 100, cacheRead: 0, cached: 100, cacheCreation: 20}`.
TS `{input: 80, cacheWrite: 20}` → **`$0.0000216`**.
Go는 첫 후보 100이 무효라 재시도 80을 채택해 `{Input: 0, CacheRead: 80, CacheWrite: 20}`
→ **`$0.0000056`**.

## G5 — 요약 캐시 토큰이 같은 버그를 상속

`go/internal/usage/summary.go:182-187`이 cost.go와 동일한 zero 폴백을 한다
(직접 확인: `read := u.CacheReadInputTokens; if read == 0 && u.CachedInputTokens > 0 {...}`).
TS는 `cacheReadInputTokens`가 number 타입이면 `0`이어도 그대로 쓴다
(`src/usage/summary.ts:250-260`).

결과: 명시적 0 행에서 Go의 `/api/usage` `cachedInputTokens`/`cacheReadInputTokens`가 부풀려진다.
G4와 함께 고쳐야 한다 — 같은 뿌리다.

## G6 — `price.source` 의미 충돌로 estimateReason이 죽는다

TS `MatchedPrice`는 `source`(`"jawcode" | "expected"`)와 `sourceRef`(출처 URL)를
분리한다(`src/usage/cost.ts:45-53`). 오버레이 경로는 `source: "expected"`,
`sourceRef: overlay.source`를 채운다(`src/usage/cost.ts:209-218`).

Go `PriceOverlay`는 `Source` 하나뿐이고 거기에 **URL을 넣는다**
(`prices.go:17-23`, 실제 행은 `prices.go:51-98`).

그래서 `go/internal/server/request_log_port.go:311-313`의
`estimate.Price.Source == "expected"` 비교는 **영원히 거짓**이다.
`expected_price_overlay` reason이 절대 붙지 않는다. TS는 붙인다
(`src/server/management/shared.ts:132-140`).

조건부 경로가 구조적으로 도달 불가능한 사례다 — C-ACTIVATION-GROUNDING-01이 잡으라는 바로 그 모양.

## G7 — 콤보 요청의 상위 비용이 attempt에서 집계되지 않는다

TS는 attempts가 있으면 콤보 집계를 쓴다:
`entry.attempts?.length ? estimateComboCost(...) : estimateRequestCost(...)`
(`src/server/management/shared.ts:126-131`).

Go의 `displayMetricsFor`는 provider/model/usage만 받아 단일 추정을 한다
(`request_log_port.go:302-314`). 콤보 행의 상위 provider는 보통 오버레이에 없다.

**시나리오**: 콤보 행, attempt 1 `deepseek/deepseek-chat` 1M 입력, attempt 2 `kimi/k3` 1M 입력.
TS 상위 비용 **`$3.27`**. Go는 `FindPrice("combo","fallback")` 실패 → `price_unmatched`.
attempt 각각은 가격을 낼 수 있는데도 그렇다.

## G8 — attempt별 displayMetrics 필드 자체가 없다

TS는 모든 attempt에 자기 `displayMetrics.cost`를 붙인다
(`src/server/management/shared.ts:150-157`). Go의 `RequestAttemptLog`는
`ErrorCode`까지만 있고 해당 필드가 없다(`request_log_port.go:411-427`).
응답 스키마 차이라 GUI가 attempt별 비용 분해를 못 그린다.

## G9 — priorityMultiplier JSON 노이즈

TS는 배수가 1이면 필드를 아예 뺀다(조건부 스프레드, `src/usage/cost.ts:367-373`).
Go는 `PriorityMultiplier: multiplier`를 항상 넣고(`cost.go:117-118`),
`omitempty`는 float 0만 생략하므로 `1`은 살아남는다(`cost.go:27`).
→ 가격이 매겨진 모든 비우선순위 요청에서 응답 모양이 다르다.

게이팅 조건도 G3의 `BaseProvider`를 쓰므로(`cost.go:105-109`) `chatgpt`/`openai-multi`
별칭이 TS와 달리 우선순위 배수를 못 받는다.

## G10 — `range=all` 일 수 계산

TS `Math.ceil((now - oldest) / DAY_MS) + 1`(`src/usage/summary.ts:119-123`) 대
Go `int(now.Sub(...).Hours()/24) + 1`(`summary.go:286-297`).
1ms 전 항목 하나면 TS는 2칸, Go는 1칸. `/api/usage.days` 길이가 달라진다.

## G11 — 토큰 추정의 유니코드 단위

TS는 UTF-16 코드유닛 길이(`src/lib/token-estimate.ts:62-68`), Go는 룬 개수
(`go/internal/lib/token_estimate.go:28-43`). 이모지 5개면 TS `ceil(10/4)=3`,
Go `ceil(5/4)=2`. 비용 이전 단계의 추정 usage가 갈린다.

## 반증된 의심

감사에서 틀린 것으로 확인된 것들도 기록해 둔다. 나중에 같은 의심을 반복하지 않기 위해서다.

- **antigravity 정규화는 이미 있다.** `providers.CanonicalAntigravityUsageModel`
  (`go/internal/providers/antigravity_models.go:61`)이 존재하고 summary가
  `canonicalUsageModel`을 통해 부른다(`summary.go:421-424`). 현재 antigravity 가격 행도
  오버레이에 다 있다(`prices.go:59-76`).
- **우선순위 배수 테이블 키는 정확히 일치한다.** TS `expected-prices.ts:152-158` 대
  Go `cost.go:31-34`. 문제는 테이블이 아니라 게이팅(G9)이다.
- **콤보 fail-closed 코어는 이식돼 있다.** TS는 null(`cost.ts:320-325`),
  Go는 false(`cost.go:121-132`). 의미가 같다. 문제는 라우트 배선(G7)이다.
- **48행 오버레이 로스터 자체는 정확히 미러링돼 있다.** `expected-prices.ts:61-129` 대
  `prices.go:50-99`.

## 우선순위

사용자에게 닿는 정도 순: G1 > G3 > G4/G5 > G7 > G2 > G6 > G8 > G9 > G10 > G11.
다만 구현 순서는 의존 순이다(`000` work-phase 지도) — G1의 번들이 없으면 G2를 만들 수 없다.
