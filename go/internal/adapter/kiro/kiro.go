package kiro

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/protocol"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	amzTarget      = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"
	sdkVersion     = "1.0.27"
	nodeVersion    = "22.21.1"
	kiroIDEVersion = "1.0.0"
)

type Adapter struct {
	BaseURL    string
	APIKey     string
	Region     string
	ProfileARN string
	Headers    map[string]string
	Client     *http.Client

	mu   sync.Mutex
	last *requestState
}

type requestState struct {
	req            types.NormalizedRequest
	nameMap        map[string]string
	conversationID string
	mode           CompletionMode
	inputTokens    int
}

var _ types.Adapter = (*Adapter)(nil)

func NewAdapter(baseURL, apiKey string) *Adapter {
	return &Adapter{BaseURL: baseURL, APIKey: apiKey, Region: "us-east-1", Client: http.DefaultClient}
}

func (a *Adapter) BuildRequest(ctx context.Context, req *types.NormalizedRequest) (*http.Request, error) {
	request, state, err := a.buildRequest(ctx, req, "")
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	a.last = state
	a.mu.Unlock()
	return request, nil
}

func (a *Adapter) buildRequest(ctx context.Context, req *types.NormalizedRequest, forced CompletionMode) (*http.Request, *requestState, error) {
	if req == nil {
		return nil, nil, fmt.Errorf("build Kiro request: nil normalized request")
	}
	if strings.TrimSpace(a.APIKey) == "" {
		return nil, nil, fmt.Errorf("kiro token missing — run ocx login kiro")
	}
	payload, nameMap, conversationID, mode, err := BuildPayload(req, a.ProfileARN, forced)
	if err != nil {
		return nil, nil, err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal Kiro request: %w", err)
	}
	endpoint, err := a.endpoint()
	if err != nil {
		return nil, nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, nil, fmt.Errorf("build Kiro request: %w", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+a.APIKey)
	httpReq.Header.Set("Content-Type", "application/x-amz-json-1.0")
	httpReq.Header.Set("Accept", "application/vnd.amazon.eventstream")
	httpReq.Header.Set("X-Amz-Target", amzTarget)
	fp := Fingerprint()
	if len(fp) > 64 {
		fp = fp[:64]
	}
	httpReq.Header.Set("User-Agent", fmt.Sprintf("aws-sdk-go-v2/%s ua/2.1 os/%s lang/go md/go#%s api/codewhispererstreaming#%s m/E KiroIDE-%s-%s", sdkVersion, OSTag(), nodeVersion, sdkVersion, kiroIDEVersion, fp))
	httpReq.Header.Set("X-Amz-User-Agent", fmt.Sprintf("aws-sdk-go-v2/%s KiroIDE-%s-%s", sdkVersion, kiroIDEVersion, fp))
	httpReq.Header.Set("X-Amzn-Codewhisperer-Optout", "true")
	httpReq.Header.Set("X-Amzn-Kiro-Agent-Mode", "vibe")
	httpReq.Header.Set("Amz-Sdk-Invocation-Id", InvocationID())
	if a.ProfileARN != "" {
		httpReq.Header.Set("X-Amzn-Kiro-Profile-Arn", a.ProfileARN)
	}
	for key, value := range a.Headers {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			httpReq.Header.Set(key, value)
		}
	}
	copyReq := *req
	copyReq.Context.Messages = append([]types.Message(nil), req.Context.Messages...)
	return httpReq, &requestState{req: copyReq, nameMap: nameMap, conversationID: conversationID, mode: mode, inputTokens: estimateInputTokens(req)}, nil
}

func (a *Adapter) endpoint() (string, error) {
	region := strings.TrimSpace(a.Region)
	if region == "" {
		region = "us-east-1"
	}
	raw := strings.TrimSpace(a.BaseURL)
	if raw == "" {
		raw = "https://runtime." + region + ".kiro.dev/"
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid Kiro base URL %q", raw)
	}
	if strings.HasPrefix(parsed.Hostname(), "runtime.") && strings.HasSuffix(parsed.Hostname(), ".kiro.dev") && parsed.Path == "/" {
		parsed.Host = "runtime." + region + ".kiro.dev"
	}
	return parsed.String(), nil
}

