package search

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type AnthropicExecutor struct {
	Client         *http.Client
	BaseURL        string
	Model          string
	AccessToken    string
	APIKey         string
	Headers        http.Header
	Timeout        time.Duration
	DescribeImages bool
}

func (e *AnthropicExecutor) Search(ctx context.Context, query string, _ map[string]any) (Result, error) {
	endpoint, err := anthropicMessagesURL(e.BaseURL)
	if err != nil {
		return Result{}, err
	}
	model := e.Model
	if model == "" {
		model = "claude-sonnet-4-5"
	}
	instruction := baseInstruction
	if e.DescribeImages {
		instruction += " Describe relevant image results in words because the downstream model is text-only."
	}
	body := map[string]any{
		"model": model, "max_tokens": 8192, "thinking": map[string]any{"type": "disabled"},
		"system":   []any{map[string]any{"type": "text", "text": instruction}},
		"messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": query}}}},
		"tools":    []any{map[string]any{"type": "web_search_20250305", "name": ToolName, "max_uses": 3}}, "stream": true,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return Result{}, err
	}
	timeout := e.Timeout
	if timeout <= 0 {
		timeout = 200 * time.Second
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return Result{}, err
	}
	copyHeaders(request.Header, e.Headers)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("anthropic-version", "2023-06-01")
	if e.AccessToken != "" {
		request.Header.Set("Authorization", "Bearer "+e.AccessToken)
	}
	if e.APIKey != "" {
		request.Header.Set("x-api-key", e.APIKey)
	}
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
	return ParseAnthropicSSE(response.Body)
}

func anthropicMessagesURL(base string) (string, error) {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		base = "https://api.anthropic.com"
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid Anthropic sidecar base URL %q", base)
	}
	if strings.HasSuffix(base, "/v1/messages") {
		return base, nil
	}
	base = strings.TrimSuffix(base, "/v1")
	return base + "/v1/messages", nil
}
