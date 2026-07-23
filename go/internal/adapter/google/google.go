package google

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type Mode string

const (
	ModeAIStudio        Mode = "ai-studio"
	ModeVertex          Mode = "vertex"
	ModeCloudCodeAssist Mode = "cloud-code-assist"
)

const googleBrevityInstruction = "Output style for this session:\n" +
	"- While you are still working (between tool calls), keep any text you emit to a single short line; do not narrate at length.\n" +
	"- Do detailed reasoning internally, not as visible intermediate output.\n" +
	"- Prefer taking the next tool action over explaining; keep calling tools until the task is complete.\n" +
	"- This applies only to intermediate progress text. Your final answer after the work is done is exempt: write it in full and at whatever length the task requires."

type Adapter struct {
	Mode        Mode
	BaseURL     string
	APIKey      string
	AccessToken string
	Project     string
	Location    string
	Headers     map[string]string
	Client      *http.Client
	UserAgent   string
	Replay      *ReplayStore

	stateMu            sync.RWMutex
	restoreToolName    func(string) string
	antigravityModel   string
	antigravitySession string
}

var _ types.Adapter = (*Adapter)(nil)

// NewAdapter maps shared transport/auth contracts into a Google adapter.
func NewAdapter(mode Mode, transport *types.Transport, auth *types.AuthContext) *Adapter {
	adapter := &Adapter{Mode: mode}
	if transport != nil {
		adapter.BaseURL = transport.BaseURL
		adapter.Headers = cloneStringMap(transport.Headers)
	}
	if auth != nil {
		adapter.APIKey = auth.APIKey
		adapter.AccessToken = auth.AccessToken
		if adapter.AccessToken == "" && auth.Kind == "oauth" {
			adapter.AccessToken = auth.APIKey
		}
		if adapter.Headers == nil {
			adapter.Headers = map[string]string{}
		}
		for key, value := range auth.Headers {
			adapter.Headers[key] = value
		}
	}
	return adapter
}

func (a *Adapter) HTTPClient() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = 10 * time.Second
	transport.ResponseHeaderTimeout = 60 * time.Second
	transport.IdleConnTimeout = 90 * time.Second
	return &http.Client{Transport: transport, Timeout: 10 * time.Minute}
}

