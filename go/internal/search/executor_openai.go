package search

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const baseInstruction = "You are a web-search assistant. Use the web_search tool to find current information for the user's query, then reply with a concise, factual answer. End with a Sources section containing one title and URL per line."

type Executor interface {
	Search(ctx context.Context, query string, hostedTool map[string]any) (Result, error)
}

type OpenAIExecutor struct {
	Client         *http.Client
	BaseURL        string
	Model          string
	Reasoning      string
	Headers        http.Header
	Timeout        time.Duration
	DescribeImages bool
}

func (e *OpenAIExecutor) Search(ctx context.Context, query string, hostedTool map[string]any) (Result, error) {
	endpoint, err := openAIResponsesURL(e.BaseURL)
	if err != nil {
		return Result{}, err
	}
	model := e.Model
	if model == "" {
		model = "gpt-5-mini"
	}
	reasoning := e.Reasoning
	if reasoning == "" {
		reasoning = "low"
	}
	instructions := baseInstruction
	if e.DescribeImages {
		instructions += " Describe relevant image results in words because the downstream model is text-only."
	}
	if hostedTool == nil {
		hostedTool = map[string]any{"type": ToolName}
	}
	body := map[string]any{
		"model": model, "instructions": instructions,
		"input": []any{map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": query}}}},
		"tools": []any{hostedTool}, "tool_choice": "auto", "reasoning": map[string]any{"effort": reasoning},
		"store": false, "stream": true,
	}
	return e.execute(ctx, endpoint, body)
}

func (e *OpenAIExecutor) execute(ctx context.Context, endpoint string, body any) (Result, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return Result{}, err
	}
	if e.Timeout <= 0 {
		e.Timeout = 200 * time.Second
	}
	requestCtx, cancel := context.WithTimeout(ctx, e.Timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return Result{}, err
	}
	copyHeaders(request.Header, e.Headers)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	client := e.Client
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return Result{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Result{}, responseError(response)
	}
	return ParseOpenAISSE(response.Body)
}

func openAIResponsesURL(base string) (string, error) {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		base = "https://api.openai.com"
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid OpenAI sidecar base URL %q", base)
	}
	if strings.HasSuffix(base, "/responses") {
		return base, nil
	}
	if strings.HasSuffix(base, "/v1") {
		return base + "/responses", nil
	}
	return base + "/v1/responses", nil
}

func copyHeaders(target, source http.Header) {
	for key, values := range source {
		for _, value := range values {
			target.Add(key, value)
		}
	}
}

func responseError(response *http.Response) error {
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	return &HTTPError{StatusCode: response.StatusCode, RetryAfter: response.Header.Get("Retry-After")}
}

type HTTPError struct {
	StatusCode          int
	RetryAfter, Message string
}

func (e *HTTPError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("sidecar HTTP %d", e.StatusCode)
	}
	return fmt.Sprintf("sidecar HTTP %d: %s", e.StatusCode, e.Message)
}
