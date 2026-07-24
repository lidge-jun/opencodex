package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/bridge"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type TurnResult struct {
	Events     []types.AdapterEvent
	StatusCode int
	RetryAfter string
}

type TurnRunner interface {
	Run(ctx context.Context, request *types.NormalizedRequest, adapter types.Adapter) (TurnResult, error)
}

type HTTPRunner struct {
	Client   *http.Client
	Progress ProgressOptions
}

func (r HTTPRunner) Run(ctx context.Context, request *types.NormalizedRequest, adapter types.Adapter) (TurnResult, error) {
	upstream, err := adapter.BuildRequest(ctx, request)
	if err != nil {
		return TurnResult{}, err
	}
	client := r.Client
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(upstream)
	if err != nil {
		return TurnResult{}, err
	}
	if response.StatusCode == http.StatusTooManyRequests {
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return TurnResult{StatusCode: response.StatusCode, RetryAfter: response.Header.Get("Retry-After")}, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		return TurnResult{}, responseError(response)
	}
	progress := NewProgressStream(ctx, response.Body, r.Progress)
	defer progress.Close()
	events := make([]types.AdapterEvent, 0, 16)
	for event := range adapter.ParseStream(ctx, progress) {
		events = append(events, event)
	}
	return TurnResult{Events: events, StatusCode: response.StatusCode}, nil
}

type RotateAdapter func(ctx context.Context, retryAfter string) (types.Adapter, bool)

type Loop struct {
	Runner        TurnRunner
	Executor      Executor
	HostedTool    map[string]any
	MaxSearches   int
	MaxIterations int
	MaxRotations  int
	Rotate429     RotateAdapter
	Structured    bool
}

func (loop Loop) Run(ctx context.Context, request *types.NormalizedRequest, adapter types.Adapter) ([]types.AdapterEvent, error) {
	if request == nil || adapter == nil {
		return nil, fmt.Errorf("web-search loop requires a request and adapter")
	}
	runner := loop.Runner
	if runner == nil {
		runner = HTTPRunner{}
	}
	maxSearches := loop.MaxSearches
	if maxSearches <= 0 {
		maxSearches = 3
	}
	maxIterations := loop.MaxIterations
	if maxIterations <= 0 {
		maxIterations = maxSearches + 2
	}
	working := cloneRequest(request)
	working.RawBody = nil
	failedQueries := make(map[string]bool)
	searches := 0

	for iteration := 0; iteration < maxIterations; iteration++ {
		forceAnswer := searches >= maxSearches || iteration == maxIterations-1
		turnRequest := cloneRequest(working)
		turnRequest.Stream = true
		if forceAnswer {
			turnRequest.Context.Tools = withoutWebSearch(turnRequest.Context.Tools)
			turnRequest.Context.Messages = append(turnRequest.Context.Messages, forcedAnswerMessage())
		}
		turn, nextAdapter, err := loop.runTurn(ctx, runner, turnRequest, adapter)
		adapter = nextAdapter
		if err != nil {
			return nil, err
		}
		calls, passthrough, realTool, err := scanSearchCalls(turn.Events)
		if err != nil {
			return nil, err
		}
		if forceAnswer || len(calls) == 0 || realTool {
			return passthrough, nil
		}

		for _, call := range calls {
			results := make([]QueryResult, 0, max(1, len(call.Queries)))
			if len(call.Queries) == 0 {
				searches++
				results = append(results, QueryResult{Result: Result{Error: "the model called web_search with an empty query"}})
			}
			for _, query := range call.Queries {
				normalized := normalizeQuery(query)
				var result Result
				switch {
				case failedQueries[normalized]:
					result.Error = "this query already failed earlier in the turn; answer from existing context"
				case searches >= maxSearches:
					result.Error = "web search limit reached for this turn; answer from results already gathered"
				case loop.Executor == nil:
					result.Error = "web search sidecar is not configured"
				default:
					result, err = loop.Executor.Search(ctx, query, loop.HostedTool)
					searches++
					if err != nil {
						result = Result{Error: safeSearchError(err)}
					}
					if result.Error != "" {
						failedQueries[normalized] = true
					}
				}
				results = append(results, QueryResult{Query: query, Result: result})
			}
			appendSearchExchange(working, call, results, loop.Structured)
		}
	}
	return nil, fmt.Errorf("web-search loop exceeded %d iterations", maxIterations)
}

