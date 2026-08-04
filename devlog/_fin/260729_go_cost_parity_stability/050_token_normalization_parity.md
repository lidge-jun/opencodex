# 050 — work-phase 5: 토큰 정규화 zero-vs-null 수정

근거: `001` G4·G5. 두 결함은 같은 뿌리이므로 한 사이클에서 함께 고친다.

## 문제

TS는 nullish 병합만 쓴다(`src/usage/cost.ts:109-110`):

```ts
const primaryRead = usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0;
```

즉 **명시적 `0`은 권위 있는 값**이고 폴백을 유발하지 않는다. 레거시 재시도는
`cacheReadInputTokens`가 number가 **아닐 때만** 후보에 추가된다(`cost.ts:112-116`).

Go는 0을 미지정으로 취급한다(`go/internal/usage/cost.go:57-61`):

```go
	read := value.CacheReadInputTokens
	if read == 0 {
		read = value.CachedInputTokens
	}
```

같은 버그가 요약에도 있다(`go/internal/usage/summary.go:182-187`).

근본 원인은 타입이다. Go `types.Usage`의 필드가 `int`라서 "0"과 "미지정"이 구분되지 않는다.
TS는 `number | undefined`라 구분된다. **이 사이클의 핵심은 그 구분을 Go에 복원하는 것이다.**

## 파일 변경 지도

| 파일 | 종류 | 위치 |
| --- | --- | --- |
| `go/internal/types/types.go` | MODIFY | `Usage`(177-187)에 존재 추적 추가 |
| `go/internal/usage/cost.go` | MODIFY | `NormalizeCostTokens`(53-75) |
| `go/internal/usage/summary.go` | MODIFY | `addTokens`(178-195) |
| `go/internal/usage/normalize_test.go` | NEW | 발산 시나리오 회귀 |

`Usage`는 `go/internal/types/types.go:177-187`에 있다(감사 확인). 캐시 필드는 전부
`int` + `omitempty`이므로 0이 직렬화에서 생략된다 — 존재 추적이 필요한 정확한 이유다.

**선행 조사 필수**: 포인터 전환 대신 대안 B를 기본으로 하되, 포인터 전환의
파급 범위를 센다(`rg -n "CacheReadInputTokens|CachedInputTokens" go/ | wc -l`).
파급이 과도하면 대안 B로 간다.

## 대안 B — 포인터 전환이 과도할 때

`Usage`에 존재 플래그를 병행한다. JSON 역직렬화 시점에 키 존재 여부를 기록:

```go
type Usage struct {
	InputTokens              int  `json:"inputTokens"`
	CacheReadInputTokens     int  `json:"cacheReadInputTokens"`
	hasCacheReadInputTokens  bool `json:"-"`
	...
}

func (u *Usage) UnmarshalJSON(data []byte) error {
	type alias Usage
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil { return err }
	_, u.hasCacheReadInputTokens = probe["cacheReadInputTokens"]
	return json.Unmarshal(data, (*alias)(u))
}

func (u Usage) HasCacheRead() bool { return u.hasCacheReadInputTokens }
```

포인터보다 침습이 적고 기존 `int` 산술이 전부 살아남는다. **B를 기본안으로 둔다.**
A(포인터)는 파급이 작다고 측정됐을 때만 택한다.

## 변경 — `NormalizeCostTokens`

before (`go/internal/usage/cost.go:53-75`)의 핵심:

```go
	read := value.CacheReadInputTokens
	if read == 0 {
		read = value.CachedInputTokens
	}
	candidates := []int{read}
	if value.CacheReadInputTokens == 0 && value.CachedInputTokens > 0 && write > 0 {
		candidates = append(candidates, max(0, value.CachedInputTokens-write))
	}
```

after:

```go
	// Canonical-first with a single legacy retry, mirroring
	// src/usage/cost.ts:104-127. An explicit zero is authoritative: only an
	// ABSENT cacheReadInputTokens falls back to cachedInputTokens, and only an
	// absent one may take the legacy (cached - creation) retry.
	read := 0
	if value.HasCacheRead() {
		read = value.CacheReadInputTokens
	} else if value.HasCachedInput() {
		read = value.CachedInputTokens
	}
	candidates := []int{read}
	if !value.HasCacheRead() && value.HasCachedInput() && value.HasCacheCreation() {
		candidates = append(candidates, max(0, value.CachedInputTokens-write))
	}
```