type toolUse struct {
	Name      string         `json:"name"`
	Input     map[string]any `json:"input"`
	ToolUseID string         `json:"toolUseId"`
}
type toolResult struct {
	Content   []map[string]string `json:"content"`
	Status    string              `json:"status"`
	ToolUseID string              `json:"toolUseId"`
}
type userInput struct {
	Content string            `json:"content"`
	ModelID string            `json:"modelId,omitempty"`
	Origin  string            `json:"origin,omitempty"`
	Context *userInputContext `json:"userInputMessageContext,omitempty"`
	Images  []Image           `json:"images,omitempty"`
}
type userInputContext struct {
	Tools       []map[string]any `json:"tools,omitempty"`
	ToolResults []toolResult     `json:"toolResults,omitempty"`
}
type historyEntry struct {
	User      *userInput         `json:"userInputMessage,omitempty"`
	Assistant *assistantResponse `json:"assistantResponseMessage,omitempty"`
}
type assistantResponse struct {
	Content  string    `json:"content"`
	ToolUses []toolUse `json:"toolUses,omitempty"`
}
type turn struct {
	kind      string
	user      *userInput
	assistant *assistantResponse
}

func BuildPayload(req *types.NormalizedRequest, profileARN string, forced CompletionMode) (map[string]any, map[string]string, string, CompletionMode, error) {
	if req == nil {
		return nil, nil, "", "", fmt.Errorf("build Kiro payload: nil normalized request")
	}
	if err := validateCapabilities(req); err != nil {
		return nil, nil, "", "", err
	}
	modelID := MapModelID(req.ModelID)
	registry := NewToolNameRegistry()
	ordinaryTools, err := ConvertTools(req, registry)
	if err != nil {
		return nil, nil, "", "", err
	}
	mode := forced
	if mode == "" {
		if len(ordinaryTools) > 0 {
			mode = CompletionRequired
		} else {
			mode = CompletionDisabled
		}
	}
	kiroTools := ordinaryTools
	if mode != CompletionDisabled {
		kiroTools = append(append([]map[string]any(nil), ordinaryTools...), completionTool())
	}
	turns := make([]turn, 0)
	calls := map[string]struct{}{}
	pushUser := func(content string, images []Image, results []toolResult) {
		if len(turns) > 0 && turns[len(turns)-1].kind == "user" {
			u := turns[len(turns)-1].user
			u.Content = AppendFallbackText(u.Content, content)
			u.Images = append(u.Images, images...)
			if len(results) > 0 {
				if u.Context == nil {
					u.Context = &userInputContext{}
				}
				u.Context.ToolResults = append(u.Context.ToolResults, results...)
			}
			return
		}
		u := &userInput{Content: content, ModelID: modelID, Origin: "AI_EDITOR", Images: append([]Image(nil), images...)}
		if len(results) > 0 {
			u.Context = &userInputContext{ToolResults: append([]toolResult(nil), results...)}
		}
		turns = append(turns, turn{kind: "user", user: u})
	}
	pushAssistant := func(content string, uses []toolUse) {
		if len(turns) > 0 && turns[len(turns)-1].kind == "assistant" {
			a := turns[len(turns)-1].assistant
			a.Content = AppendFallbackText(a.Content, content)
			a.ToolUses = append(a.ToolUses, uses...)
		} else {
			turns = append(turns, turn{kind: "assistant", assistant: &assistantResponse{Content: content, ToolUses: append([]toolUse(nil), uses...)}})
		}
	}
	for _, message := range req.Context.Messages {
		switch message.Role {
		case "user", "developer":
			pushUser(contentText(message.Content, false), ExtractImages(message.Content), nil)
		case "assistant":
			text, uses, reasoning, err := assistantContent(message.Content, registry)
			if err != nil {
				return nil, nil, "", "", err
			}
			for _, use := range uses {
				if use.ToolUseID == "" {
					return nil, nil, "", "", fmt.Errorf("Kiro history contains a tool call with an empty id")
				}
				if _, exists := calls[use.ToolUseID]; exists {
					return nil, nil, "", "", fmt.Errorf("Kiro history contains duplicate tool call id %q", use.ToolUseID)
				}
				calls[use.ToolUseID] = struct{}{}
			}
			if text != "" || len(uses) > 0 || mode == CompletionTextFallback {
				pushAssistant(text, uses)
			} else if reasoning {
				continue
			}
		case "toolResult", "tool":
			id := NormalizeToolID(message.ToolCallID)
			if _, exists := calls[id]; !exists {
				return nil, nil, "", "", fmt.Errorf("Kiro history contains an orphaned tool result for call %q", message.ToolCallID)
			}
			status := "success"
			if message.IsError {
				status = "error"
			}
			pushUser("", ExtractImages(message.Content), []toolResult{{Content: []map[string]string{{"text": contentText(message.Content, false)}}, Status: status, ToolUseID: id}})
		}
	}
	if mode == CompletionTextFallback && (len(turns) == 0 || turns[len(turns)-1].kind != "assistant") {
		pushAssistant("", nil)
	}
	if len(turns) == 0 || turns[0].kind == "assistant" {
		turns = append([]turn{{kind: "user", user: &userInput{Content: ContinuationMessage, ModelID: modelID, Origin: "AI_EDITOR"}}}, turns...)
	}
	if turns[len(turns)-1].kind == "assistant" {
		pushUser(ContinuationMessage, nil, nil)
	}
	current := turns[len(turns)-1].user
	turns = turns[:len(turns)-1]
	system := strings.Join(req.Context.SystemPrompt, "\n\n")
	if mode != CompletionDisabled {
		system = AppendFallbackText(system, CompletionInstructions)
	}
	if len(system) > MaxInjectedInstructionChars {
		system = system[:MaxInjectedInstructionChars]
	}
	if system != "" {
		applied := false
		for _, item := range turns {
			if item.kind == "user" {
				item.user.Content = system + "\n\n" + item.user.Content
				applied = true
				break
			}
		}
		if !applied {
			current.Content = system + "\n\n" + current.Content
		}
	}
	if len(kiroTools) > 0 {
		if current.Context == nil {
			current.Context = &userInputContext{}
		}
		current.Context.Tools = kiroTools
	}
	if mode == CompletionTextFallback {
		current.Content = CompletionRetryMessage
	} else if current.Context == nil || len(current.Context.ToolResults) == 0 {
		current.Content = injectThinking(current.Content, req)
	}
	carriers := make([]*imageCarrier, 0)
	for _, item := range turns {
		if item.kind == "user" {
			carriers = append(carriers, &imageCarrier{Content: item.user.Content, Images: item.user.Images})
		}
	}
	carriers = append(carriers, &imageCarrier{Content: current.Content, Images: current.Images})
	NormalizeImageCarriers(carriers)
	index := 0
	for _, item := range turns {
		if item.kind == "user" {
			item.user.Content = carriers[index].Content
			item.user.Images = carriers[index].Images
			index++
		}
	}
	current.Content = carriers[index].Content
	current.Images = carriers[index].Images
	history := make([]historyEntry, 0, len(turns))
	for _, item := range turns {
		if item.kind == "user" {
			history = append(history, historyEntry{User: item.user})
		} else {
			history = append(history, historyEntry{Assistant: item.assistant})
		}
	}
	conversationID := ""
	if req.Metadata != nil {
		conversationID = req.Metadata["kiro.conversationId"]
	}
	if !IsValidConversationID(conversationID) {
		conversationID = InvocationID()
	}
	state := map[string]any{"chatTriggerType": "MANUAL", "conversationId": conversationID, "currentMessage": historyEntry{User: current}}
	if len(history) > 0 {
		state["history"] = history
	}
	payload := map[string]any{"conversationState": state}
	if profileARN != "" {
		payload["profileArn"] = profileARN
	}
	if MapModelID(req.ModelID) == "gpt-5.6-sol" && req.Options.Reasoning != "" && req.Options.Reasoning != "none" {
		if !containsString([]string{"low", "medium", "high", "xhigh", "max"}, req.Options.Reasoning) {
			return nil, nil, "", "", fmt.Errorf("Kiro gpt-5.6-sol does not support reasoning effort %q", req.Options.Reasoning)
		}
		payload["additionalModelRequestFields"] = map[string]any{"reasoning": map[string]string{"effort": req.Options.Reasoning}}
	}
	return payload, registry.NameMap(), conversationID, mode, nil
}