func (a *Adapter) BuildRequest(ctx context.Context, req *types.NormalizedRequest) (*http.Request, error) {
	if req == nil {
		return nil, fmt.Errorf("build Google request: nil normalized request")
	}
	body, err := buildGeminiBody(req)
	if err != nil {
		return nil, err
	}
	method := "generateContent"
	streamQuery := ""
	if req.Stream {
		method = "streamGenerateContent"
		streamQuery = "?alt=sse"
	}
	headers := cloneStringMap(a.Headers)
	if headers == nil {
		headers = map[string]string{}
	}
	headers["Content-Type"] = "application/json"

	mode := a.Mode
	if mode == "" {
		mode = ModeAIStudio
	}
	var endpoint string
	var wireBody any
	var compiled CompiledBody
	switch mode {
	case ModeCloudCodeAssist:
		token := strings.TrimSpace(a.AccessToken)
		if token == "" {
			token = strings.TrimSpace(a.APIKey)
		}
		if token == "" {
			return nil, fmt.Errorf("google-antigravity oauth token missing — run ocx login google-antigravity")
		}
		base := strings.TrimRight(strings.TrimSpace(a.BaseURL), "/")
		if base == "" {
			return nil, fmt.Errorf("google-antigravity requires a non-empty baseUrl")
		}
		if err := validateHTTPBaseURL(base); err != nil {
			return nil, err
		}
		project := strings.TrimSpace(a.Project)
		if project == "" {
			return nil, fmt.Errorf("Antigravity requires a discovered Cloud Code Assist project id")
		}
		wireModel, thinkingLevel := resolveAntigravityEffortWireModel(req.ModelID, req.Options.Reasoning)
		if thinkingLevel != "" {
			generation, _ := body["generationConfig"].(map[string]any)
			if generation == nil {
				generation = map[string]any{}
			}
			generation["thinkingConfig"] = map[string]any{"thinkingLevel": thinkingLevel}
			body["generationConfig"] = generation
		}
		sessionID := AntigravitySessionID(req)
		body["sessionId"] = sessionID
		if strings.Contains(strings.ToLower(wireModel), "claude") {
			body["toolConfig"] = map[string]any{"functionCallingConfig": map[string]any{"mode": "VALIDATED"}}
		}
		compiled = CompileGoogleWireBody(body)
		contents := anySlice(compiled.Body["contents"])
		replay := a.Replay
		if replay == nil {
			replay = defaultReplayStore
		}
		if AntigravityUsesReplayCache(wireModel) {
			replay.Apply(wireModel, sessionID, contents)
		} else {
			SanitizeAntigravityClaudeSignatures(contents)
		}
		a.setRequestState(compiled.RestoreToolName, wireModel, sessionID)
		envelope := map[string]any{
			"model": wireModel, "userAgent": "antigravity", "requestType": "agent", "project": project,
			"requestId": "agent-" + randomHex(16), "request": compiled.Body,
		}
		wireBody = envelope
		endpoint = base + "/v1internal:" + method + streamQuery
		headers["Authorization"] = "Bearer " + token
		if a.UserAgent != "" {
			headers["User-Agent"] = a.UserAgent
		} else {
			headers["User-Agent"] = AntigravityRequestUserAgent()
		}

	case ModeVertex:
		compiled = CompileGoogleWireBody(body)
		a.setRequestState(compiled.RestoreToolName, "", "")
		wireBody = compiled.Body
		apiKey := strings.TrimSpace(a.APIKey)
		if strings.HasPrefix(apiKey, "<") || apiKey == "N/A" {
			apiKey = ""
		}
		if apiKey == "" {
			apiKey = strings.TrimSpace(os.Getenv("GOOGLE_CLOUD_API_KEY"))
		}
		if apiKey != "" {
			endpoint = "https://aiplatform.googleapis.com/v1/publishers/google/models/" + url.PathEscape(req.ModelID) + ":" + method + streamQuery
			headers["x-goog-api-key"] = apiKey
			break
		}
		project := firstNonEmpty(a.Project, os.Getenv("GOOGLE_CLOUD_PROJECT"), os.Getenv("GCLOUD_PROJECT"))
		if project == "" {
			return nil, fmt.Errorf("Vertex AI requires a project id")
		}
		location := firstNonEmpty(a.Location, os.Getenv("GOOGLE_CLOUD_LOCATION"))
		if location == "" {
			return nil, fmt.Errorf("Vertex AI requires a location")
		}
		token := strings.TrimSpace(a.AccessToken)
		if token == "" {
			return nil, fmt.Errorf("Vertex AI requires an OAuth access token when no API key is configured")
		}
		host := "aiplatform.googleapis.com"
		if location != "global" {
			host = location + "-aiplatform.googleapis.com"
		}
		endpoint = "https://" + host + "/v1/projects/" + url.PathEscape(project) + "/locations/" + url.PathEscape(location) +
			"/publishers/google/models/" + url.PathEscape(req.ModelID) + ":" + method + streamQuery
		headers["Authorization"] = "Bearer " + token

	case ModeAIStudio:
		apiKey := strings.TrimSpace(a.APIKey)
		if apiKey == "" {
			return nil, fmt.Errorf("google (AI Studio) requires a non-empty API key")
		}
		base := strings.TrimRight(strings.TrimSpace(a.BaseURL), "/")
		if base == "" {
			base = "https://generativelanguage.googleapis.com"
		}
		if err := validateHTTPBaseURL(base); err != nil {
			return nil, err
		}
		if (req.ModelID == "gemini-3.5-flash" || req.ModelID == "gemini-3.6-flash") && req.Options.Reasoning != "" {
			level := normalizeThinkingLevel(req.Options.Reasoning)
			if level != "" {
				generation, _ := body["generationConfig"].(map[string]any)
				if generation == nil {
					generation = map[string]any{}
				}
				generation["thinkingConfig"] = map[string]any{"thinkingLevel": level}
				body["generationConfig"] = generation
			}
		}
		compiled = CompileGoogleWireBody(body)
		a.setRequestState(compiled.RestoreToolName, "", "")
		wireBody = compiled.Body
		endpoint = base + "/v1beta/models/" + url.PathEscape(req.ModelID) + ":" + method + streamQuery
		headers["x-goog-api-key"] = apiKey

	default:
		return nil, fmt.Errorf("unsupported Google mode %q", mode)
	}

	payload, err := json.Marshal(wireBody)
	if err != nil {
		return nil, fmt.Errorf("marshal Google request: %w", err)
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build Google request: %w", err)
	}
	for key, value := range headers {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			httpRequest.Header.Set(key, value)
		}
	}
	if req.Stream {
		httpRequest.Header.Set("Accept", "text/event-stream")
	} else {
		httpRequest.Header.Set("Accept", "application/json")
	}
	return httpRequest, nil
}

