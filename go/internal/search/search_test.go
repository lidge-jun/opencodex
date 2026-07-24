package search

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestSyntheticTool(t *testing.T) {
	tool := SyntheticTool()
	if tool.Name != ToolName || tool.Parameters["type"] != "object" {
		t.Fatalf("unexpected tool: %#v", tool)
	}
	properties, ok := tool.Parameters["properties"].(map[string]any)
	if !ok || properties["query"] == nil || properties["queries"] == nil {
		t.Fatalf("missing query alternatives: %#v", tool.Parameters)
	}
}

func TestFormatResultBoundsAndTrustBoundary(t *testing.T) {
	sources := make([]Source, 10)
	for index := range sources {
		sources[index] = Source{URL: "https://example.com/" + string(rune('a'+index))}
	}
	formatted := FormatResult("<unsafe>", Result{Text: strings.Repeat("x", 5000), Sources: sources}, false)
	if strings.Contains(formatted, "<unsafe>") || !strings.Contains(formatted, "UNTRUSTED") || !strings.Contains(formatted, "[8]") || strings.Contains(formatted, "[9]") {
		t.Fatalf("unexpected formatted result: %s", formatted)
	}
}

type scriptedRunner struct{ calls int }

func (runner *scriptedRunner) Run(_ context.Context, _ *types.NormalizedRequest, _ types.Adapter) (TurnResult, error) {
	runner.calls++
	arguments, _ := json.Marshal(map[string]any{"query": "always search"})
	return TurnResult{StatusCode: 200, Events: []types.AdapterEvent{{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: "call", Name: ToolName, Arguments: arguments}}, {Type: types.EventDone}}}, nil
}

type noOpAdapter struct{}

func (noOpAdapter) BuildRequest(context.Context, *types.NormalizedRequest) (*http.Request, error) {
	panic("not used")
}
func (noOpAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	panic("not used")
}
func (noOpAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	panic("not used")
}

type fixedExecutor struct{}

func (fixedExecutor) Search(context.Context, string, map[string]any) (Result, error) {
	return Result{Text: "answer"}, nil
}

func TestLoopIterationBoundForcesFinalPass(t *testing.T) {
	runner := &scriptedRunner{}
	loop := Loop{Runner: runner, Executor: fixedExecutor{}, MaxSearches: 2, MaxIterations: 4}
	request := &types.NormalizedRequest{ModelID: "test", Context: types.RequestContext{Tools: []types.Tool{SyntheticTool()}}}
	events, err := loop.Run(context.Background(), request, noOpAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	if runner.calls != 3 {
		t.Fatalf("runner calls = %d, want 3", runner.calls)
	}
	if len(events) != 1 || events[0].Type != types.EventDone {
		t.Fatalf("unexpected final events: %#v", events)
	}
}

func TestProgressStreamInjectsHeartbeat(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	stream := NewProgressStream(context.Background(), reader, ProgressOptions{HeartbeatInterval: 10 * time.Millisecond, InactivityTimeout: time.Second})
	defer stream.Close()
	buffer := make([]byte, 128)
	n, err := stream.Read(buffer)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(buffer[:n]); got != ": opencodex web-search progress\n\n" {
		t.Fatalf("heartbeat = %q", got)
	}
}

func TestParseOpenAISSEPrefersCompletedOutputAndCitations(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"type":"response.output_text.delta","delta":"draft"}`,
		"",
		`data: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.com","title":"Example"}}`,
		"",
		`data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"final","annotations":[]}]}]}}`,
		"",
	}, "\n")
	result, err := ParseOpenAISSE(strings.NewReader(stream))
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "final" || len(result.Sources) != 1 || result.Sources[0].URL != "https://example.com" {
		t.Fatalf("unexpected result: %#v", result)
	}
}
