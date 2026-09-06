package sidecar

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
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

func TestResponsesSSEItemIDRepairCarriesMappingAcrossOneStream(t *testing.T) {
	p := responseRepairPipeline{itemIDs: newItemIDRepairState(itemIDRepairConfig{invalid: true, message: map[string]bool{}, reasoning: map[string]bool{}})}
	input := "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"bare-upstream\"}}\n\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"bare-upstream\",\"delta\":\"hi\"}\n\ndata: {\"type\":\"response.completed\"}\n\n"
	got, _ := rewriteSSEInChunksWithPipeline(t, input, []int{17, 9, len(input)}, p)
	if bytes.Contains([]byte(got), []byte("bare-upstream")) {
		t.Fatalf("raw id leaked: %s", got)
	}
	if bytes.Count([]byte(got), []byte("msg_ocx_")) != 2 {
		t.Fatalf("item and delta must share one canonical id: %s", got)
	}
}

func TestResponsesSSEItemIDRepairRewritesTerminalSnapshotWithoutOutputIndex(t *testing.T) {
	p := responseRepairPipeline{itemIDs: newItemIDRepairState(itemIDRepairConfig{invalid: true, message: map[string]bool{}, reasoning: map[string]bool{}})}
	input := "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"id\":\"bare-id\"}]}}\n\n"
	got, _ := rewriteSSEInChunksWithPipeline(t, input, []int{len(input)}, p)
	if strings.Contains(got, "bare-id") || !strings.Contains(got, "msg_ocx_") {
		t.Fatalf("terminal snapshot id was not repaired: %s", got)
	}
}

func TestResponsesSSESnapshotRepairClosesOpenMessageBeforeTerminal(t *testing.T) {
	p := responseRepairPipeline{snapshot: newSnapshotRepairState(true, nil)}
	input := "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg_a\"}}\n\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"msg_a\",\"delta\":\"hi\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
	got, _ := rewriteSSEInChunksWithPipeline(t, input, []int{len(input)}, p)
	for _, expected := range []string{"response.content_part.added", "response.output_text.done", "response.content_part.done", "response.output_item.done"} {
		if !bytes.Contains([]byte(got), []byte(expected)) {
			t.Fatalf("missing %s: %s", expected, got)
		}
	}
	if bytes.Index([]byte(got), []byte("response.output_item.done")) > bytes.Index([]byte(got), []byte("response.completed")) {
		t.Fatalf("completion injected after terminal: %s", got)
	}
}

func TestResponsesSSESnapshotRepairUsesRequestDefaultsAndRebuildsTerminalOutput(t *testing.T) {
	request, err := jsonwire.Parse([]byte("{\"parallel_tool_calls\":false,\"tool_choice\":{\"type\":\"function\",\"name\":\"search\"},\"tools\":[{\"type\":\"function\",\"name\":\"search\"}]}"))
	if err != nil {
		t.Fatal(err)
	}
	p := responseRepairPipeline{snapshot: newSnapshotRepairState(true, request)}
	input := "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}\n\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg_a\"}}\n\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"msg_a\",\"delta\":\"hi\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\"}}\n\n"
	got, _ := rewriteSSEInChunksWithPipeline(t, input, []int{len(input)}, p)
	if !bytes.Contains([]byte(got), []byte("\"parallel_tool_calls\":false")) || !bytes.Contains([]byte(got), []byte("\"tool_choice\":{\"type\":\"function\",\"name\":\"search\"}")) {
		t.Fatalf("request defaults missing: %s", got)
	}
	terminalAt := bytes.LastIndex([]byte(got), []byte("\"type\":\"response.completed\""))
	if terminalAt < 0 {
		t.Fatalf("no terminal: %s", got)
	}
	if !bytes.Contains([]byte(got[terminalAt:]), []byte("\"output\":[{\"type\":\"message\",\"id\":\"msg_a\",\"status\":\"completed\"")) {
		t.Fatalf("terminal did not reconstruct output: %s", got)
	}
}

func TestResponseRepairPipelineSnapshotJSONUsesRequestDefaults(t *testing.T) {
	request, err := jsonwire.Parse([]byte("{\"parallel_tool_calls\":false,\"tool_choice\":{\"type\":\"function\",\"name\":\"search\"},\"tools\":[{\"type\":\"function\",\"name\":\"search\"}]}"))
	if err != nil {
		t.Fatal(err)
	}
	p := responseRepairPipeline{snapshot: newSnapshotRepairState(true, request)}
	got, changed := p.repairJSON([]byte("{\"id\":\"r\",\"output\":\"bad\"}"))
	if !changed {
		t.Fatal("snapshot JSON should repair")
	}
	want := "{\"id\":\"r\",\"output\":[],\"parallel_tool_calls\":false,\"tool_choice\":{\"type\":\"function\",\"name\":\"search\"},\"tools\":[{\"type\":\"function\",\"name\":\"search\"}],\"status\":\"completed\"}"
	if string(got) != want {
		t.Fatalf("got %s\nwant %s", got, want)
	}
}

func TestResponsesSSESnapshotRepairRetainsClosedItemsForTerminalReconstruction(t *testing.T) {
	p := responseRepairPipeline{snapshot: newSnapshotRepairState(true, nil)}
	input := "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg_0\"}}\n\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg_0\"}}\n\ndata: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"message\",\"id\":\"msg_1\"}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\"}}\n\n"
	got, _ := rewriteSSEInChunksWithPipeline(t, input, []int{len(input)}, p)
	terminalAt := bytes.LastIndex([]byte(got), []byte("\"type\":\"response.completed\""))
	terminal := got[terminalAt:]
	if !strings.Contains(terminal, "\"id\":\"msg_0\"") || !strings.Contains(terminal, "\"id\":\"msg_1\"") {
		t.Fatalf("terminal lost a completed item: %s", got)
	}
}

func TestResponsesSSESnapshotRepairFailsClosedOnContradictoryIdentity(t *testing.T) {
	for _, fixture := range []string{
		"data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg_a\"}}\n\ndata: {\"type\":\"response.output_text.done\",\"output_index\":0,\"item_id\":\"msg_other\",\"text\":\"x\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\"}}\n\n",
		"data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg_a\"}}\n\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg_b\"}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\"}}\n\n",
	} {
		got, _ := rewriteSSEInChunksWithPipeline(t, fixture, []int{len(fixture)}, responseRepairPipeline{snapshot: newSnapshotRepairState(true, nil)})
		if strings.Contains(got, "response.output_item.done") {
			t.Fatalf("tainted stream synthesized a terminal item: %s", got)
		}
	}
}

func rewriteSSEInChunksWithPipeline(t *testing.T, input string, chunks []int, pipeline responseRepairPipeline) (string, *ResponsesSSEStream) {
	t.Helper()
	stream := NewResponsesSSEStream(pipeline)
	var out bytes.Buffer
	position := 0
	for _, size := range chunks {
		if position >= len(input) {
			break
		}
		end := position + size
		if end > len(input) {
			end = len(input)
		}
		got, err := stream.Feed([]byte(input[position:end]))
		if err != nil {
			t.Fatal(err)
		}
		out.Write(got)
		position = end
	}
	if position < len(input) {
		got, err := stream.Feed([]byte(input[position:]))
		if err != nil {
			t.Fatal(err)
		}
		out.Write(got)
	}
	tail, err := stream.Finish()
	if err != nil {
		t.Fatal(err)
	}
	out.Write(tail)
	return out.String(), stream
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