// Do uses hardened retries for Vertex and Antigravity; AI Studio is a direct request.
func (a *Adapter) Do(ctx context.Context, request *http.Request, options RetryOptions) (*http.Response, error) {
	switch a.Mode {
	case ModeVertex:
		return DoWithRetry(ctx, a.HTTPClient(), request, "Vertex AI", options)
	case ModeCloudCodeAssist:
		return DoWithRetry(ctx, a.HTTPClient(), request, "Antigravity", options)
	default:
		return a.HTTPClient().Do(request)
	}
}

func buildGeminiBody(req *types.NormalizedRequest) (map[string]any, error) {
	contents := make([]any, 0, len(req.Context.Messages))
	for index, message := range req.Context.Messages {
		wire, err := messageToGemini(message, index)
		if err != nil {
			return nil, err
		}
		if wire != nil {
			contents = append(contents, wire)
		}
	}
	body := map[string]any{"contents": contents}
	systemParts := append([]string(nil), req.Context.SystemPrompt...)
	if nudge := googleToolCatalogNudge(req.Context.Tools); nudge != "" {
		systemParts = append(systemParts, nudge)
	}
	systemParts = append(systemParts, googleBrevityInstruction)
	systemText := strings.Join(systemParts, "\n\n")
	systemText = strings.Replace(systemText, "You are Codex, a coding agent based on GPT-5.", "You are a coding agent. Do not claim to be GPT-5 or to be made by OpenAI.", 1)
	body["systemInstruction"] = map[string]any{"parts": []any{map[string]any{"text": systemText}}}
	if len(req.Context.Tools) > 0 {
		declarations := make([]any, 0, len(req.Context.Tools))
		for _, tool := range req.Context.Tools {
			declarations = append(declarations, map[string]any{
				"name": namespacedToolName(tool.Namespace, tool.Name), "description": tool.Description, "parameters": tool.Parameters,
			})
		}
		body["tools"] = []any{map[string]any{"functionDeclarations": declarations}}
	}
	generation := map[string]any{}
	if req.Options.MaxOutputTokens > 0 {
		generation["maxOutputTokens"] = req.Options.MaxOutputTokens
	}
	if req.Options.Temperature != nil {
		generation["temperature"] = *req.Options.Temperature
	}
	if req.Options.TopP != nil {
		generation["topP"] = *req.Options.TopP
	}
	if len(req.Options.StopSequences) > 0 {
		generation["stopSequences"] = req.Options.StopSequences
	}
	if len(generation) > 0 {
		body["generationConfig"] = generation
	}
	return body, nil
}

func messageToGemini(message types.Message, index int) (map[string]any, error) {
	switch message.Role {
	case "user", "developer":
		parts, err := contentToGeminiParts(message.Content)
		return map[string]any{"role": "user", "parts": parts}, err
	case "assistant":
		var content any
		if err := json.Unmarshal(message.Content, &content); err != nil {
			return nil, fmt.Errorf("decode assistant message %d: %w", index, err)
		}
		parts := make([]any, 0)
		switch value := content.(type) {
		case string:
			parts = append(parts, map[string]any{"text": value})
		case []any:
			for _, rawPart := range value {
				part, ok := rawPart.(map[string]any)
				if !ok {
					continue
				}
				switch part["type"] {
				case "text", "output_text":
					if text, ok := part["text"].(string); ok {
						parts = append(parts, map[string]any{"text": text})
					}
				case "toolCall", "tool_call":
					name, _ := part["name"].(string)
					namespace, _ := part["namespace"].(string)
					call := map[string]any{"name": namespacedToolName(namespace, name), "args": part["arguments"]}
					if id := geminiToolCallID(stringValue(part["id"])); id != "" {
						call["id"] = id
					}
					wirePart := map[string]any{"functionCall": call}
					if signature := stringValue(part["thoughtSignature"]); IsLikelyRealThoughtSignature(signature) {
						wirePart["thoughtSignature"] = signature
					}
					parts = append(parts, wirePart)
				}
			}
		}
		return map[string]any{"role": "model", "parts": parts}, nil
	case "toolResult", "tool":
		name := message.ToolName
		response := map[string]any{"name": name, "response": map[string]any{"result": contentPartsToText(message.Content)}}
		if id := geminiToolCallID(message.ToolCallID); id != "" {
			response["id"] = id
		}
		parts := []any{map[string]any{"functionResponse": response}}
		parts = append(parts, toolResultImageParts(message.Content)...)
		return map[string]any{"role": "user", "parts": parts}, nil
	default:
		return nil, nil
	}
}