func assistantContent(raw json.RawMessage, registry *ToolNameRegistry) (string, []toolUse, bool, error) {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return "", nil, false, fmt.Errorf("decode Kiro assistant content")
	}
	if text, ok := value.(string); ok {
		return text, nil, false, nil
	}
	parts, _ := value.([]any)
	var text strings.Builder
	uses := make([]toolUse, 0)
	reasoning := false
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		switch firstString(part, "type") {
		case "text", "output_text":
			text.WriteString(firstString(part, "text"))
		case "thinking", "reasoning":
			if strings.TrimSpace(firstString(part, "thinking", "text")) != "" {
				reasoning = true
			}
		case "toolCall", "tool_call":
			id := NormalizeToolID(firstString(part, "id", "call_id"))
			name := firstString(part, "name")
			if namespace := firstString(part, "namespace"); namespace != "" {
				name = namespace + "__" + name
			}
			alias, err := registry.Alias(name)
			if err != nil {
				return "", nil, false, err
			}
			input := map[string]any{}
			if object, ok := part["arguments"].(map[string]any); ok {
				input = object
			}
			uses = append(uses, toolUse{Name: alias, Input: input, ToolUseID: id})
		}
	}
	return text.String(), uses, reasoning, nil
}

func injectThinking(content string, req *types.NormalizedRequest) string {
	if MapModelID(req.ModelID) == "gpt-5.6-sol" || req.Options.Reasoning == "" || req.Options.Reasoning == "none" {
		return content
	}
	ratios := map[string]float64{"minimal": .1, "low": .2, "medium": .5, "high": .8, "xhigh": .9, "max": .95}
	ratio, ok := ratios[req.Options.Reasoning]
	if !ok {
		return content
	}
	max := req.Options.MaxOutputTokens
	if max <= 0 {
		max = 4096
	}
	budget := int(float64(max) * ratio)
	if budget < 1 {
		budget = 1
	}
	return fmt.Sprintf("<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>%d</max_thinking_length>\n<thinking_instruction>Think in English for better reasoning quality. Be thorough and systematic, consider edge cases, challenge assumptions, and verify reasoning before answering. After thinking, respond in the user's language.</thinking_instruction>\n\n%s", budget, content)
}
func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
func estimateInputTokens(req *types.NormalizedRequest) int {
	chars := 0
	for _, message := range req.Context.Messages {
		chars += len(contentText(message.Content, true))
	}
	for _, part := range req.Context.SystemPrompt {
		chars += len(part)
	}
	if chars == 0 {
		return 0
	}
	return (chars + 3) / 4
}

