# 065 — work-phase 7: 관리 API 비용 표면 파리티

근거: `001` G7·G8과 소비자 배선 갭 절.

## 문제

가격 해석이 정확해져도 라우트가 그것을 오라클과 같은 모양으로 내보내지 않으면
프런트엔드는 여전히 다르게 본다. 세 갈래다.

### 7-1. 콤보 상위 비용이 attempt에서 집계되지 않는다 (G8)

TS는 attempts가 있으면 콤보 집계를 쓴다(`src/server/management/shared.ts:126-131`):

```ts
entry.attempts?.length ? estimateComboCost(...) : estimateRequestCost(...)
```

Go `displayMetricsFor`는 provider/model/usage만 받아 단일 추정을 한다
(`go/internal/server/request_log_port.go:302-314`). 콤보 행의 상위 provider는 보통
가격표에 없으므로 `price_unmatched`가 된다 — attempt 각각은 가격을 낼 수 있는데도.

### 7-2. attempt별 displayMetrics 필드가 없다 (G7)

TS는 모든 attempt에 자기 `displayMetrics.cost`를 붙인다(`shared.ts:150-157`).
Go `RequestAttemptLog`는 `ErrorCode`까지만 있고 해당 필드가 없다
(`request_log_port.go:411-427`).

### 7-3. 실패 사유가 항상 `price_unmatched`다

Go 폴백 경로(`go/internal/management/shared.go:224-228`)는 usage가 있으면 무조건
`price_unmatched`를 쓴다. TS는 6종으로 분류한다(`shared.ts:108-124`):
`usage_missing`, `usage_unsupported`, `combo_attempt_unavailable`,
`invalid_cache_breakdown`, `invalid_usage`, `price_unmatched`.

같은 경로가 서비스 티어도 안 넘긴다(`EstimateCost` 호출, 티어 인자 없음).

## 파일 변경 지도

| 파일 | 종류 | 위치 |
| --- | --- | --- |
| `go/internal/server/request_log_port.go` | MODIFY | `displayMetricsFor`(302-314), `RequestAttemptLog`(411-427), DTO 조립(242-255) |
| `go/internal/management/shared.go` | MODIFY | `metricDTO`(224-228) |
| `go/internal/server/cost_surface_test.go` | NEW | 3갈래 회귀 |

## 실제 타입 (A 감사 2회차 확정)

초안이 가상의 타입을 썼다. 아래는 **파일에서 직접 읽은** 실제 정의다. 이 절의 모든
필드명은 검증되었다.

```go
// go/internal/server/request_log_port.go:190-193
type requestDisplayMetrics struct {
	TokPerSecond metricValue     `json:"tokPerSecond"`
	Cost         costMetricValue `json:"cost"`
}

// go/internal/server/request_log_port.go:274 — 패키지 함수, 리시버 없음
func displayMetricsFor(provider, model string, duration int64, status RequestUsageStatus,
	value *types.Usage, requestedTier, configuredTier, responseTier string) requestDisplayMetrics
```

`RequestAttemptLog`(`request_log_port.go:411-427`)와 `usage.Attempt`(`usage/log.go:43-57`)는
**필드명이 다르다**. 이게 변환기가 필요한 진짜 이유다:

| `RequestAttemptLog` | `usage.Attempt` | 비고 |
| --- | --- | --- |
| `Status int` | `HTTPStatus int` | 이름 다름 |
| `FirstOutputMS *int64` | `FirstOutput *int64` | 이름 다름 |
| `RecoveryKinds []string` | `Recovery []string` | 이름 다름 |
| `UsageStatus RequestUsageStatus` | `UsageStatus Status` | **타입 다름 — 명시 변환 필요** |
| `Ordinal`, `Provider`, `Model`, `Adapter`, `DurationMS`, `SendCount`, `Usage`, `TotalTokens`, `ErrorCode` | 동일 | 그대로 |

`RequestAttemptLog`에는 `InputTokenEstimate *int`가 있고 `usage.Attempt`에는 없다.
가격 계산에 안 쓰이므로 버린다.

## 변경 1 — 변환기와 콤보 집계

