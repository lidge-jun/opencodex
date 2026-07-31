# 030 — work-phase 3: jawcode 우선 가격 해석 체인

근거: `001` G1·G2. `020`이 데이터를 넣었고 이 사이클이 배선한다.

## 문제

Go `FindPrice`(`go/internal/usage/prices.go:101`)는 오버레이 48행만 훑는다.
TS 해석 순서는 4단계인데(`src/usage/cost.ts:139-145`) Go는 2·3단계만 갖고 있다.

| 단계 | TS | 현재 Go |
| --- | --- | --- |
| 1. jawcode 정확 매치(프로바이더 번들) 0 아님 | `cost.ts:190-202` | 없음 |
| 2. 오버레이 verified | `expected-prices.ts:136-143` | `prices.go:105-112` |
| 3. 오버레이 verified-derived | 같은 곳 | `prices.go:113-119` |
| 4. jawcode 모델 단위 벤더 폴백 | `cost.ts:221-235` | 없음 |

## P 재검증: 오라클 실제 순서 (구현 전 정정)

초안 표는 4단계를 "jawcode -> 오버레이 verified -> 오버레이 derived -> 벤더 폴백"으로
적었다. 소스를 직접 읽으니(`src/usage/cost.ts:186-235`) 두 가지가 더 정확하다.

```ts
// src/usage/cost.ts:194  — 1단계: jawcode 정확 매치, 0 아님 + 유효할 때만
if (jawcode?.cost && validCost4(jawcode.cost) && hasNonZeroCost(jawcode.cost)) { ... source:"jawcode", status:"verified" }

// src/usage/cost.ts:205  — 오버레이가 없거나 무효/전부-0이면 폴백으로 "떨어진다"
const overlay = findExpectedPriceOverlay(provider, modelId, overlays);
if (!overlay || !validCost4(overlay.cost4) || !hasNonZeroCost(overlay.cost4)) {
  return resolveModelLevelPrice(provider, modelId);
}

// src/usage/cost.ts:208  — unverified 오버레이는 null. 폴백으로 가지 않는다.
if (overlay.status === "unverified") return null;
```

정정 1: **오버레이 실패는 "다음 단계"가 아니라 벤더 폴백으로 직행이다.** verified와
verified-derived 사이의 우선순위는 `findExpectedPriceOverlay`(`expected-prices.ts:136-143`)
**안에서** 결정되고, 바깥 체인은 그 결과 하나만 본다. Go `FindPrice`(`prices.go:101-120`)도
이미 같은 구조이므로 그 함수는 오버레이 단계 전용으로 그대로 재사용한다.

정정 2 (A 감사로 재정정): `unverified` 처리에 대한 초안 서술이 과장이었다.
`if (overlay.status === "unverified") return null`(`cost.ts:208`)은 **도달 불가능한 방어선**이다.
그 앞의 `findExpectedPriceOverlay`(`expected-prices.ts:141-143`)가 verified와
verified-derived만 골라 반환하므로, unverified 행은 애초에 "없음"으로 취급되어
`cost.ts:205-206`에서 **벤더 폴백으로 간다**. 즉 "폴백조차 타지 않고 null"이 아니다.

