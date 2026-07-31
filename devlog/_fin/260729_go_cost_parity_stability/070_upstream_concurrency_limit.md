# 070 — work-phase 8: 업스트림 동시 요청 상한

근거: `002`의 남은 구멍 1번.

## 문제

인바운드 요청 수와 업스트림 요청 수 사이에 아무 상한이 없다. 검색으로 확인:

```bash
rg -n "MaxConnsPerHost|semaphore|Limiter|inflight|MaxIdleConnsPerHost" \
   go/internal/server go/internal/providers go/cmd -g '*.go' -g '!**/*_test.go'
# 관련 결과 없음 (lifecycle/watchdog 내부 채널만 매치)
```

있는 것은 시간 상한뿐이다:

- 서버 측(`go/internal/server/server.go:697`):
  `ReadHeaderTimeout: 10s, ReadTimeout: 30s, WriteTimeout: 0, IdleTimeout: 2m`
- 프로바이더 클라이언트(`go/internal/server/server.go:125`):
  `NewProviderClient(FetchTimeouts{Overall: 10 * time.Minute})`

`WriteTimeout: 0`은 스트리밍 때문에 의도된 값이다. 그런데 이것이 동시성 상한 부재와
결합하면, 느린 업스트림에 물린 스트리밍 요청이 **무제한으로 누적**될 수 있다.
각 요청은 고루틴, 소켓, 버퍼를 잡는다.

## 무엇을 막고 무엇을 안 막나

정직하게 구분한다.

막는 것: 로컬 클라이언트 폭주(스크립트 루프, 폭주하는 에이전트)가 프로바이더로
그대로 증폭되는 것. 프로바이더 쪽 429/차단을 우리가 자초하는 경로다.

**막지 않는 것**: 프로바이더가 계정 단위로 거는 실제 레이트 리밋. 그건
`providers/key_failover.go`의 쿨다운이 다룬다. 이 사이클은 그 위에 자원 상한을 얹는 것이지
레이트 리밋을 대체하지 않는다.

## 포화 정책 결정

두 안 중 하나를 골라야 한다.

| 안 | 동작 | 문제 |
| --- | --- | --- |
| A. 즉시 429 | 슬롯 없으면 바로 거절 | 짧은 버스트에도 거절이 나간다. ocx는 로컬 프록시라 클라이언트가 재시도를 잘 안 한다 — 사용자에게는 그냥 에러다 |
| B. 유한 대기 후 429 | 슬롯을 짧게 기다리고 그래도 없으면 거절 | 대기 자체가 자원이지만 유계다 |

**B를 채택한다.** ocx의 클라이언트는 사람이 쓰는 CLI/앱이고, 순간 버스트가 정상 패턴이다
(에이전트가 병렬 툴 호출을 던진다). A는 정상 사용을 깨뜨린다. 대기는
`min(5s, 남은 요청 컨텍스트)`로 유계이고, 대기 중에도 클라이언트 취소를 즉시 존중한다.

거절 시에는 `Retry-After: 1`을 붙인다. CLIProxyAPI가 전면 쿨다운에서 합성 429에
자체 `Retry-After`를 다는 것과 같은 발상이다(`002` 참조).

## 슬롯 수명 — 스트리밍 문제

핵심 설계 지점이다. 스트리밍 요청은 수 분간 살아 있으므로, 슬롯을 응답 완료까지
잡으면 상한이 곧 **동시 스트림 수 상한**이 된다.

그래서 슬롯은 **업스트림 연결 확립까지만** 잡는다.

```
acquire  -> 업스트림 요청 전송 -> 응답 헤더 수신 -> release -> 본문 스트리밍(무제한)
```

이러면 상한이 막는 것은 "동시에 업스트림에 신규 연결을 시도하는 수"다. 폭주 증폭을
막는 목적에는 이게 맞고, 정상 스트리밍은 영향받지 않는다.

이 선택의 한계도 기록한다: 이미 연결된 장기 스트림이 수백 개면 상한은 그것을 줄이지 못한다.
그건 별개 문제이고 이 사이클의 범위가 아니다.

## 파일 변경 지도