```go
// RequestAttemptLog is the wire/DTO shape; usage.Attempt is the pricing shape.
// Field names and the usage-status type differ, so this projection is explicit
// rather than a conversion (A-phase audit round 2, devlog 260729 065).
func usageAttemptsFor(attempts []RequestAttemptLog) ([]usage.Attempt, bool) {
	out := make([]usage.Attempt, 0, len(attempts))
	for _, attempt := range attempts {
		if attempt.Usage == nil {
			return nil, false // fail closed, mirroring src/usage/cost.ts:320-325
		}
		out = append(out, usage.Attempt{
			Ordinal:     attempt.Ordinal,
			Provider:    attempt.Provider,
			Model:       attempt.Model,
			Adapter:     attempt.Adapter,
			HTTPStatus:  attempt.Status,
			DurationMS:  attempt.DurationMS,
			FirstOutput: attempt.FirstOutputMS,
			SendCount:   attempt.SendCount,
			Recovery:    attempt.RecoveryKinds,
			UsageStatus: usage.Status(attempt.UsageStatus), // named types differ
			Usage:       attempt.Usage,
			TotalTokens: attempt.TotalTokens,
			ErrorCode:   attempt.ErrorCode,
		})
	}
	return out, true
}
```

`usage.Status(attempt.UsageStatus)`가 유효하려면 두 타입의 기반 타입이 같아야 한다.
**구현 전 확인**: `RequestUsageStatus`와 `usage.Status`가 둘 다 `string` 기반인지
읽고, 아니면 매핑 함수를 쓴다.

콤보 분기는 기존 패키지 함수 옆에 래퍼로 넣는다:

```go
// Mirrors src/server/management/shared.ts:126-131: a row with attempts is priced
// by summing its attempts (fail-closed), not by pricing the synthetic top-level
// combo provider, which no price table carries.
func displayMetricsForEntry(entry RequestLogEntry) requestDisplayMetrics {
	if len(entry.Attempts) > 0 {
		tier := effectiveTierOf(entry) // requested/configured/response, same precedence as usage.EffectiveServiceTier
		converted, ok := usageAttemptsFor(entry.Attempts)
		if !ok {
			return metricsUnavailable(entry, "combo_attempt_unavailable")
		}
		if estimate, ok := usage.EstimateComboCost(converted, nil, tier); ok {
			return metricsFromEstimate(entry, estimate)
		}
		return metricsUnavailable(entry, "combo_attempt_unavailable")
	}
	return displayMetricsFor(entry.Provider, entry.Model, entry.DurationMS, entry.UsageStatus,
		entry.Usage, entry.RequestedServiceTier, entry.ConfiguredServiceTier, entry.ResponseServiceTier)
}
```

`metricsUnavailable`/`metricsFromEstimate`는 신규 헬퍼다. `displayMetricsFor` 내부
(`request_log_port.go:274-320`)의 조립 로직을 재사용하도록 추출한다 —
`TokPerSecond`도 채워야 하므로 복제하면 안 된다.

## 변경 2 — attempt별 메트릭

`RequestAttemptLog`에 실제 타입으로 필드를 추가한다:

```go
	ErrorCode      string                  `json:"errorCode,omitempty"`
	DisplayMetrics *requestDisplayMetrics  `json:"displayMetrics,omitempty"`
```

포인터 + `omitempty`인 이유: attempt에 usage가 없으면 오라클이 무엇을 내는지
(`src/server/management/shared.ts:150-157`)를 읽고 맞춰야 하는데, 값 타입이면
"메트릭 없음"을 표현할 수 없다. **구현 시 오라클 응답을 확인해 확정한다.**

## 변경 3 — 사유 분류

TS `costResult`(`shared.ts:108-124`)의 분기를 그대로 옮긴다. 각 사유가 어떤 조건에서
나오는지 TS를 읽어 표로 정리한 뒤 이식한다. 추측하지 않는다.

### 관리 폴백 경로의 티어는 이 사이클에서 고칠 수 없다 (A 감사 2회차)

초안은 `go/internal/management/shared.go:224-228`에
`usage.EffectiveServiceTier(entry)`를 넣으라고 했다. **불가능하다.**

`usage.EffectiveServiceTier`는 `usage.Entry`만 받는다(`go/internal/usage/cost.go:43`).
그런데 이 경로가 다루는 `management.RequestLogEntry`(`go/internal/management/logs.go:21-35`)에는
`RequestedServiceTier`/`ConfiguredServiceTier`/`ResponseServiceTier` 필드가 **아예 없다**.
`RequestID`, `Timestamp`, `Provider`, `Model`, `Surface`, `Status`, `DurationMS`,
`FirstOutputMS`, `ErrorCode`, `UpstreamError`, `UsageStatus`, `Usage`, `TotalTokens`가 전부다.