func (loop Loop) runTurn(ctx context.Context, runner TurnRunner, request *types.NormalizedRequest, adapter types.Adapter) (TurnResult, types.Adapter, error) {
	rotations := 0
	maxRotations := loop.MaxRotations
	if maxRotations <= 0 {
		maxRotations = 8
	}
	for {
		turn, err := runner.Run(ctx, request, adapter)
		if err != nil {
			return TurnResult{}, adapter, err
		}
		if turn.StatusCode != http.StatusTooManyRequests || loop.Rotate429 == nil || rotations >= maxRotations {
			if turn.StatusCode == http.StatusTooManyRequests {
				return TurnResult{}, adapter, &HTTPError{StatusCode: turn.StatusCode}
			}
			return turn, adapter, nil
		}
		rotated, ok := loop.Rotate429(ctx, turn.RetryAfter)
		if !ok || rotated == nil {
			return TurnResult{}, adapter, &HTTPError{StatusCode: turn.StatusCode}
		}
		adapter = rotated
		rotations++
	}
}

type searchCall struct {
	ID      string
	Queries []string
}

func scanSearchCalls(events []types.AdapterEvent) ([]searchCall, []types.AdapterEvent, bool, error) {
	calls := make([]searchCall, 0)
	passthrough := make([]types.AdapterEvent, 0, len(events))
	realTool := false
	terminal := 0
	for _, event := range events {
		switch event.Type {
		case types.EventToolCall:
			if event.ToolCall == nil {
				continue
			}
			if event.ToolCall.Name == ToolName {
				calls = append(calls, searchCall{ID: event.ToolCall.ID, Queries: parseQueries(event.ToolCall.Arguments)})
			} else {
				realTool = true
				passthrough = append(passthrough, event)
			}
		case types.EventDone:
			terminal++
			passthrough = append(passthrough, event)
		case types.EventError:
			return nil, nil, false, errors.New(event.Error)
		default:
			passthrough = append(passthrough, event)
		}
	}
	if terminal != 1 {
		return nil, nil, false, fmt.Errorf("web-search adapter stream requires one terminal event, got %d", terminal)
	}
	return calls, passthrough, realTool, nil
}

func parseQueries(arguments json.RawMessage) []string {
	var input struct {
		Query   string   `json:"query"`
		Queries []string `json:"queries"`
	}
	if json.Unmarshal(arguments, &input) != nil {
		return nil
	}
	queries := input.Queries
	if len(queries) == 0 && strings.TrimSpace(input.Query) != "" {
		queries = []string{input.Query}
	}
	output := queries[:0]
	for _, query := range queries {
		if strings.TrimSpace(query) != "" {
			output = append(output, query)
		}
	}
	return output
}

func appendSearchExchange(request *types.NormalizedRequest, call searchCall, results []QueryResult, structured bool) {
	arguments := map[string]any{"query": ""}
	if len(call.Queries) > 1 {
		arguments = map[string]any{"queries": call.Queries}
	} else if len(call.Queries) == 1 {
		arguments["query"] = call.Queries[0]
	}
	assistantContent, _ := json.Marshal([]any{map[string]any{"type": "toolCall", "id": call.ID, "name": ToolName, "arguments": arguments}})
	resultContent, _ := json.Marshal(FormatResults(results, structured))
	allFailed := true
	for _, result := range results {
		if result.Result.Error == "" {
			allFailed = false
			break
		}
	}
	now := time.Now().UnixMilli()
	request.Context.Messages = append(request.Context.Messages,
		types.Message{Role: "assistant", Content: assistantContent, Timestamp: now},
		types.Message{Role: "toolResult", Content: resultContent, ToolCallID: call.ID, ToolName: ToolName, IsError: allFailed, Timestamp: now},
	)
}

func cloneRequest(request *types.NormalizedRequest) *types.NormalizedRequest {
	clone := *request
	clone.RawBody = append(json.RawMessage(nil), request.RawBody...)
	clone.Metadata = cloneStrings(request.Metadata)
	clone.Context.SystemPrompt = append([]string(nil), request.Context.SystemPrompt...)
	clone.Context.Messages = append([]types.Message(nil), request.Context.Messages...)
	clone.Context.Tools = append([]types.Tool(nil), request.Context.Tools...)
	return &clone
}

