package sidecar

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type responsesSSEGolden struct {
	Name     string `json:"name"`
	Upstream string `json:"upstream"`
	Client   string `json:"client"`
}

func loadResponsesSSEGoldens(t *testing.T) []responsesSSEGolden {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "responses-sse-goldens.json"))
	if err != nil {
		t.Fatalf("read goldens: %v", err)
	}
	var goldens []responsesSSEGolden
	if err := json.Unmarshal(raw, &goldens); err != nil {
		t.Fatalf("decode goldens: %v", err)
	}
	if len(goldens) == 0 {
		t.Fatal("golden file is empty")
	}
	return goldens
}

func rewriteSSEInChunks(t *testing.T, input string, chunks []int) (string, *ResponsesSSEStream) {
	t.Helper()
	stream := NewResponsesSSEStream()
	var out bytes.Buffer
	position := 0
	for _, size := range chunks {
		if position == len(input) {
			break
		}
		end := position + size
		if end > len(input) {
			end = len(input)
		}
		got, err := stream.Feed([]byte(input[position:end]))
		if err != nil {
			t.Fatalf("feed at byte %d: %v", position, err)
		}
		out.Write(got)
		position = end
	}
	if position != len(input) {
		got, err := stream.Feed([]byte(input[position:]))
		if err != nil {
			t.Fatalf("final feed: %v", err)
		}
		out.Write(got)
	}
	got, err := stream.Finish()
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	out.Write(got)
	return out.String(), stream
}

// TestResponsesSSEGoldens runs every row captured from the TypeScript stream
// oracle. The one-byte pass proves no transport chunk is treated as an event
// boundary, including CRLF delimiters split across reads and terminal frames
// with no trailing blank line.
func TestResponsesSSEGoldens(t *testing.T) {
	for _, golden := range loadResponsesSSEGoldens(t) {
		golden := golden
		t.Run(golden.Name, func(t *testing.T) {
			whole, stream := rewriteSSEInChunks(t, golden.Upstream, []int{len(golden.Upstream)})
			if whole != golden.Client {
				t.Fatalf("whole rewrite diverged from TS oracle\n got: %q\nwant: %q", whole, golden.Client)
			}
			_ = stream
			chunks := make([]int, len(golden.Upstream))
			for index := range chunks {
				chunks[index] = 1
			}
			fragmented, _ := rewriteSSEInChunks(t, golden.Upstream, chunks)
			if fragmented != golden.Client {
				t.Fatalf("one-byte rewrite diverged from TS oracle\n got: %q\nwant: %q", fragmented, golden.Client)
			}
		})
	}
}

func TestResponsesSSEBoundaryDropsPostTerminalEventsButKeepsDone(t *testing.T) {
	input := "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\nevent: ignored\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"late\"}\n\ndata: [DONE]\n\n"
	got, stream := rewriteSSEInChunks(t, input, []int{len(input)})
	if !stream.TerminalSeen() || !stream.DoneSeen() {
		t.Fatalf("terminal=%v done=%v, want true true", stream.TerminalSeen(), stream.DoneSeen())
	}
	if bytes.Contains([]byte(got), []byte("late")) {
		t.Fatalf("late event crossed terminal boundary: %q", got)
	}
	if !bytes.Contains([]byte(got), []byte("data: [DONE]")) {
		t.Fatalf("done after terminal missing: %q", got)
	}
}

func TestResponsesSSEBoundaryHoldsPrematureDoneUntilTerminal(t *testing.T) {
	input := "data: [DONE]\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
	got, _ := rewriteSSEInChunks(t, input, []int{12, len(input)})
	terminal := bytes.Index([]byte(got), []byte("response.completed"))
	done := bytes.Index([]byte(got), []byte("data: [DONE]"))
	if terminal < 0 || done < terminal {
		t.Fatalf("premature done leaked before terminal: %q", got)
	}
}

func TestResponsesSSEBlockLimit(t *testing.T) {
	stream := NewResponsesSSEStream()
	_, err := stream.Feed(bytes.Repeat([]byte("x"), maxResponsesSSEBlockBytes+1))
	if !errors.Is(err, errResponsesSSEBlockTooLarge) {
		t.Fatalf("error = %v, want block limit", err)
	}
}

func TestResponsesSSEFinishPartialDoesNotInventTerminal(t *testing.T) {
	stream := NewResponsesSSEStream()
	if _, err := stream.Feed([]byte("event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"partial\"}]}}")); err != nil {
		t.Fatal(err)
	}
	partial, err := stream.FinishPartial()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(partial, []byte("adapter_eof")) || bytes.Contains(partial, []byte("[DONE]")) {
		t.Fatalf("partial finish invented a terminal: %q", partial)
	}
	if !bytes.Contains(partial, []byte("annotations")) || !bytes.Contains(partial, []byte("msg_ocx_0")) {
		t.Fatalf("partial tail was not rewritten: %q", partial)
	}
}

func TestResponsesSSEMalformedOutputIndexUsesProcessGlobalFallback(t *testing.T) {
	start := syntheticSSEItemOrdinal.Load()
	input := "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"message\",\"content\":[]}}\n\n"
	first, _ := rewriteSSEInChunks(t, input, []int{len(input)})
	second, _ := rewriteSSEInChunks(t, input, []int{len(input)})
	firstID := "msg_ocx_fallback_" + itoa(int(start+1))
	secondID := "msg_ocx_fallback_" + itoa(int(start+2))
	if !bytes.Contains([]byte(first), []byte(firstID)) || !bytes.Contains([]byte(second), []byte(secondID)) {
		t.Fatalf("fallback IDs = %q, %q; want %q, %q", first, second, firstID, secondID)
	}
}

func TestResponsesSSEOutputIndexUsesNumberIsIntegerSemantics(t *testing.T) {
	cases := map[string]string{"1.0": "1", "1e0": "1", "1e3": "1000"}
	for index, slot := range cases {
		t.Run(index, func(t *testing.T) {
			input := "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":" + index + ",\"item\":{\"type\":\"message\",\"content\":[]}}\n\n"
			got, _ := rewriteSSEInChunks(t, input, []int{len(input)})
			want := "msg_ocx_" + slot
			if !bytes.Contains([]byte(got), []byte(want)) {
				t.Fatalf("output = %q, want %q", got, want)
			}
		})
	}
}
