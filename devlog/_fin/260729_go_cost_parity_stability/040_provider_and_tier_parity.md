# 040 — work-phase 4: base provider 정규화 일원화와 우선순위 티어 게이팅

근거: `001` G3·G9.

## 문제

**Go에 이미 정확한 포트가 있는데 usage 패키지가 안 쓴다.**

`providers.BaseProviderLabel`(`go/internal/providers/label.go:16`)은 TS
`baseProviderLabel`(`src/providers/label.ts:7`)의 충실한 이식이다. `chatgpt`/`openai-multi`를
`openai`로 접고, `-main`과 `^p[a-f0-9]{6}$` 계정 라벨을 벗긴다.

그런데 usage는 자체 `BaseProvider`(`go/internal/usage/cost.go:160`)를 쓴다:

```go
func BaseProvider(provider string) string {
	// Account pool suffixes are diagnostic identity, not a pricing namespace.
	for _, prefix := range []string{"google-antigravity", "openai", "cursor", "kimi"} {
		if provider == prefix || strings.HasPrefix(provider, prefix+"-p") {
			return prefix
		}
	}
	return provider
}
```

네 접두어 하드코딩이고 `prefix+"-p"` 접두 검사만 한다. 호출처가 10곳이다:
`cost.go:106`, `prices.go:102`, `summary.go:256,305,357,422,462,467,481`.

발산 예: `kimi-code-pabcdef`/`k3`는 TS에서 `kimi-code`로 접혀 오버레이 `{kimi-code, k3}`에
매치돼 `$3.00`이 나오지만, Go는 접두어 목록에 `kimi-code`가 없어 원문 그대로 조회 →
가격 없음. 요약 행도 프로바이더별로 쪼개진다.

## 파일 변경 지도

| 파일 | 종류 | 위치 |
| --- | --- | --- |
| `go/internal/usage/cost.go` | MODIFY | `BaseProvider` 삭제(160-168), 호출부 위임, 티어 게이팅(105-118) |
| `go/internal/usage/summary.go` | MODIFY | `BaseProvider` 호출 7곳 위임 |
| `go/internal/usage/prices.go` | MODIFY | `FindPrice`의 정규화 호출 |
| `go/internal/usage/provider_parity_test.go` | NEW | 정규화·티어 회귀 |

## 변경 1 — 정규화 위임

before (`go/internal/usage/cost.go:160-168`): 위 인용.

after:

```go
// BaseProvider delegates to the single canonical implementation
// (providers.BaseProviderLabel, an exact port of src/providers/label.ts:7-19).
// The previous four-prefix hardcoded list silently failed for pooled providers
// like kimi-code-pabcdef, which then lost their price entirely.
func BaseProvider(provider string) string {
	return providers.BaseProviderLabel(provider)
}
```

함수를 지우지 않고 위임으로 남기는 이유: 호출처 10곳을 전부 고치는 것보다 변경면이 작고,
`usage.BaseProvider`라는 이름이 패키지 안에서 의미가 있다. 다만 **구현은 하나**가 된다.

주의: 기존 구현은 `google-antigravity-p442fff`를 `google-antigravity`로 접었다.
`BaseProviderLabel`도 `p442fff`가 `^p[a-f0-9]{6}$`에 걸리므로 같은 결과다. 확인 테스트를 넣는다.
반대로 `openai-p12`처럼 6자리가 아닌 접미사는 기존 구현이 접고 새 구현은 안 접는다 —
**의도된 변경**이다. TS가 안 접기 때문이다. 이 차이를 테스트로 고정한다.

## 변경 2 — 티어 게이팅 (G9)

before (`go/internal/usage/cost.go:105-118`):

```go
	multiplier := 1.0
	base := BaseProvider(provider)
	if serviceTier == "priority" && (base == "openai" || base == "openai-apikey") {
		multiplier = PriorityMultiplier(model)
	}
	...
	return CostEstimate{... PriorityMultiplier: multiplier, ...}, true
```