func contentToGeminiParts(raw json.RawMessage) ([]any, error) {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return []any{map[string]any{"text": text}}, nil
	}
	var input []map[string]any
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, fmt.Errorf("decode Google message content: %w", err)
	}
	parts := make([]any, 0, len(input))
	for _, part := range input {
		if part["type"] == "image" || part["type"] == "input_image" {
			imageURL := firstString(part, "imageUrl", "image_url")
			if mediaType, data, ok := parseDataURL(imageURL); ok {
				parts = append(parts, map[string]any{"inline_data": map[string]any{"mime_type": mediaType, "data": data}})
			} else {
				parts = append(parts, map[string]any{"text": "[image: " + imageURL + "]"})
			}
			continue
		}
		parts = append(parts, map[string]any{"text": firstString(part, "text", "input_text")})
	}
	return parts, nil
}

func toolResultImageParts(raw json.RawMessage) []any {
	var input []map[string]any
	if json.Unmarshal(raw, &input) != nil {
		return nil
	}
	parts := make([]any, 0)
	for _, part := range input {
		if part["type"] != "image" {
			continue
		}
		if mediaType, data, ok := parseDataURL(firstString(part, "imageUrl", "image_url")); ok {
			parts = append(parts, map[string]any{"inline_data": map[string]any{"mime_type": mediaType, "data": data}})
		}
	}
	return parts
}

func contentPartsToText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var input []map[string]any
	if json.Unmarshal(raw, &input) != nil {
		return ""
	}
	var out strings.Builder
	for _, part := range input {
		if part["type"] == "text" {
			out.WriteString(stringValue(part["text"]))
		} else if part["type"] == "image" {
			out.WriteString("[image]")
		}
	}
	if out.Len() == 0 {
		return "[image]"
	}
	return out.String()
}

var dataURLPattern = regexp.MustCompile(`(?s)^data:([^;,]+);base64,(.*)$`)

func parseDataURL(value string) (mediaType, data string, ok bool) {
	match := dataURLPattern.FindStringSubmatch(value)
	if len(match) != 3 {
		return "", "", false
	}
	return match[1], match[2], true
}

func geminiToolCallID(raw string) string {
	if raw == "" {
		return ""
	}
	cleaned := regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(raw, "_")
	if cleaned == raw {
		return cleaned
	}
	digest := sha256.Sum256([]byte(raw))
	return cleaned + "_" + hex.EncodeToString(digest[:4])
}

func (a *Adapter) ParseStream(ctx context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent)
	go func() {
		defer close(out)
		if body == nil {
			emitGoogleEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "No response body"})
			return
		}
		defer body.Close()
		var pendingUsage *types.Usage
		toolCalls := 0
		finishReason := ""
		err := scanSSE(body, func(payload string) bool {
			var chunk map[string]any
			if json.Unmarshal([]byte(payload), &chunk) != nil {
				return true
			}
			if rawError := chunk["error"]; rawError != nil {
				message := nestedString(rawError, "message")
				if message == "" {
					message = "upstream error"
				}
				a.clearReplayOnInvalid(message)
				emitGoogleEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: message})
				return false
			}
			root, ok := a.unwrapRoot(chunk)
			if !ok {
				emitGoogleEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "google-antigravity response missing response wrapper"})
				return false
			}
			if usage := geminiUsage(root["usageMetadata"]); usage != nil {
				pendingUsage = usage
			}
			calls, reason := a.emitGeminiCandidates(ctx, out, root)
			toolCalls += calls
			if reason != "" {
				finishReason = reason
			}
			return ctx.Err() == nil
		})
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			emitGoogleEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "read Google stream: " + err.Error()})
			return
		}
		if (a.Mode == ModeVertex || a.Mode == ModeCloudCodeAssist) && toolCalls > 0 && IsVertexTruncationReason(finishReason) {
			emitGoogleEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: VertexTruncationErrorMessage(finishReason)})
			return
		}
		emitGoogleEvent(ctx, out, types.AdapterEvent{Type: types.EventDone, Usage: pendingUsage, StopReason: finishReason})
	}()
	return out
}