type attemptResult struct {
	events        []types.AdapterEvent
	usage         *types.Usage
	sawText       bool
	sawReasoning  bool
	assistantText string
	needsFallback bool
	terminalError bool
}

func parseAttempt(ctx context.Context, body io.ReadCloser, mode CompletionMode, inputTokens int, nameMap map[string]string, previousText string) (result attemptResult) {
	if body == nil {
		result.usage = &types.Usage{InputTokens: inputTokens, Estimated: true}
		result.events = []types.AdapterEvent{{Type: types.EventError, Error: "Kiro response has no body", StatusCode: 502, Usage: result.usage}}
		result.terminalError = true
		return result
	}
	defer body.Close()
	var open *struct {
		id, name   string
		chunks     []string
		completion bool
	}
	splitter := NewThinkingSplitter()
	var authoritative *types.Usage
	outputChars := 0
	completionAnswer := ""
	completionCalls := 0
	sawRealTool := false
	defer func() {
		if result.usage == nil {
			if authoritative != nil {
				copy := *authoritative
				result.usage = &copy
			} else {
				result.usage = &types.Usage{InputTokens: inputTokens, OutputTokens: (outputChars + 3) / 4, Estimated: true}
			}
		}
		for i := range result.events {
			if (result.events[i].Type == types.EventError || result.events[i].Type == types.EventDone) && result.events[i].Usage == nil {
				result.events[i].Usage = result.usage
			}
		}
	}()
	emitSplit := func(items []SplitEvent) {
		for _, item := range items {
			outputChars += len(item.Text)
			if item.Reasoning {
				if strings.TrimSpace(item.Text) != "" {
					result.sawReasoning = true
				}
				result.events = append(result.events, types.AdapterEvent{Type: types.EventReasoning, Reasoning: item.Text})
			} else {
				if strings.TrimSpace(item.Text) != "" {
					result.sawText = true
				}
				result.assistantText += item.Text
				phase := ""
				if mode != CompletionDisabled {
					phase = "commentary"
				}
				result.events = append(result.events, types.AdapterEvent{Type: types.EventTextDelta, Text: item.Text, Phase: phase})
			}
		}
	}
	fail := func(message string, retryable bool) {
		result.events = append(result.events, types.AdapterEvent{Type: types.EventError, Error: message, StatusCode: 502, Retryable: retryable})
		result.terminalError = true
	}
	flushTool := func() bool {
		if open == nil {
			return true
		}
		tool := open
		open = nil
		input := strings.Join(tool.chunks, "")
		if !IsCompleteToolInput(input) {
			fail(TruncationErrorMessage("incomplete tool input JSON"), tool.completion)
			return false
		}
		if tool.completion {
			completionCalls++
			if completionCalls > 1 {
				fail("Kiro returned more than one private final-answer tool call", true)
				return false
			}
			var value struct {
				Answer string `json:"answer"`
			}
			if json.Unmarshal([]byte(input), &value) != nil || strings.TrimSpace(value.Answer) == "" {
				fail("Kiro returned invalid or empty JSON for the private final-answer tool", true)
				return false
			}
			if sawRealTool {
				fail("Kiro returned a private final answer alongside a real tool call", false)
				return false
			}
			completionAnswer = value.Answer
			return true
		}
		if completionAnswer != "" {
			fail("Kiro returned a real tool call alongside a private final answer", false)
			return false
		}
		sawRealTool = true
		name := tool.name
		if restored := nameMap[name]; restored != "" {
			name = restored
		}
		arguments := json.RawMessage(input)
		if len(arguments) == 0 {
			arguments = json.RawMessage(`{}`)
		}
		result.events = append(result.events, types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: tool.id, Name: name, Arguments: arguments}})
		return true
	}
	for {
		if err := ctx.Err(); err != nil {
			return result
		}
		frame, err := protocol.DecodeSmithyFrame(body)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			fail("Kiro response protocol error: "+err.Error(), false)
			return result
		}
		headers := smithyHeaders(frame)
		messageType := headers[":message-type"]
		if messageType == "exception" || messageType == "error" {
			failure := ClassifyStreamError(headers, string(frame.Payload))
			result.events = append(result.events, types.AdapterEvent{Type: types.EventError, Error: failure.Message, StatusCode: failure.Status, Retryable: failure.Retryable})
			result.terminalError = true
			return result
		}
		if messageType != "event" {
			fail(fmt.Sprintf("Kiro response protocol error: unsupported Smithy message type %q", messageType), false)
			return result
		}
		eventType := headers[":event-type"]
		if eventType == "" {
			fail("Kiro response protocol error: event is missing :event-type", false)
			return result
		}
		event, err := ParseEvent(eventType, frame.Payload)
		if err != nil {
			fail(err.Error(), false)
			return result
		}
		if event == nil {
			continue
		}
		switch event.Type {
		case "metadata":
			if event.Usage != nil {
				authoritative = event.Usage
			}
		case "content":
			if open != nil {
				fail(TruncationErrorMessage("content arrived before tool stop"), false)
				return result
			}
			emitSplit(splitter.Feed(event.Data))
		case "reasoning":
			emitSplit(splitter.Flush())
			if event.Data != "" {
				emitSplit([]SplitEvent{{Reasoning: true, Text: event.Data}})
			}
		case "tool":
			emitSplit(splitter.Flush())
			if open == nil {
				if event.Stop != nil && *event.Stop {
					fail("Kiro response protocol error: tool stop received without an open tool call", false)
					return result
				}
				if event.ToolUseID == "" || event.Name == "" {
					fail("Kiro response protocol error: new tool event is missing toolUseId or name", false)
					return result
				}
				open = &struct {
					id, name   string
					chunks     []string
					completion bool
				}{id: event.ToolUseID, name: event.Name, completion: event.Name == CompletionToolName}
				if open.completion && mode == CompletionDisabled {
					fail("Kiro returned the reserved private final-answer tool while explicit completion was disabled", false)
					return result
				}
			} else if event.ToolUseID != "" && event.ToolUseID != open.id || event.Name != "" && event.Name != open.name {
				fail(TruncationErrorMessage("tool input changed identity before stop"), false)
				return result
			}
			if event.Input != "" {
				open.chunks = append(open.chunks, event.Input)
				outputChars += len(event.Input)
			}
			if event.Stop != nil && *event.Stop {
				if !flushTool() {
					return result
				}
			}
		case "invalid_state":
			failure := ClassifyEventError("", event.Message)
			result.events = append(result.events, types.AdapterEvent{Type: types.EventError, Error: failure.Message, StatusCode: failure.Status, Retryable: failure.Retryable})
			result.terminalError = true
			return result
		case "error":
			failure := ClassifyEventError(event.Reason, event.Message)
			result.events = append(result.events, types.AdapterEvent{Type: types.EventError, Error: failure.Message, StatusCode: failure.Status, Retryable: failure.Retryable})
			result.terminalError = true
			return result
		case "truncation":
			fail(TruncationErrorMessage(event.Data), false)
			return result
		}
	}
	emitSplit(splitter.Flush())
	if open != nil && !flushTool() {
		return result
	}
	if authoritative != nil {
		copy := *authoritative
		result.usage = &copy
	} else {
		result.usage = &types.Usage{InputTokens: inputTokens, OutputTokens: (outputChars + 3) / 4, Estimated: true}
	}
	if completionAnswer != "" {
		if normalizeAnswer(completionAnswer) != normalizeAnswer(previousText) {
			result.events = append(result.events, types.AdapterEvent{Type: types.EventTextDelta, Text: completionAnswer, Phase: "final_answer"})
		}
		result.sawText = true
	}
	if mode == CompletionTextFallback && completionAnswer == "" && result.sawText && !sawRealTool {
		repeated := normalizeAnswer(result.assistantText) == normalizeAnswer(previousText)
		filtered := result.events[:0]
		for _, event := range result.events {
			if event.Type == types.EventTextDelta {
				if repeated {
					continue
				}
				event.Phase = "final_answer"
			}
			filtered = append(filtered, event)
		}
		result.events = filtered
	}
	if mode == CompletionRequired && result.sawReasoning && !result.sawText && !sawRealTool {
		result.needsFallback = true
		return result
	}
	if !result.sawText && !result.sawReasoning && !sawRealTool {
		fail("Kiro returned a successful but empty response stream", true)
		return result
	}
	stop := "stop"
	if sawRealTool {
		stop = "tool_call"
	}
	result.events = append(result.events, types.AdapterEvent{Type: types.EventDone, Usage: result.usage, StopReason: stop})
	return result
}