즉 이 표면은 티어 정보를 **애초에 운반하지 않는다**. 선택지는 둘이다.

| 안 | 내용 | 판단 |
| --- | --- | --- |
| A | `management.RequestLogEntry`에 티어 3필드를 추가하고 채우는 경로를 잇는다 | 로그 스키마 변경이라 범위가 이 사이클을 넘는다 |
| B | 이 사이클에서는 손대지 않고, 스키마 한계를 기록한다 | 채택 |

**B를 채택한다.** 티어 파리티는 `request_log_port.go` 경로에서만 달성하고,
관리 폴백 경로는 후속 work-phase 후보로 남긴다. 사유 분류(변경 3)는 티어와 무관하므로
이 경로에서도 그대로 진행한다.

## 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

| 분기 | 트리거 | 발화 증명 |
| --- | --- | --- |
| 콤보 집계 | 2-attempt 행(`deepseek/deepseek-chat` 1M + `kimi/k3` 1M), 상위 provider는 가격표에 없음 | 상위 `cost.estimate.cost.total == 3.27`. 수정 전 `price_unmatched` |
| fail-closed | 2-attempt 중 하나가 무가격 | `reason == "combo_attempt_unavailable"`, `kind == "unavailable"` |
| attempt 메트릭 | 위 콤보 행 | `attempts[0].displayMetrics.cost.estimate.cost.total == 0.27`, `attempts[1] == 3.00` |
| 사유 분류 | usage 없는 행 / 캐시 분해 불가 행 / 가격만 없는 행 | 각각 `usage_missing` / `invalid_cache_breakdown` / `price_unmatched` |
| 티어 전달 (server 경로 한정) | `openai`/`gpt-5.5`, `responseServiceTier: "priority"` | `request_log_port` DTO 응답에 `priorityMultiplier == 2.5`. **관리 폴백 경로는 제외** — 스키마가 티어를 운반하지 않는다(위 retraction) |

콤보 케이스와 attempt 케이스는 수정 전 각각 `price_unmatched`와 필드 부재를 내므로
테스트가 결함을 재현한다. 사유 분류는 수정 전 전부 `price_unmatched`로 뭉개지므로
3종 구분 단언이 실패한다.

## 테스트

`go/internal/server/cost_surface_test.go`:

- `TestComboTopLevelCostAggregatesAttempts`
- `TestComboFailClosedReason`
- `TestAttemptDisplayMetricsPresent`
- `TestCostUnavailableReasonsMatchOracle`
- `TestRequestLogPortAppliesServiceTier` (server 패키지). 관리 폴백 경로의 티어
  테스트는 **의도적으로 없다** — 스키마 한계이며 후속 work-phase 후보다.

```bash
cd go && go test ./internal/server/... ./internal/management/... -count=1 -v
cd go && go build ./... && go vet ./... && go test ./... -count=1
```

라이브 확인(런타임이 떠 있을 때):

```bash
curl -s "http://127.0.0.1:10100/api/logs?limit=20" \
  | python3 -c 'import json,sys
for r in json.load(sys.stdin):
    c=(r.get("displayMetrics") or {}).get("cost") or {}
    print(r["model"], c.get("kind"), c.get("reason",""),
          (c.get("estimate") or {}).get("cost",{}).get("total"))'
```

## 위험

- `displayMetrics` 타입이 server 패키지 비공개면 attempt 구조체에 넣을 때 export가 필요하다.
  JSON 태그가 계약이므로 이름을 바꿔도 태그는 유지한다.
- attempt별 메트릭 추가는 `/api/logs` 응답 크기를 키운다. 페이지당 attempt 수가 많으면
  측정하고, 문제가 되면 상세 조회에만 붙이는 TS 동작을 확인해 맞춘다.
- `go/test/parity/`의 기존 로그 픽스처가 새 필드로 깨질 수 있다. 오라클 기준으로 갱신한다.

## 완료 기준

콤보 상위 비용이 attempt 합과 일치하고, attempt별 메트릭이 존재하며, 사유 3종 이상이
구분되고, 폴백 경로가 티어를 반영한다.