Go에 `unverified` 상태를 새로 만들지 않는다(오라클도 "NEVER registered ...
never returned by the resolver", `expected-prices.ts:10-11,133`). 대신 계약을 정확히 적는다:

- `findOverlay`는 `PriceVerified` / `PriceVerifiedDerived` **만** 반환한다.
  `PriceStatus`는 `type PriceStatus string`(`prices.go:10`)이라 호출자가
  `PriceStatus("unverified")`를 만들어 넣을 수 있으므로, 이 필터가 fail-closed의 유일한 보증이다.
- 그렇게 걸러진 뒤의 동작은 **평범한 폴백**이다. 테스트도 그렇게 단언한다 —
  "unverified 주입 시 null"이 아니라 "unverified 주입 시 그 행이 무시되고 폴백 결과가 나온다".

정정 3: 벤더 폴백의 점→대시 재시도는 **점이 있을 때만** 시도한다
(`cost.ts:225-226`: `modelId.includes(".") ? ... : undefined`). 무조건 재시도하면
불필요한 조회가 두 배가 된다.

따라서 실제 체인은 이렇다:

```
resolveExact(provider, model):
  1. jawcode 번들 정확 매치 && 유효 && 0 아님  -> source=jawcode,  status=verified
  2. 오버레이 조회(내부에서 verified > derived) -> 성공 && 유효 && 0 아님 -> source=expected
  3. 그 외(없음/무효/전부-0)                    -> 벤더 폴백(정확, 그다음 점→대시)
                                                 -> source=jawcode, status=verified-derived
  4. 전부 실패                                   -> not found
```

## 파일 변경 지도

| 파일 | 종류 | 위치 |
| --- | --- | --- |
| `go/internal/usage/prices.go` | MODIFY | `PriceOverlay`에 `Source`/`SourceRef` 분리, `FindPrice` 재구성 |
| `go/internal/usage/resolve.go` | NEW | 4단계 해석 체인 + 메모이제이션 |
| `go/internal/usage/resolve_test.go` | NEW | 단계별 우선순위 회귀 |
| `go/internal/server/request_log_port.go` | MODIFY | `Source == "expected"` 비교 복구(G6) |

## 변경 1 — `source` 의미 충돌 해소 (G6)

TS `MatchedPrice`는 두 필드를 분리한다(`src/usage/cost.ts:45-53`):
`source`는 `"jawcode" | "expected"` 판별자, `sourceRef`는 출처 URL.

Go는 `Source` 하나에 URL을 넣는다(`prices.go:17-23`, 행은 `prices.go:51-98`).
그래서 `request_log_port.go:311-313`의 `estimate.Price.Source == "expected"` 비교가
**영원히 거짓**이고 `expected_price_overlay` reason이 절대 안 붙는다.

before (`go/internal/usage/prices.go:17-23`):

```go
type PriceOverlay struct {
	Provider   string      `json:"provider"`
	Model      string      `json:"modelId"`
	Price      Price       `json:"cost4"`
	Source     string      `json:"source,omitempty"`
	VerifiedAt string      `json:"verifiedAt,omitempty"`
	Status     PriceStatus `json:"status"`
}
```

after:

```go
// Source is the discriminator ("jawcode" | "expected") and SourceRef is the
// provenance URL, mirroring src/usage/cost.ts:45-53. Collapsing both into one
// field made request_log_port.go's `Source == "expected"` check unreachable.
type PriceOverlay struct {
	Provider       string      `json:"provider"`
	Model          string      `json:"modelId"`
	JawcodeProvider string     `json:"jawcodeProvider,omitempty"`
	Price          Price       `json:"cost4"`
	Source         string      `json:"source"`
	SourceRef      string      `json:"sourceRef,omitempty"`
	VerifiedAt     string      `json:"verifiedAt,omitempty"`
	Status         PriceStatus `json:"status"`
}
```

로스터 리터럴(`prices.go:51-98`)의 기존 `Source:` 값은 전부 `SourceRef:`로 옮긴다.
`Source`는 해석기가 채운다.

## 정규화 정의는 하나만 산다 (A 감사 blocker 1)

초안은 새 해석기만 `providers.BaseProviderLabel`을 쓰게 했다. 그러면 이 사이클 동안
**두 개의 정규화가 동시에 산다**: 해석기는 새 규칙으로 접고, 티어 배수
(`cost.go:122`)와 요약 그룹핑(`summary.go:305,357`)은 옛 4-접두어 규칙으로 접는다.
`chatgpt`는 가격은 openai로 매겨지는데 티어 배수는 못 받고 요약은 별도 행이 되는,
설명하기 어려운 중간 상태가 된다.

그래서 `usage.BaseProvider`의 **구현만** 이 사이클에서 위임으로 바꾼다:

```go
// go/internal/usage/cost.go — 구현 교체, 심볼과 호출부 10곳은 그대로
func BaseProvider(provider string) string {
	return providers.BaseProviderLabel(provider)
}
```

호출부를 하나도 건드리지 않으므로 변경면은 작고, 해석기·티어·요약이 **같은 규칙**을 쓴다.
`040`은 이 위임을 전제로 나머지(티어 게이팅 집합, priorityMultiplier 생략)를 마무리한다.

이 교체로 요약 그룹핑 결과가 바뀔 수 있다(`kimi-code-pabcdef` 같은 행이 이제 접힌다).
그것이 오라클 동작이므로 기존 기대값이 깨지면 **기대값이 틀렸던 것**이다 — 확인 후 갱신한다.

## 변경 2 — 4단계 체인

새 파일 `go/internal/usage/resolve.go`:

```go
// ResolveMatchedPrice mirrors src/usage/cost.ts:146-236 exactly:
// jawcode exact nonzero -> overlay verified -> overlay verified-derived ->
// jawcode model-level vendor fallback -> not found.
func ResolveMatchedPrice(provider, modelID string, overlays []PriceOverlay) (PriceOverlay, bool) {
	provider = BaseProvider(provider) // single definition; see the note below
	if hit, ok := resolveExact(provider, modelID, overlays); ok {
		return hit, true
	}
	// Antigravity wire ids often lack an exact row; retry on the canonical base
	// model (src/usage/cost.ts:174-180).
	if strings.HasPrefix(provider, "google-antigravity") {
		if base := providers.CanonicalAntigravityUsageModel(modelID); base != modelID {
			return resolveExact(provider, base, overlays)
		}
	}
	return PriceOverlay{}, false
}

func resolveExact(provider, modelID string, overlays []PriceOverlay) (PriceOverlay, bool) {
	// 1. jawcode exact, nonzero only (all-zero rows stay overlay candidates:
	//    zero means "not billable here", not "free" — src/usage/cost.ts:139-145).
	if bundle, ok := jawcode.ResolveProvider(provider); ok {
		if model, ok := jawcode.Metadata(bundle, modelID); ok &&
			model.Cost != nil && validCost(*model.Cost) && hasNonZeroCost(*model.Cost) {
			return PriceOverlay{Provider: provider, Model: modelID,
				JawcodeProvider: bundle, Price: toPrice(*model.Cost),
				Source: "jawcode", Status: PriceVerified}, true
		}
	}
	// 2/3. overlay verified, then verified-derived.
	if hit, ok := findOverlay(provider, modelID, overlays); ok {
		hit.Source = "expected"
		return hit, true
	}
	// 4. cross-provider vendor fallback; a model follows its official vendor
	//    price regardless of who serves it (src/usage/cost.ts:221-235).
	vendor, cost, ok := jawcode.FindCostByModelID(modelID)
	// Retry ONLY when the id actually contains a dot (src/usage/cost.ts:226);
	// an unconditional retry doubles every miss lookup for no benefit.
	if !ok && strings.Contains(modelID, ".") {
		vendor, cost, ok = jawcode.FindCostByModelID(strings.ReplaceAll(modelID, ".", "-"))
	}
	if ok {
		return PriceOverlay{Provider: provider, Model: modelID,
			JawcodeProvider: vendor, Price: toPrice(cost),
			Source: "jawcode", Status: PriceVerifiedDerived}, true
	}
	return PriceOverlay{}, false
}
```

`validCost`/`hasNonZeroCost`는 TS `validCost4`/`hasNonZeroCost`
(`src/usage/cost.ts:78-93`) 이식이다. 현재 Go에는 없다(`001` 미이식 목록).

## 변경 3 — 메모이제이션

TS는 `(provider, model)` 키로 메모하고 512개에서 비운다(`src/usage/cost.ts:174-185`).
이유는 요약이 수십만 행을 순회하기 때문이다(WP6 감사).

Go도 같은 상한으로 `sync.Map` 대신 `sync.RWMutex` + `map`을 쓴다. 512 상한과
전체 비우기 정책까지 동일하게 맞춘다. 기본 오버레이일 때만 메모한다(TS와 동일) —
커스텀 오버레이가 들어오면 캐시 키가 오염된다.

## 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

각 단계가 **실제로 발화하는지** 단계별로 증명한다. 단계 4개 전부에 대해:

| 단계 | 트리거 입력 | 발화 증명 단언 |
| --- | --- | --- |
| 1 jawcode 정확 | `openai`/`gpt-5.6-sol` | `Source=="jawcode"`, `Status==verified`, `Price.Input==5` |
| 2 오버레이 verified | `deepseek`/`deepseek-chat` | `Source=="expected"`, `Status==verified`, `Price.Input==0.27` |
| 3 오버레이 derived | `anthropic`/`claude-opus-5` | `Source=="expected"`, `Status==verified-derived` |
| 4 벤더 폴백 | `kiro`/`claude-opus-4.6` | `Source=="jawcode"`, `Status==verified-derived`, `JawcodeProvider=="anthropic"`, `Price.Input==5` |

단계 4는 점→대시 재시도가 발화해야만 통과한다(`claude-opus-4.6`은 카탈로그에 없고
`claude-opus-4-6`만 있다). 재시도를 빼면 이 테스트가 실패한다 — 분기가 죽지 않았다는 증거.

우선순위 증명(순서가 실제로 지켜지는지): 같은 `(provider, model)`에 jawcode 행과
오버레이 행이 **둘 다** 있는 입력을 골라 jawcode가 이기는지 단언한다.
0 가격 jawcode 행에 대해서는 반대로 오버레이가 이기는지 단언한다(0행 예외).

G6 복구 증명: `/api/logs` DTO를 만들어 `estimateReasons`에 `expected_price_overlay`가
실제로 포함되는지 단언. 수정 전에는 절대 포함되지 않으므로 이 테스트는 결함을 재현한다.

## 테스트

`go/internal/usage/resolve_test.go`:

- `TestResolvePriorityJawcodeBeatsOverlay`
- `TestResolveZeroCostJawcodeFallsToOverlay`
- `TestResolveOverlayVerifiedBeatsDerived`
- `TestResolveVendorFallbackWithDotNormalization`
- `TestResolveAntigravityCanonicalRetry`
- `TestExpectedPriceOverlayReasonAppears` (server 패키지)

```bash
cd go && go test ./internal/usage/... ./internal/server/... -count=1 -v
cd go && go build ./... && go vet ./... && go test ./... -count=1
```

## 위험

- `FindPrice`의 기존 호출자(`cost.go:106`, `prices.go:102`)가 새 체인을 타야 한다.
  `FindPrice`를 얇은 래퍼로 남기고 내부에서 `ResolveMatchedPrice`를 부른다.
- `prices.go`의 48행 리터럴을 전부 손대므로 오타 위험이 있다. 기존
  `tier_cost_test.go`/`cost_test.go`가 회귀를 잡아야 한다 — 먼저 초록인지 확인하고 시작한다.
- `usage` → `jawcode`, `usage` → `providers` 임포트가 새로 생긴다. 순환 임포트가 나면
  `providers`가 `usage`를 참조하는지 먼저 확인한다.

## 완료 기준

4단계가 각각 발화 증거와 함께 통과하고, `expected_price_overlay` reason이 살아나며,
전체 스위트가 초록이다.
