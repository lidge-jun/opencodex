# 100 — work-phase 11: item-id repair 고루틴 가드

근거: `002`의 남은 구멍 4번.

## 문제

`go/internal/server/repair.go:64-67`:

```go
func repairResponsesItemIDs(source io.Reader, config *ResponsesItemIDRepairConfig, repairAllInvalid bool) io.Reader {
	reader, writer := io.Pipe()
	go func() { writer.CloseWithError(repairStreamConfigured(writer, source, config, repairAllInvalid)) }()
	return reader
}
```

이 고루틴의 수명은 **오직 파이프 상태**에 묶여 있다. 컨텍스트를 받지 않고,
호출자가 중간에 포기해도 그것을 알 방법이 없다.

호출부(`go/internal/server/responses_core_port.go:854-860`):

```go
func (core *ResponsesCore) eventsForResponse(ctx context.Context, adapter types.Adapter, response *http.Response, provider string, closeBody bool) <-chan types.AdapterEvent {
	body := io.Reader(response.Body)
	if core.config.ItemIDRepair != nil {
		if repair := core.config.ItemIDRepair(provider); HasResponsesItemIDRepair(repair) {
			body = RepairResponsesItemIDsWithConfig(body, *repair)
		}
	}
```

`ctx`가 인자로 있는데 `RepairResponsesItemIDsWithConfig`에는 **전달되지 않는다**.

## 누수 조건

`repairStreamConfigured`는 `bufio.Scanner`로 `source`를 끝까지 읽는다(`repair.go:74-76`).
고루틴이 끝나려면 둘 중 하나가 필요하다.

1. `source`(업스트림 응답 본문)가 EOF/에러에 도달한다, 또는
2. 파이프 읽기 쪽이 닫혀 `writer.Write`가 `ErrClosedPipe`를 반환한다.

조건 2는 소비자가 `reader`를 **닫아야** 성립한다. 소비자는
`readerWithCloser{Reader: body, Closer: response.Body}`(`:861`)인데 `Closer`는
`response.Body`이지 파이프 reader가 아니다. 즉 파이프 reader는 아무도 명시적으로 닫지 않고,
`response.Body.Close()`가 조건 1을 유발하기를 기대하는 구조다.

보통은 동작한다. 문제가 되는 경우:

- 업스트림이 응답 본문을 열어둔 채 아무것도 보내지 않는다(스톨). `Close()`가
  즉시 읽기를 깨우지 못하는 전송 계층이면 고루틴은 `Scan()`에서 대기한다.
- `ParseStream` 경로가 예외적으로 조기 반환해 `response.Body.Close()`가 스킵된다.

두 경우 모두 고루틴 하나 + 파이프 버퍼가 요청 수명을 넘겨 남는다. 요청당 하나씩
쌓이면 장기 실행 프로세스에서 서서히 는다.

**정직하게**: 현재 라이브에서 이 누수를 재현한 증거는 없다. 이 사이클은
"관측된 장애 수정"이 아니라 "구조적 가드 추가"다. D 요약에 그렇게 기록한다.

## 파일 변경 지도

| 파일 | 종류 | 위치 |
| --- | --- | --- |
| `go/internal/server/repair.go` | MODIFY | `repairResponsesItemIDs`(63-67), 공개 래퍼 2개(52-61) |
| `go/internal/server/responses_core_port.go` | MODIFY | `eventsForResponse`(854-860)에서 ctx 전달 |
| `go/internal/server/repair_leak_test.go` | NEW | 누수 회귀 |

## 변경 (A 감사로 재설계)

초안은 `ctx.Done()`에서 `reader.CloseWithError(...)`를 부르는 감시 고루틴을 제안했다.
**그것으로는 문제의 고루틴을 깨울 수 없다.** 리뷰어 지적이 맞다.

