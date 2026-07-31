# 080 — work-phase 9: 일반 SSE 경로 이벤트별 flush

근거: `002`의 남은 구멍 2번. 이 구멍은 CLIProxyAPI가 우리보다 나은 몇 안 되는 지점이다.

## 문제

두 스트리밍 경로가 있고 한쪽만 flush한다.

**eager relay는 정상이다.** `go/internal/server/relay.go`는 청크마다 flush하고
keepalive도 flush한다:

```go
			if _, err := w.Write(chunk.data); err != nil {
				return err
			}
			if flusher != nil {
				flusher.Flush()
			}
```

컨텍스트 취소도 처리한다(`relay.go:104-105`: `case <-ctx.Done(): return ctx.Err()`).

**bridge 경로는 flush하지 않는다.** 원인은 래퍼다.

`bridge.Stream`/`StreamWithOptions`는 `io.Writer`를 받고
(`go/internal/bridge/bridge.go:161`, `:167`), `writeSSE`도 마찬가지다
(`go/internal/bridge/response_format.go:48`):

```go
func writeSSE(w io.Writer, event Event) error {
	data, err := marshalResponseEvent(event)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, data)
	return err
}
```

여기서 flush 호출이 없다. 다만 **`io.Writer`라는 타입 자체가 원인은 아니다** —
Go의 인터페이스 변환은 동적 타입의 메서드 집합을 지우지 않으므로,
`w`가 실제로 `http.Flusher`면 타입 어서션으로 되찾을 수 있다.

진짜 손실 지점은 `sseInspectionWriter`다(`go/internal/server/responses_core_port.go:932-943`).
`Write`만 구현하므로 이 래퍼를 통과하는 순간 `Flush`가 사라진다:

```go
type sseInspectionWriter struct {
	writer    io.Writer
	inspector *SSEInspector
}

func (writer *sseInspectionWriter) Write(payload []byte) (int, error) {
	written, err := writer.writer.Write(payload)
	if written > 0 {
		writer.inspector.Consume(payload[:written])
	}
	return written, err
}
```

이 래퍼는 `responseStateEligible`이 참일 때만 생성된다
(`responses_core_port.go:793-799`). 즉 **래퍼가 붙는 경로만 고장나 있고**,
붙지 않는 경로는 `writeSSE`에 flush만 추가하면 바로 살아난다.

호출자는 셋이다(`rg -n "bridge\.Stream"`):
`go/internal/search/loop.go:372`, `go/internal/server/responses_core_port.go:802`,
`go/internal/server/image_bridge.go:218`.

## 사용자 증상

응답이 도착하는 대로 흐르지 않고 버퍼가 찰 때까지 뭉친다. 사용자에게는 "첫 토큰이 늦다",
"스트리밍이 끊긴다"로 보이고, 원인을 네트워크나 프로바이더로 오해하기 쉽다.
`firstOutputMs`는 우리가 쓰기 시작한 시점을 재므로 이 지연을 **측정하지 못한다**.

## 파일 변경 지도

| 파일 | 종류 | 위치 |
| --- | --- | --- |
| `go/internal/bridge/response_format.go` | MODIFY | `writeSSE`에 flush 후처리 |
| `go/internal/bridge/bridge.go` | MODIFY | 이벤트 쓰기 지점(약 208-219) |
| `go/internal/server/responses_core_port.go` | MODIFY | `sseInspectionWriter`(932-943)에 `Flush` 위임 추가 |
| `go/internal/server/image_bridge.go` | MODIFY | 호출부 writer 전달(218) |
| `go/internal/search/loop.go` | MODIFY | 호출부 writer 전달(372) |
| `go/internal/bridge/flush_test.go` | NEW | 이벤트별 flush 회귀 |

## 변경 1 — flush 능력을 타입으로 보존

시그니처를 `http.ResponseWriter`로 바꾸지 않는다. bridge는 HTTP를 몰라야 하고,
테스트가 `bytes.Buffer`를 넘기는 곳이 있다. 대신 선택적 인터페이스를 쓴다.

`go/internal/bridge/response_format.go`:

```go
// flusher mirrors http.Flusher without importing net/http here: an SSE writer
// that cannot flush turns every event into a buffered write, which is why the
// eager relay (server/relay.go) streams correctly and this path did not.
type flusher interface{ Flush() }

func flushWriter(w io.Writer) {
	if f, ok := w.(flusher); ok {
		f.Flush()
	}
}

func writeSSE(w io.Writer, event Event) error {
	data, err := marshalResponseEvent(event)
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, data); err != nil {
		return err
	}
	flushWriter(w)
	return nil
}
```

`writeSSE` 안에서 flush하면 모든 호출 지점이 자동으로 덮인다 — 호출부를 일일이 고치는
것보다 누락 위험이 낮다.

## 변경 2 — 래퍼가 능력을 버리지 않게 (A 감사 정정)

초안은 `writer := io.Writer(w)`(`responses_core_port.go:792`)가 `Flush`를 지운다고 썼다.
**그건 틀렸다.** Go의 인터페이스 변환은 동적 타입의 메서드 집합을 지우지 않는다 —
`w`가 실제로 `http.Flusher`면 `io.Writer`에 담아도 타입 어서션으로 되찾을 수 있다.

진짜 손실 지점은 **래퍼**다(`responses_core_port.go:799`):

```go
		writer = &sseInspectionWriter{writer: w, inspector: stateInspector}
```