func (a *Adapter) ParseUnary(ctx context.Context, body []byte) ([]types.AdapterEvent, error) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("parse Google response: %w", err)
	}
	if rawError := raw["error"]; rawError != nil {
		message := nestedString(rawError, "message")
		if message == "" {
			message = "upstream error"
		}
		a.clearReplayOnInvalid(message)
		return []types.AdapterEvent{{Type: types.EventError, Error: message}}, nil
	}
	root, ok := a.unwrapRoot(raw)
	if !ok {
		return []types.AdapterEvent{{Type: types.EventError, Error: "google-antigravity response missing response wrapper"}}, nil
	}
	if len(anySlice(root["candidates"])) == 0 {
		return []types.AdapterEvent{{Type: types.EventError, Error: "google response contained no candidates"}}, nil
	}
	events := make([]types.AdapterEvent, 0)
	toolCalls, finishReason := a.collectGeminiCandidates(root, &events)
	if (a.Mode == ModeVertex || a.Mode == ModeCloudCodeAssist) && toolCalls > 0 && IsVertexTruncationReason(finishReason) {
		return []types.AdapterEvent{{Type: types.EventError, Error: VertexTruncationErrorMessage(finishReason)}}, nil
	}
	events = append(events, types.AdapterEvent{Type: types.EventDone, Usage: geminiUsage(root["usageMetadata"]), StopReason: finishReason})
	return events, nil
}

func (a *Adapter) unwrapRoot(raw map[string]any) (map[string]any, bool) {
	if a.Mode != ModeCloudCodeAssist {
		return raw, true
	}
	root, ok := raw["response"].(map[string]any)
	return root, ok
}

func (a *Adapter) emitGeminiCandidates(ctx context.Context, out chan<- types.AdapterEvent, root map[string]any) (int, string) {
	events := make([]types.AdapterEvent, 0)
	calls, reason := a.collectGeminiCandidates(root, &events)
	for _, event := range events {
		if !emitGoogleEvent(ctx, out, event) {
			break
		}
	}
	return calls, reason
}

func (a *Adapter) collectGeminiCandidates(root map[string]any, events *[]types.AdapterEvent) (int, string) {
	candidates := anySlice(root["candidates"])
	if len(candidates) == 0 {
		return 0, ""
	}
	candidate, _ := candidates[0].(map[string]any)
	finishReason := stringValue(candidate["finishReason"])
	content, _ := candidate["content"].(map[string]any)
	parts := anySlice(content["parts"])
	model, session, restore, replay := a.requestState()
	if a.Mode == ModeCloudCodeAssist && model != "" && session != "" {
		replay.Observe(model, session, parts)
	}
	toolCalls := 0
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		if text := stringValue(part["text"]); text != "" {
			if part["thought"] == true {
				*events = append(*events, types.AdapterEvent{Type: types.EventReasoning, Reasoning: text})
			} else {
				*events = append(*events, types.AdapterEvent{Type: types.EventTextDelta, Text: text})
			}
		}
		call, ok := part["functionCall"].(map[string]any)
		if !ok {
			continue
		}
		arguments, _ := json.Marshal(call["args"])
		if len(arguments) == 0 || string(arguments) == "null" {
			arguments = []byte("{}")
		}
		id := stringValue(call["id"])
		if id == "" {
			id = "call_" + randomHex(4)
		}
		*events = append(*events, types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{
			ID: id, Name: restore(stringValue(call["name"])), Arguments: arguments,
		}})
		toolCalls++
	}
	return toolCalls, finishReason
}

func geminiUsage(value any) *types.Usage {
	usage, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	input := intValue(usage["promptTokenCount"])
	output := intValue(usage["candidatesTokenCount"])
	return &types.Usage{
		InputTokens: input, OutputTokens: output, TotalTokens: input + output,
		CachedInputTokens: intValue(usage["cachedContentTokenCount"]), ReasoningOutputTokens: intValue(usage["thoughtsTokenCount"]),
	}
}