이유: 파킹된 고루틴은 `repairStreamConfigured` 안의
`scanner.Scan()`(`go/internal/server/repair.go:74`)에서 **`source.Read`를 기다린다**.
파이프의 읽기 쪽을 닫으면 다음 `writer.Write`가 실패하지만, 고루틴이 아직 아무것도
쓰지 못한 채 읽기에서 막혀 있으면 그 `Write`에 **도달하지 못한다**. 즉 초안대로 고치면
스톨 시나리오에서 테스트가 여전히 타임아웃한다.

깨우려면 **`source` 쪽**을 건드려야 한다. 두 층으로 간다.

### 층 1 — source를 닫는다 (실효적 해제)

`eventsForResponse`가 넘기는 `source`는 `response.Body`다
(`go/internal/server/responses_core_port.go:855`: `body := io.Reader(response.Body)`).
표준 `net/http` 응답 본문은 `Close()`가 진행 중인 `Read`를 에러로 깨운다 — 이것이 실제 해제 수단이다.

**단, 이것은 보편적 보장이 아니다**(A 감사 2회차). `io.ReadCloser` 인터페이스는
동시 `Close`가 진행 중인 `Read`를 중단시킨다고 규정하지 않는다. 표준 라이브러리
본문은 그렇게 동작하지만, 임의의 구현이나 테스트 더블은 아닐 수 있다. 따라서
아래 테스트는 **협조적인 `Close`를 가정한 경우만** 증명하며, 비협조적 구현은
알려진 한계로 남는다.

```go
func repairResponsesItemIDsContext(ctx context.Context, source io.Reader,
	config *ResponsesItemIDRepairConfig, repairAllInvalid bool) io.Reader {
	reader, writer := io.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		writer.CloseWithError(repairStreamConfigured(writer, source, config, repairAllInvalid))
	}()
	if ctx.Done() != nil {
		go func() {
			select {
			case <-ctx.Done():
				// Closing the pipe reader alone cannot wake a goroutine parked in
				// source.Read (A-phase audit). Closing the SOURCE is what unblocks
				// it; the pipe close is the secondary signal for the write side.
				if closer, ok := source.(io.Closer); ok {
					_ = closer.Close()
				}
				_ = reader.CloseWithError(ctx.Err())
			case <-done:
			}
		}()
	}
	return reader
}
```

### 층 2 — 닫을 수 없는 source는 래핑한다

`source`가 `io.Closer`가 아니면 층 1이 no-op이다. 그 경우를 위해 컨텍스트 인지 리더를 씌운다:

```go
// ctxReader makes an unclosable source cancellable. It cannot abort a Read that
// is already blocked inside the underlying reader, so it is a fallback for
// sources we cannot Close, not a replacement for layer 1.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
```

**한계를 정직하게 적는다**: `ctxReader`는 이미 블록된 `Read`를 깨우지 못한다.
다음 `Read` 호출 경계에서만 끊는다. 따라서 진짜 스톨 해제는 층 1이 담당하고,
층 2는 "조금씩 읽히지만 끝나지 않는" 부류만 끊는다. 두 층을 다 넣되 각자의 역할을 혼동하지 않는다.

### 호출부

`responses_core_port.go:856-858`에서 ctx를 전달한다. 다만 `source`가
`response.Body`이고 그 Body는 `readerWithCloser`로 아래에서 다시 쓰이므로
(`:861`), **이중 Close 안전성**을 확인해야 한다. `http.Response.Body.Close()`는
멱등이 보장되지 않는 구현이 있으므로 `sync.Once`로 감싸거나, 취소 시에만 닫도록 제한한다.

## 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

가드가 **실제로 발화하는지** 증명한다. "테스트 통과"로는 부족하다 —
정상 경로는 가드 없이도 통과하기 때문이다.

트리거: 절대 EOF에 도달하지 않는 `source`를 만든다.

```go
type blockingReader struct{ release chan struct{} }
func (b *blockingReader) Read(p []byte) (int, error) { <-b.release; return 0, io.EOF }
```

시나리오:

1. `ctx, cancel := context.WithCancel(...)`로 repair reader를 만든다.
2. `runtime.NumGoroutine()`을 기록한다(기준선은 `runtime.GC()` + 짧은 안정화 후).
3. `cancel()`을 호출한다.
4. 최대 2초 폴링하며 고루틴 수가 기준선으로 돌아오는지 확인한다.

트리거를 층 1이 검증되게 만든다: `blockingReader`가 `io.Closer`를 구현하고
`Close()`가 `release` 채널을 닫아 `Read`를 깨우게 한다. 이것이 실제 HTTP 본문의 동작을 모사한다.

```go
type blockingReadCloser struct {
	release chan struct{}
	once    sync.Once
}
func (b *blockingReadCloser) Read(p []byte) (int, error) { <-b.release; return 0, io.EOF }
func (b *blockingReadCloser) Close() error { b.once.Do(func() { close(b.release) }); return nil }
```

발화 증명:

- 취소 후 고루틴 수가 기준선 ±1 이내로 복귀 — 가드가 파킹된 고루틴을 깨웠다는 증거.
- **`Close()`가 실제로 불렸는지** 카운터로 단언 — 층 1이 발화했다는 직접 증거.
  이게 없으면 고루틴이 다른 이유로 끝났을 수 있다.
- `io.Closer`를 구현하지 **않는** source로도 같은 테스트를 돌려, 층 1이 no-op일 때
  어떤 동작이 되는지 기록한다(현재 설계상 여전히 파킹된다 — 알려진 한계로 문서화).
- reader에서 읽으면 `ctx.Err()`가 반환된다 — 취소 사유가 전파됐다는 증거
  (단순히 EOF로 끝난 게 아니다).
- **수정 전 이 테스트는 4단계에서 타임아웃한다.** 결함을 재현한다.

정상 경로 비회귀:

- 유한한 source로 정상 종료 시, `writerDone` 경로로 감시 고루틴이 빠지는지
  같은 방식으로 확인. 여기서 고루틴이 남으면 **가드 자체가 새 누수**가 된 것이다.

`runtime.NumGoroutine()` 델타는 병렬 테스트에서 불안정하므로 이 테스트는
`t.Parallel()`을 쓰지 않는다. 대안으로 `go.uber.org/goleak`이 이미 의존성에 있으면
그쪽이 더 견고하다 — `go/go.mod`를 확인하고 있으면 goleak을 쓴다.

## 테스트

`go/internal/server/repair_leak_test.go`:

- `TestRepairGoroutineExitsOnContextCancel`
- `TestRepairGoroutineExitsOnNormalCompletion`
- `TestRepairWithoutContextStillWorks` (`context.Background()` 경로)

```bash
cd go && go test ./internal/server/ -run Repair -count=1 -v
cd go && go test ./internal/server/ -race -run Repair -count=1
cd go && go build ./... && go vet ./... && go test ./... -count=1
```

`-race`를 반드시 돈다 — 파이프 양쪽을 두 고루틴이 만지는 변경이다.

## 위험

- **감시 고루틴이 새 누수원이 될 수 있다.** `writerDone` 채널이 정확히 한 번 닫히는지,
  `ctx.Done() == nil`일 때 감시를 안 만드는지가 핵심이다. 위 두 번째 테스트가 이것을 고정한다.
- `reader.CloseWithError`를 소비자가 읽는 도중에 부르면 소비자는 에러를 본다.
  이는 의도된 동작이다(요청이 취소됐다). 다만 취소가 아닌 정상 종료에서 이 에러가
  새어나가면 안 되므로, 에러 분류가 `context.Canceled`를 이미 걸러내는지
  `responses_core_port.go:809` 부근의 처리를 확인한다.
- 기존 `repair_test.go`가 있으면 공개 API 위임이 그대로 통과해야 한다. 먼저 초록 확인 후 시작.

## 완료 기준

취소 시 고루틴이 회수되고, 정상 종료 시에도 감시 고루틴이 남지 않으며,
`-race`가 초록이고, 수정 전 첫 테스트가 타임아웃하는 것을 기록으로 남긴다.