| 파일 | 종류 | 위치 |
| --- | --- | --- |
| `go/internal/server/limiter.go` | NEW | 전역 + 프로바이더별 세마포어 |
| `go/internal/server/responses_fetch_helpers.go` | MODIFY | `FetchWithHeaderTimeout`(27-46) — 주 경로 |
| `go/internal/server/fetch.go` | MODIFY | `FetchProvider`(35-45) — 레거시/보조 경로 |
| `go/internal/server/server.go` | MODIFY | 설정 기본값 배선(약 120-130) |
| `go/internal/config/` | MODIFY | `upstreamMaxConcurrent`, `upstreamMaxConcurrentPerProvider` |
| `go/internal/server/limiter_test.go` | NEW | 포화·취소·해제 회귀 |

**A 감사 정정**: 초안은 `fetch.go`만 지목했는데 **그건 주 경로가 아니다**.
Responses 코어는 `FetchWithHeaderTimeout`을 부른다:

```go
// go/internal/server/responses_core_port.go:489
		response, err := FetchWithHeaderTimeout(ctx, core.config.Client, upstream, 0, normalized.Stream)
// go/internal/server/responses_fetch_helpers.go:44
	response, err := doer.Do(request.Clone(headerCtx))
// go/internal/server/responses_fetch_helpers.go:35 (timeout<=0 분기)
		return doer.Do(request.Clone(ctx))
```

`fetch.go:45`의 `FetchProvider`만 감싸면 **주 요청 경로가 상한 밖에 남는다**.
따라서 1차 훅은 `responses_fetch_helpers.go`이고, `FetchWithHeaderTimeout`의
**두 반환 경로 모두**(timeout<=0 분기와 타이머 분기)에 acquire/release가 필요하다.

**선행 확인**: 그 외 우회 경로가 있는지 `rg -n "doer\\.Do|client\\.Do" go/internal/server/ go/internal/providers/`로
전수 조사한다. 누락된 통로가 있으면 상한이 샌다.

## 구현

```go
// go/internal/server/limiter.go
//
// Bounds how many requests may be establishing an upstream connection at once.
// The slot is released once response headers arrive, NOT when the body finishes,
// so long-lived streams never consume budget (devlog 260729 070).
type upstreamLimiter struct {
	global    chan struct{}
	perMu     sync.Mutex
	perDest   map[string]chan struct{}
	perLimit  int
	waitLimit time.Duration
}

var errUpstreamSaturated = errors.New("upstream concurrency limit reached")

func (l *upstreamLimiter) acquire(ctx context.Context, provider string) (release func(), err error) {
	if l == nil {
		return func() {}, nil
	}
	waitCtx, cancel := context.WithTimeout(ctx, l.waitLimit)
	defer cancel()

	if err := take(waitCtx, l.global); err != nil {
		return nil, saturationError(ctx, err)
	}
	slot := l.destSlot(provider)
	if err := take(waitCtx, slot); err != nil {
		<-l.global // never hold the global slot after failing the per-provider one
		return nil, saturationError(ctx, err)
	}
	var once sync.Once
	return func() { once.Do(func() { <-slot; <-l.global }) }, nil
}

func take(ctx context.Context, sem chan struct{}) error {
	select {
	case sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// A client that went away is a cancellation, not a saturation event; conflating
// them would report our own limit for every aborted request.
func saturationError(parent context.Context, err error) error {
	if parent.Err() != nil {
		return parent.Err()
	}
	return errUpstreamSaturated
}
```

두 지점이 미묘하다. 전역 슬롯을 잡은 뒤 프로바이더 슬롯에서 실패하면 **반드시 전역을
돌려놔야** 한다(위 `<-l.global`). 그리고 `release`는 `sync.Once`로 감싼다 —
에러 경로와 정상 경로가 둘 다 부르면 세마포어가 음수처럼 망가진다.

### 배선 (A 감사 2회차: 초안에 빠져 있던 부분)

`FetchWithHeaderTimeout`은 limiter도 provider도 받지 않는다:

```go
// go/internal/server/responses_fetch_helpers.go:27
func FetchWithHeaderTimeout(ctx context.Context, doer HTTPDoer, request *http.Request,
	timeout time.Duration, preferIdentityEncoding bool) (*http.Response, error)
```

그리고 `ResponsesCoreConfig`에는 `Client *http.Client`만 있다
(`go/internal/server/responses_core_port.go:37`). 즉 상한 상태를 전달할 통로가 없다.

시그니처를 늘리는 대신 **`HTTPDoer`를 감싼다.** 호출부가 전부 `doer`를 통해 나가므로
데코레이터가 가장 침습이 적고, 우회 경로도 자동으로 덮인다.