after:

```go
	multiplier := 1.0
	if serviceTier == "priority" && openAITierProviders[BaseProvider(provider)] {
		multiplier = PriorityMultiplier(model)
	}
	...
	estimate := CostEstimate{Tokens: tokens, Cost: CalculateCost(tokens, effectivePrice),
		Price: price, Estimated: ...}
	// TS omits the field entirely when the multiplier is 1
	// (src/usage/cost.ts:367-373); Go's omitempty only drops zero, so a plain
	// `1` would leak into every priced response and change the shape.
	if multiplier != 1 {
		estimate.PriorityMultiplier = multiplier
	}
	return estimate, true
```

`openAITierProviders`는 TS `OPENAI_TIER_PROVIDER_IDS`(`src/usage/cost.ts:247-252`)를
그대로 옮긴 집합이다. 현재 Go는 `openai`/`openai-apikey` 두 개만 인라인으로 갖고 있어
TS 집합과 대조가 필요하다 — 구현 시 TS를 읽어 정확히 맞춘다.

`EstimateComboCost`의 attempt 조립(`cost.go:144`)도 같은 규칙을 적용한다.

## 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

정규화 분기가 실제로 발화하는지:

| 입력 | 기대 | 발화하는 분기 |
| --- | --- | --- |
| `kimi-code-pabcdef` | `kimi-code`, 가격 `$3.00` | 계정 라벨 정규식 |
| `chatgpt` | `openai` | canonical 별칭 |
| `openai-multi` | `openai` | canonical 별칭 |
| `google-antigravity-p442fff` | `google-antigravity` | 계정 라벨 정규식(기존 동작 보존) |
| `openai-main` | `openai` | `-main` 접미사 |
| `kimi-code` | `kimi-code` (불변) | 접미사 없음 |

`kimi-code-pabcdef` 케이스는 수정 전 **가격 없음**을 반환하므로 테스트가 결함을 재현한다.

티어 게이팅 발화:

- `openai`/`gpt-5.5`/tier=`priority` → `PriorityMultiplier==2.5`이고 JSON에 필드 존재
- `openai`/`gpt-5.5`/tier=`standard` → JSON에 `priorityMultiplier` 키 **부재**
  (마셜 후 `map[string]any`로 되읽어 키 존재 여부를 단언 — 값이 1인지가 아니라 키가 없는지)
- `chatgpt`/`gpt-5.5`/tier=`priority` → 배수 적용(수정 전에는 미적용, 결함 재현)

## 테스트

`go/internal/usage/provider_parity_test.go`:

- `TestBaseProviderMatchesOracleTable` — 위 6행 표
- `TestPooledProviderKeepsPrice` — `kimi-code-pabcdef` → `$3.00`
- `TestPriorityMultiplierOmittedWhenOne` — 키 부재 단언
- `TestPriorityGatingCoversChatgptAlias`

```bash
cd go && go test ./internal/usage/... -count=1 -v
cd go && go build ./... && go vet ./... && go test ./... -count=1
```

## 위험

- **요약 그룹핑이 바뀐다.** `summary.go`의 7개 호출처가 다르게 접히면 기존 요약 테스트가
  깨질 수 있다. 깨진 기대값이 **틀린 기대값이었는지** 먼저 확인하고, 맞다면 TS 기준으로 갱신한다.
  기존 테스트를 무조건 따라가면 결함을 고정하는 셈이 된다.
- `usage` → `providers` 임포트 순환 확인(`030`과 동일 사안).
- `PriorityMultiplier` 필드가 사라지는 응답을 소비하는 GUI 코드가 있는지 확인:
  `rg -n "priorityMultiplier" gui/src`.

## 완료 기준

정규화 구현이 하나로 합쳐지고, 6행 표가 통과하며, `priorityMultiplier` 키가 배수 1일 때
응답에서 사라지고, 전체 스위트가 초록이다.