func scanSSE(reader io.Reader, accept func(string) bool) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64<<10), 8<<20)
	data := make([]string, 0)
	dispatch := func() bool {
		if len(data) == 0 {
			return true
		}
		payload := strings.Join(data, "\n")
		data = data[:0]
		if payload == "[DONE]" {
			return false
		}
		return accept(payload)
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if !dispatch() {
				return nil
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if !dispatch() {
		return nil
	}
	return scanner.Err()
}

func emitGoogleEvent(ctx context.Context, out chan<- types.AdapterEvent, event types.AdapterEvent) bool {
	select {
	case out <- event:
		return true
	case <-ctx.Done():
		return false
	}
}

func (a *Adapter) setRequestState(restore func(string) string, model, session string) {
	a.stateMu.Lock()
	a.restoreToolName, a.antigravityModel, a.antigravitySession = restore, model, session
	a.stateMu.Unlock()
}

func (a *Adapter) requestState() (string, string, func(string) string, *ReplayStore) {
	a.stateMu.RLock()
	model, session, restore := a.antigravityModel, a.antigravitySession, a.restoreToolName
	a.stateMu.RUnlock()
	if restore == nil {
		restore = func(value string) string { return value }
	}
	replay := a.Replay
	if replay == nil {
		replay = defaultReplayStore
	}
	return model, session, restore, replay
}

func (a *Adapter) clearReplayOnInvalid(message string) {
	if a.Mode != ModeCloudCodeAssist || !regexp.MustCompile(`(?i)signature|invalid_argument|invalid argument`).MatchString(message) {
		return
	}
	model, session, _, replay := a.requestState()
	replay.Clear(model, session)
}

func resolveAntigravityEffortWireModel(modelID, effort string) (string, string) {
	aliases := map[string]string{
		"gemini-3.1-pro-high": "gemini-pro-agent", "gemini-3.1-pro-preview": "gemini-pro-agent",
		"gemini-3.6-flash-low": "gemini-3.6-flash-low", "gemini-3.6-flash-medium": "gemini-3.6-flash-medium", "gemini-3.6-flash-high": "gemini-3.6-flash-high",
		"gemini-3.1-pro-low": "gemini-3.1-pro-low", "gemini-pro-agent": "gemini-pro-agent",
		"gemini-3.5-flash-extra-low": "gemini-3.6-flash-low", "gemini-3.5-flash-low": "gemini-3.6-flash-medium",
		"gemini-3.5-flash-mid": "gemini-3.6-flash-medium", "gemini-3.5-flash-high": "gemini-3.6-flash-high", "gemini-3-flash-agent": "gemini-3.6-flash-high",
	}
	if wire, ok := aliases[modelID]; ok {
		return wire, ""
	}
	effort = normalizeThinkingLevel(effort)
	switch modelID {
	case "gemini-3.6-flash":
		if effort == "low" || effort == "medium" || effort == "high" {
			return modelID + "-" + effort, effort
		}
		return modelID + "-medium", ""
	case "gemini-3.1-pro":
		if effort == "low" || effort == "medium" {
			return "gemini-3.1-pro-low", "low"
		}
		if effort == "high" {
			return "gemini-pro-agent", "high"
		}
		return "gemini-pro-agent", ""
	default:
		if strings.HasPrefix(modelID, "claude-") && effort != "" {
			return modelID, effort
		}
		return modelID, ""
	}
}

func normalizeThinkingLevel(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "xhigh" || value == "max" || value == "ultra" {
		return "high"
	}
	if value == "minimal" || value == "low" || value == "medium" || value == "high" {
		return value
	}
	return ""
}

func googleToolCatalogNudge(tools []types.Tool) string {
	if len(tools) == 0 {
		return ""
	}
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, "`"+namespacedToolName(tool.Namespace, tool.Name)+"`")
	}
	return "Tool contract: use the current tool catalog as ground truth. Valid tool names for this turn are exactly " + strings.Join(names, ", ") + ". Call only listed names with their listed argument keys; do not invent, translate, or rename tools."
}

func namespacedToolName(namespace, name string) string {
	if namespace != "" {
		return namespace + "__" + name
	}
	return name
}

func validateHTTPBaseURL(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("invalid Google base URL %q", value)
	}
	return nil
}

func cloneStringMap(input map[string]string) map[string]string {
	if input == nil {
		return nil
	}
	out := make(map[string]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func randomHex(bytesCount int) string {
	data := make([]byte, bytesCount)
	if _, err := rand.Read(data); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(data)
}

func firstString(object map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := object[key].(string); ok {
			return value
		}
	}
	return ""
}

func nestedString(value any, key string) string {
	object, _ := value.(map[string]any)
	return stringValue(object[key])
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func intValue(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	case int64:
		return int(number)
	default:
		return 0
	}
}
