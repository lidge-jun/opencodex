# 010 — work-phase 1: 비용 JSON 키 파리티

근거 문서: `003_live_wiring_probe.md` W1. 이 사이클이 지도의 첫 구현 단계인 이유는
거기 적었다 — 뒤 단계들이 가격을 아무리 정확히 만들어도 이걸 안 고치면 화면에 안 뜬다.

## 문제

`go/internal/usage/cost.go:10-11`의 두 구조체에 JSON 태그가 없어 필드가 대문자로
직렬화된다. GUI는 소문자를 읽으므로(`gui/src/pages/Logs.tsx:53`, `:208`) 가격이
계산된 요청도 `—`로 렌더된다.

## 파일 변경 지도

| 파일 | 종류 | 위치 |
| --- | --- | --- |
| `go/internal/usage/cost.go` | MODIFY | `CostTokens`, `CostBreakdown` 정의(10-11행) |
| `go/internal/usage/cost_json_test.go` | NEW | 직렬화 키 회귀 테스트 |

`AttemptCostEstimate`/`CostEstimate`는 이미 태그가 있다(`cost.go:16-28`). 건드리지 않는다.

## 변경

before (`go/internal/usage/cost.go:10-11`):

```go
type CostTokens struct{ Input, Output, CacheRead, CacheWrite int }
type CostBreakdown struct{ Input, Output, CacheRead, CacheWrite, Total float64 }
```

after:

```go
// JSON keys mirror the TypeScript oracle exactly (src/usage/cost.ts:29-42).
// The GUI reads lowercase (gui/src/pages/Logs.tsx:53); untagged Go fields
// serialize as `Total`/`Input`, which renders every priced row as an em dash.
type CostTokens struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
}

type CostBreakdown struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Total      float64 `json:"total"`
}
```

필드명·타입·순서는 그대로다. 태그만 추가하므로 Go 쪽 호출부는 전부 무영향이다.

## 동일 결함 스윕 (필수)

태그 없는 구조체가 이 둘뿐이라는 보장이 없다. 같은 사이클에서 usage/management 응답
경로 전체를 훑는다:

```bash
cd go && rg -n '^type [A-Z][A-Za-z]* struct' internal/usage internal/management internal/server \
  | while read -r loc; do :; done
# 실제로는 아래로 태그 없는 exported 필드를 찾는다
rg -n 'json:"' -L internal/usage/*.go
```

응답에 실리는 구조체 중 태그가 없는 것이 더 나오면 **이 사이클에서 같이 고친다**.
W1과 같은 뿌리이므로 별도 work-phase로 미루지 않는다. 다만 응답에 실리지 않는
내부 전용 구조체는 범위 밖이다.

## 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

이 변경은 조건부 분기가 아니라 직렬화 계약이다. 그래서 활성화 증거는 **바이트 비교**다.

트리거: `EstimateCostWithTier`로 실제 추정을 만들고 `json.Marshal`한다.
관찰: 결과 바이트를 `map[string]any`로 되읽어 `cost` 객체의 키 집합이 정확히
`{input, output, cacheRead, cacheWrite, total}`인지 단언한다.
발화 증명: 수정 전 이 테스트는 `Total` 키가 있고 `total`이 없어 **실패**한다.
수정 후 통과한다. 즉 테스트가 결함을 실제로 재현한다.

추가로 라이브 계약을 고정한다: 오라클 `src/usage/cost.ts`의 `CostBreakdown` 필드명을
테스트 픽스처에 하드코딩된 기대 키 집합으로 두고, 불일치 시 실패시킨다.

## 테스트

새 파일 `go/internal/usage/cost_json_test.go`:

- `TestCostBreakdownJSONKeysMatchOracle` — `CostBreakdown`을 마셜해 키 집합 단언.
- `TestCostTokensJSONKeysMatchOracle` — `CostTokens` 동일.
- `TestEstimateCostJSONShapeMatchesOracle` — `EstimateCostWithTier` 결과 전체를
  마셜해 `estimate.cost.total`과 `estimate.tokens.input`이 **경로로** 접근되는지 단언
  (GUI가 실제로 쓰는 접근 경로 그대로).

```bash
cd go && go test ./internal/usage/... -run 'JSON' -count=1 -v
cd go && go build ./... && go vet ./... && go test ./... -count=1
```

## 위험

- 이미 대문자 키를 소비하는 Go 측 소비자가 있으면 깨진다. 확인 명령:
  `rg -n '"Total"|"CacheRead"|\["Input"\]' go/ gui/src`. 발견되면 그쪽을 소문자로 맞춘다
  (오라클이 소문자이므로 소문자가 정답이다).
- 파리티 테스트 픽스처에 대문자 키가 하드코딩돼 있을 수 있다. `go/test/parity/`를
  확인하고 함께 갱신한다.
- GUI 변경은 없다. GUI는 이미 올바른(오라클) 키를 읽고 있다.

## 완료 기준

`/api/logs`의 `displayMetrics.cost.estimate.cost.total`이 소문자 경로로 접근 가능하고,
수정 전 실패하던 회귀 테스트가 통과하며, `go build`/`go vet`/`go test ./...`가 전부 0이다.