```go
// limitedDoer bounds how many requests may be establishing an upstream
// connection at once. Wrapping HTTPDoer keeps FetchWithHeaderTimeout's
// signature intact and covers every call that already routes through the doer.
type limitedDoer struct {
	inner    HTTPDoer
	limiter  *upstreamLimiter
	provider string
}

func (d limitedDoer) Do(request *http.Request) (*http.Response, error) {
	release, err := d.limiter.acquire(request.Context(), d.provider)
	if err != nil {
		return nil, err
	}
	response, err := d.inner.Do(request)
	release() // headers are in; the body streams outside the budget
	return response, err
}
```

호출부(`responses_core_port.go:489`):

```go
		doer := core.limitedDoer(provider) // wraps core.config.Client
		response, err := FetchWithHeaderTimeout(ctx, doer, upstream, 0, normalized.Stream)
```

`ResponsesCoreConfig`에 필드를 추가한다:

```go
	Client            *http.Client
	UpstreamLimiter   *upstreamLimiter // nil disables limiting entirely
```

`nil`이면 `acquire`가 즉시 통과하므로(위 `if l == nil`) 기존 동작이 그대로 보존된다.

**주의**: 데코레이터는 `Do` 한 곳만 감싸므로 `FetchWithHeaderTimeout`의 두 반환 경로
(`:35` timeout<=0, `:44` 타이머)가 **자동으로 모두 덮인다**. 초안이 걱정했던
"두 경로 각각에 acquire/release" 문제는 이 설계에서 사라진다.

### 호출 지점 전수 (A 감사 3회차)

데코레이터는 `doer`를 **주입하는 곳마다** 설치해야 한다. 한 곳만 감싸면 나머지가 샌다.
실측 결과 상위 호출 지점은 셋이다:

```
$ rg -n "FetchWithHeaderTimeout\(|FetchProvider\(" --glob '!*_test.go' go/internal/
go/internal/server/responses_core_port.go:489    FetchWithHeaderTimeout(ctx, core.config.Client, ...)
go/internal/server/responses_compact_port.go:147 FetchWithHeaderTimeout(incoming.Context(), route.Transport, ...)
go/internal/server/fetch.go:36                   func FetchProvider(ctx, client *http.Client, ...)
```

| 지점 | 처리 | 근거 |
| --- | --- | --- |
| `responses_core_port.go:489` | 데코레이터 설치 | 주 요청 경로 |
| `responses_compact_port.go:147` | 데코레이터 설치 | `route.Transport`를 감싼다. 컴팩션도 업스트림 연결을 만들므로 예외 없음 |
| `fetch.go:36` `FetchProvider` | 데코레이터 설치 | `*http.Client`를 직접 받으므로 `HTTPDoer` 래핑 지점이 다르다. 별도 확인 필요 |

#### 컴팩트 경로를 어디서 감쌀 것인가 (실측 후 결정)

"생성 지점에서 감싸라"는 초안 권고는 **실행 불가능하다**. `CompactRoute`는
프로덕션 코드에 조립 지점이 없다:

```
$ rg -n "CompactRoute\{|Transport:" --glob '*.go' --glob '!*_test.go' go/internal/server/
go/internal/server/sidecar.go:92   SidecarTarget{... Transport: config.Client}
go/internal/server/fetch.go:32     &http.Client{Transport: transport, ...}
```

`CompactRoute.Transport`(`responses_compact_port.go:25`)는 **호출자가 채워 넣는
필드**이고, 그 호출자는 이 저장소 밖(또는 테스트)이다. 즉 감쌀 "한 곳"이 없다.

따라서 **소비 지점에서 감싼다**. `responses_compact_port.go:147`이 유일한 소비처다:

```go
// go/internal/server/responses_compact_port.go:147 (현재)
	response, err := FetchWithHeaderTimeout(incoming.Context(), route.Transport, upstream, route.Timeout, false)

// 변경 후
	doer := limited(route.Transport, coordinator.limiter, providerLabel)
	response, err := FetchWithHeaderTimeout(incoming.Context(), doer, upstream, route.Timeout, false)
```

`limited(...)`는 limiter가 nil이면 원본 doer를 그대로 돌려주는 헬퍼로 만든다.
그러면 배선이 안 된 경로도 안전하게 무제한으로 동작한다(기존 동작 보존).

`CompactCoordinator`에 limiter 필드를 추가해야 하며, **provider 라벨을 이 지점에서
얻을 수 있는지 확인이 필요하다** — 없으면 프로바이더별 상한 대신 전역 상한만
적용하고 그 사실을 기록한다. 컴팩션은 요청 빈도가 낮으므로 전역만으로도 목적을 달성한다.