TS 재시도 조건은 `typeof cacheReadInputTokens !== "number" && typeof cachedInputTokens === "number"
&& typeof cacheCreationInputTokens === "number"`다. 현재 Go의 `write > 0`은 **TS에 없는 조건**이므로
제거한다(`cacheCreationInputTokens: 0`이 명시된 레거시 행이 재시도를 못 받는다).

`summary.go:182-187`도 동일 규칙으로 맞춘다.

## 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

발산 시나리오를 **실제 숫자로** 재현한다. 프로바이더 `deepseek`/`deepseek-chat`
(입력 `0.27`, 캐시읽기 `0.07`, `prices.go:56`).

| # | usage | TS 기대 | 수정 전 Go | 발화 분기 |
| --- | --- | --- | --- | --- |
| A | `{input:100, cacheRead:0(명시), cached:50}` | 토큰 `{input:100, cacheRead:0}`, `$0.000027` | `{50,50}`, `$0.000017` | 명시적 0 우선 |
| B | `{input:100, cacheRead:0(명시), cached:100, creation:20}` | `{input:80, cacheWrite:20}`, `$0.0000216` | `{0,80,20}`, `$0.0000056` | 재시도 억제 |
| C | `{input:100, cached:50}` (cacheRead 키 부재) | `{input:50, cacheRead:50}` | 동일 | 부재 시 폴백 |
| D | `{input:100, cached:100, creation:20}` (cacheRead 부재) | 레거시 재시도 발화 | 동일 | 레거시 재시도 |

A와 B는 수정 전 **다른 숫자**를 내므로 테스트가 결함을 재현한다.
C와 D는 폴백/재시도 분기가 여전히 살아 있음을 증명한다 — 수정이 분기를 죽이지 않았다는 증거.
(분기를 통째로 지우면 C·D가 실패한다.)

요약 측(G5): 같은 A 입력으로 `Summarize`를 돌려 `cachedInputTokens`/`cacheReadInputTokens`가
0만큼 증가하는지 단언. 수정 전에는 50 증가한다.

## 테스트

`go/internal/usage/normalize_test.go`:

- `TestNormalizeExplicitZeroCacheRead` (A)
- `TestNormalizeExplicitZeroSuppressesLegacyRetry` (B)
- `TestNormalizeAbsentCacheReadFallsBack` (C)
- `TestNormalizeLegacyRetryStillFires` (D)
- `TestSummaryCacheTotalsRespectExplicitZero` (G5)

기존 `fuzz_test.go`가 있으므로 퍼즈도 함께 돌린다:

```bash
cd go && go test ./internal/usage/... -count=1 -v
cd go && go test ./internal/usage/... -run Fuzz -fuzz Fuzz -fuzztime 30s
cd go && go build ./... && go vet ./... && go test ./... -count=1
```

## 위험

- **역직렬화 경로가 하나가 아닐 수 있다.** 프로바이더 어댑터가 `Usage`를 직접 조립하면
  존재 플래그가 안 채워진다. `rg -n "types.Usage{" go/ | wc -l`로 조립 지점을 세고,
  각 지점이 "값을 실제로 알고 있는가"를 판단해 플래그를 세팅한다. 이게 이 사이클의 실제 작업량이다.
- 저장된 로그를 다시 읽는 경로(`usage/log.go`)도 같은 역직렬화를 타는지 확인한다.
- `UnmarshalJSON` 추가는 성능에 영향이 있다(맵 프로브 1회 추가). 수십만 행 순회 경로이므로
  벤치마크로 확인하고, 유의미하면 프로브를 `jsonparser` 스타일 키 스캔으로 대체한다.

## 완료 기준

A~D 4개 시나리오가 TS 기대값과 정확히 일치하고, 요약 캐시 총합이 명시적 0을 존중하며,
퍼즈 30초가 초록이다.