`sseInspectionWriter`는 `Write`만 구현한다(`responses_core_port.go:932-943`):

```go
type sseInspectionWriter struct {
	writer    io.Writer
	inspector *SSEInspector
}

func (writer *sseInspectionWriter) Write(payload []byte) (int, error) {
	written, err := writer.writer.Write(payload)
	if written > 0 {
		writer.inspector.Consume(payload[:written])
	}
	return written, err
}
```

이 래퍼를 통과하는 순간 `Flush`가 사라진다. 따라서 고칠 것은 `io.Writer(w)` 줄이 아니라
**래퍼의 메서드 집합**이다. `flushPassthrough`는 불필요하므로 계획에서 뺀다.

```go
// Forward Flush so SSE inspection does not disable per-event flushing: the
// wrapper only implemented Write, which silently downgraded the stream to
// buffered writes (A-phase audit, devlog 260729 080).
func (writer *sseInspectionWriter) Flush() {
	if flusher, ok := writer.writer.(interface{ Flush() }); ok {
		flusher.Flush()
	}
}
```

`writer.writer`는 원본 `w`이므로(`:799`) 위임이 성립한다.

**남은 확인**: `responseStateEligible`이 거짓이면 래퍼가 없고 `w`가 그대로 전달되므로
`writeSSE`의 타입 어서션이 바로 성공한다. 즉 **래퍼 경로만 고장나 있었다**.
`image_bridge.go:218`과 `search/loop.go:372`가 넘기는 writer도 각각 어떤 래퍼를
거치는지 확인하고, 래퍼가 있으면 같은 위임을 추가한다.

## 변경 3 — 연결 끊김

bridge는 이미 쓰기 오류로 중단한다(`bridge.go:216-217`: `if err := writeSSE(...); err != nil { return err }`).
컨텍스트 취소 처리 여부를 `bridge.go`의 select 루프에서 확인하고, relay와 달리
`case <-ctx.Done()`이 없으면 추가한다. 있으면 변경 없음 — 없는 것을 만들지 않는다.

## 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

"flush가 호출됐다"를 **관측 가능하게** 만든다. flush 횟수를 세는 테스트 writer를 쓴다.

```go
type countingFlushWriter struct {
	bytes.Buffer
	flushes int
	marks   []int // buffer length at each flush
}
func (c *countingFlushWriter) Flush() { c.flushes++; c.marks = append(c.marks, c.Len()) }
```

트리거: 이벤트 3개를 채널로 흘려보내고 `StreamWithOptions`를 돌린다.
발화 증명:

1. `flushes >= 3` — 이벤트마다 flush가 발화했다.
2. `marks`가 **단조 증가**하고 각 mark가 서로 다르다 — 마지막에 한 번 몰아서 flush한 게
   아니라 이벤트 경계마다 flush했다는 증거. (`marks == [n,n,n]`이면 몰아친 것이다.)
3. 수정 전에는 `flushes == 0`이므로 테스트가 결함을 재현한다.

능력 보존 증명(변경 2가 실제로 효과가 있는지): 테스트가 **반드시
`sseInspectionWriter` 경로를 강제해야 한다**. 그러지 않으면 래퍼 없는 경로를 타서
변경 2가 없어도 통과하는 순환 테스트가 된다(A 감사 지적).

- `responseStateEligible`이 참이 되도록 요청/설정을 구성해 `:799`의 래퍼가 실제로 생성되게 한다.
- `w` 자리에 flush 카운터를 넣고 이벤트 3개를 흘린 뒤 `flushes >= 3`을 단언한다.
- `sseInspectionWriter.Flush` 위임을 제거하면 이 테스트가 `flushes == 0`으로 실패해야 한다.
  래퍼를 강제하지 않은 테스트는 이 조건을 만족하지 못하므로, 강제 여부 자체를
  별도 단언으로 확인한다(래퍼 타입이 실제로 쓰였는지).

## 테스트

`go/internal/bridge/flush_test.go`:

- `TestWriteSSEFlushesEachEvent`
- `TestStreamFlushBoundariesAreDistinct` (marks 단조 증가)
- `TestNonFlushableWriterIsNoop` (`bytes.Buffer`로 패닉 없음)

`go/internal/server/`:

- `TestResponsesStreamPreservesFlusher` (능력 보존 증명)

```bash
cd go && go test ./internal/bridge/... ./internal/server/... -count=1 -v
cd go && go build ./... && go vet ./... && go test ./... -count=1
```

## 위험

- **과도한 flush.** 이벤트마다 syscall이 늘어난다. SSE는 원래 그런 프로토콜이고
  relay가 이미 그렇게 한다(`relay.go:136-140`). 대량 소형 이벤트가 문제되면
  relay와 같은 정책을 쓰되, 이 사이클에서 임의로 배칭을 도입하지 않는다.
- `search/loop.go:372`의 writer가 HTTP가 아니면 no-op이다. 의도된 동작이며
  `TestNonFlushableWriterIsNoop`이 이를 고정한다.
- `sseInspectionWriter`에 `Flush()`를 붙이면 인터페이스 만족 여부가 바뀐다.
  다른 곳에서 타입 스위치로 분기하는지 `rg -n "sseInspectionWriter"`로 확인한다.

## 완료 기준

이벤트 3개에 flush 3회 이상, flush 경계가 서로 다르고, 실제 서빙 경로에서도
카운터가 증가한다. 수정 전 두 테스트가 실패하는 것을 확인한 기록을 D에 남긴다.