**선행 확인**: 위 셋 외 우회 경로를 다시 조사한다:
`rg -n "doer\\.Do|client\\.Do|http\\.DefaultClient" go/internal/server/ go/internal/providers/`.
`FetchWithHeaderTimeout:29`의 `doer = http.DefaultClient` 폴백도 그중 하나이며,
이 폴백을 타면 limiter가 없는 클라이언트가 쓰인다.

`release()`를 `defer`로 두면 안 된다 — 함수가 반환할 때까지 잡고 있으면
스트리밍 본문이 슬롯을 물게 된다. 헤더 수신 직후 명시적으로 해제한다.

기본값: 전역 64, 프로바이더별 16, 대기 5초. 근거는 없다 — **관측 후 조정할 초기값**이며
설정으로 노출한다. 0이면 무제한(기존 동작)으로 두어 회귀 위험을 없앤다.

거절 응답: `errUpstreamSaturated`를 429 + `Retry-After: 1`로 분류한다.
`writeClassifiedJSONError` 경로에 매핑을 추가한다.

## 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

상한 분기가 실제로 발화하는지 증명한다.

트리거: 전역 상한 2로 설정하고, 헤더를 보내기 전 블록하는 `httptest` 업스트림을 띄운다.
요청 3개를 동시에 던진다.

발화 증명:

1. 업스트림이 받은 동시 연결 수가 **정확히 2**에서 멈춘다(업스트림 핸들러가
   `atomic.AddInt64`로 최대 동시 수를 기록). 3이 되면 상한이 안 걸린 것이다.
2. 3번째 요청은 대기 후 429 + `Retry-After: 1`을 받는다.
3. 업스트림이 헤더를 흘려보내면 대기 중이던 요청이 **통과**한다 — 슬롯이 실제로
   해제된다는 증거(해제가 없으면 영구 데드락).

스트리밍 비회귀(설계 의도가 지켜지는지):

4. 상한 1로 두고 **장기 스트림** 1개를 연 뒤, 두 번째 요청을 던진다.
   두 번째가 **성공해야 한다** — 슬롯이 헤더 시점에 풀렸다는 증거.
   `defer release()`로 잘못 구현하면 이 테스트가 데드락으로 실패한다.

취소 구분:

5. 대기 중인 요청의 클라이언트 컨텍스트를 취소하면 429가 아니라 `context.Canceled`가
   나온다 — `saturationError`의 분기가 발화했다는 증거.

4번이 이 사이클의 핵심 단언이다. 상한을 넣으면서 스트리밍을 죽이는 것이 가장 흔한 실패 모드다.

## 테스트

`go/internal/server/limiter_test.go`:

- `TestLimiterCapsConcurrentUpstreamConnections`
- `TestLimiterRejectsWithRetryAfterAfterWait`
- `TestLimiterReleasesOnResponseHeaders`
- `TestStreamingDoesNotHoldSlot` (위 4번)
- `TestClientCancelIsNotSaturation` (위 5번)
- `TestLimiterDisabledWhenZero`

```bash
cd go && go test ./internal/server/ -run Limiter -count=1 -race -v
cd go && go build ./... && go vet ./... && go test ./... -count=1
```

기존 `concurrency_stress_test.go`가 있으므로 함께 돌려 회귀를 본다.

## 위험

- **데드락.** 전역/프로바이더 두 세마포어를 겹쳐 잡는다. 획득 순서를 항상
  전역 → 프로바이더로 고정하고, 실패 시 역순 반환을 지킨다. `-race`와
  기존 스트레스 테스트로 검증한다.
- **우회 경로.** `fetch.go`를 안 타는 업스트림 호출이 있으면 상한이 샌다.
  선행 확인 항목이며, 발견되면 그 목록을 문서에 추가한다.
- **기본값이 너무 낮으면 정상 사용을 막는다.** 그래서 0=무제한을 지원하고,
  초기 롤아웃은 넉넉한 값(전역 64)으로 시작한다. 조정은 관측 후.
- 콤보/재시도 경로는 한 요청이 여러 업스트림을 연다. 프로바이더별 상한이
  콤보를 굶기지 않는지 `combos` 테스트로 확인한다.

## 완료 기준

5개 활성화 단언이 전부 통과하고, 특히 `TestStreamingDoesNotHoldSlot`이 초록이며,
`-race`와 기존 스트레스 테스트가 깨지지 않는다.