func cloneStrings(input map[string]string) map[string]string {
	if input == nil {
		return nil
	}
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}
func withoutWebSearch(tools []types.Tool) []types.Tool {
	output := make([]types.Tool, 0, len(tools))
	for _, tool := range tools {
		if tool.Name != ToolName {
			output = append(output, tool)
		}
	}
	return output
}
func normalizeQuery(query string) string {
	return strings.Join(strings.Fields(strings.ToLower(query)), " ")
}
func forcedAnswerMessage() types.Message {
	content, _ := json.Marshal("Answer the user's question now using the web search results already gathered above. Ground the answer in those results and cite only returned sources.")
	return types.Message{Role: "developer", Content: content, Timestamp: time.Now().UnixMilli()}
}
func safeSearchError(err error) string {
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		return fmt.Sprintf("sidecar HTTP %d", httpErr.StatusCode)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "sidecar timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "search cancelled"
	}
	return "sidecar connection error"
}

// SearchMiddleware chooses native passthrough or the synthetic sidecar loop and
// exposes bridge-compatible streaming and buffered entry points.
type SearchMiddleware struct {
	Loop           Loop
	SupportsNative func(model string) bool
}

func NewSearchMiddleware(loop Loop, supportsNative func(model string) bool) *SearchMiddleware {
	return &SearchMiddleware{Loop: loop, SupportsNative: supportsNative}
}

func (middleware SearchMiddleware) Events(ctx context.Context, request *types.NormalizedRequest, adapter types.Adapter) (<-chan types.AdapterEvent, error) {
	prepared, hosted, intercept := prepareSearchRequest(request)
	if !intercept || middleware.SupportsNative != nil && middleware.SupportsNative(request.ModelID) {
		runner := middleware.Loop.Runner
		if runner == nil {
			runner = HTTPRunner{}
		}
		turn, err := runner.Run(ctx, request, adapter)
		if err != nil {
			return nil, err
		}
		if turn.StatusCode < 200 || turn.StatusCode >= 300 {
			return nil, &HTTPError{StatusCode: turn.StatusCode, RetryAfter: turn.RetryAfter}
		}
		return eventChannel(turn.Events), nil
	}
	loop := middleware.Loop
	loop.HostedTool = hosted
	events, err := loop.Run(ctx, prepared, adapter)
	if err != nil {
		return nil, err
	}
	return eventChannel(events), nil
}

func (middleware SearchMiddleware) Stream(ctx context.Context, writer io.Writer, request *types.NormalizedRequest, adapter types.Adapter) error {
	events, err := middleware.Events(ctx, request, adapter)
	if err != nil {
		return err
	}
	return bridge.Stream(ctx, writer, request.ModelID, events)
}

func (middleware SearchMiddleware) Buffered(ctx context.Context, request *types.NormalizedRequest, adapter types.Adapter) (bridge.Response, error) {
	events, err := middleware.Events(ctx, request, adapter)
	if err != nil {
		return bridge.Response{}, err
	}
	return bridge.Buffered(ctx, request.ModelID, events)
}

func prepareSearchRequest(request *types.NormalizedRequest) (*types.NormalizedRequest, map[string]any, bool) {
	if request == nil {
		return nil, nil, false
	}
	hosted, hasHosted := ExtractHostedTool(request.RawBody)
	if !hasHosted && !hasSyntheticTool(request.Context.Tools) {
		return request, nil, false
	}
	prepared := cloneRequest(request)
	prepared.RawBody = nil
	if !hasSyntheticTool(prepared.Context.Tools) {
		prepared.Context.Tools = append(prepared.Context.Tools, SyntheticTool())
	}
	if hosted == nil {
		hosted = map[string]any{"type": ToolName}
	}
	return prepared, hosted, true
}

func eventChannel(events []types.AdapterEvent) <-chan types.AdapterEvent {
	output := make(chan types.AdapterEvent, len(events))
	for _, event := range events {
		output <- event
	}
	close(output)
	return output
}