func smithyHeaders(frame *protocol.SmithyFrame) map[string]string {
	out := map[string]string{}
	for key, value := range frame.Headers {
		if text, ok := value.Value.(string); ok {
			out[key] = text
		}
	}
	return out
}
func normalizeAnswer(value string) string { return strings.Join(strings.Fields(value), " ") }
func mergeUsage(first, second *types.Usage) *types.Usage {
	if first == nil {
		return second
	}
	if second == nil {
		return first
	}
	return &types.Usage{InputTokens: first.InputTokens + second.InputTokens, OutputTokens: first.OutputTokens + second.OutputTokens, TotalTokens: first.TotalTokens + second.TotalTokens, CachedInputTokens: first.CachedInputTokens + second.CachedInputTokens, CacheReadInputTokens: first.CacheReadInputTokens + second.CacheReadInputTokens, CacheCreationInputTokens: first.CacheCreationInputTokens + second.CacheCreationInputTokens, ReasoningOutputTokens: first.ReasoningOutputTokens + second.ReasoningOutputTokens, Estimated: first.Estimated || second.Estimated}
}

func (a *Adapter) ParseStream(ctx context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent)
	go func() {
		defer close(out)
		a.mu.Lock()
		state := a.last
		a.mu.Unlock()
		mode := CompletionDisabled
		input := 0
		var names map[string]string
		if state != nil {
			mode = state.mode
			input = state.inputTokens
			names = state.nameMap
		}
		first := parseAttempt(ctx, body, mode, input, names, "")
		if !first.needsFallback || state == nil {
			sendEvents(ctx, out, first.events)
			return
		}
		for _, event := range first.events {
			if event.Type != types.EventDone {
				if !sendEvent(ctx, out, event) {
					return
				}
			}
		}
		retryReq := state.req
		retryReq.Context.Messages = append(append([]types.Message(nil), retryReq.Context.Messages...), types.Message{Role: "assistant", Content: mustJSON([]map[string]any{{"type": "text", "text": first.assistantText}})})
		if retryReq.Metadata == nil {
			retryReq.Metadata = map[string]string{}
		}
		retryReq.Metadata["kiro.conversationId"] = state.conversationID
		httpReq, retryState, err := a.buildRequest(ctx, &retryReq, CompletionTextFallback)
		if err != nil {
			sendEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: err.Error(), StatusCode: 502, Retryable: true})
			return
		}
		response, err := DoWithRetry(ctx, a.Client, httpReq)
		if err != nil {
			sendEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: config.RedactString(err.Error()), StatusCode: 502, Retryable: true})
			return
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
			response.Body.Close()
			failure := ClassifyHTTPError(response.StatusCode, response.Header, string(payload))
			sendEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: failure.Message, StatusCode: failure.Status, Retryable: failure.Retryable})
			return
		}
		second := parseAttempt(ctx, response.Body, CompletionTextFallback, retryState.inputTokens, retryState.nameMap, first.assistantText)
		for i := range second.events {
			if second.events[i].Type == types.EventDone {
				second.events[i].Usage = mergeUsage(first.usage, second.events[i].Usage)
			} else if second.events[i].Type == types.EventError {
				second.events[i].Usage = mergeUsage(first.usage, second.usage)
			}
		}
		sendEvents(ctx, out, second.events)
	}()
	return out
}

func (a *Adapter) ParseUnary(ctx context.Context, body []byte) ([]types.AdapterEvent, error) {
	events := make([]types.AdapterEvent, 0)
	for event := range a.ParseStream(ctx, io.NopCloser(bytes.NewReader(body))) {
		events = append(events, event)
	}
	return events, nil
}
func sendEvent(ctx context.Context, out chan<- types.AdapterEvent, event types.AdapterEvent) bool {
	select {
	case out <- event:
		return true
	case <-ctx.Done():
		return false
	}
}
func sendEvents(ctx context.Context, out chan<- types.AdapterEvent, events []types.AdapterEvent) {
	for _, event := range events {
		if !sendEvent(ctx, out, event) {
			return
		}
	}
}
func mustJSON(value any) json.RawMessage { encoded, _ := json.Marshal(value); return encoded }
