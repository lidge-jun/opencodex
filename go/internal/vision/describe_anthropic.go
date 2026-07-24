package vision

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	DefaultAnthropicVisionModel = "claude-sonnet-5"
	defaultAnthropicOAuthBeta   = "claude-code-20250219,oauth-2025-04-20"
	anthropicVisionMaxTokens    = 1024
)

type OAuthTokenSource interface {
	Token(context.Context) (string, error)
}

type OAuthTokenSourceFunc func(context.Context) (string, error)

func (f OAuthTokenSourceFunc) Token(ctx context.Context) (string, error) { return f(ctx) }

type AnthropicConfig struct {
	BaseURL     string
	Model       string
	AccessToken string
	TokenSource OAuthTokenSource
	OAuthBeta   string
	Headers     map[string]string
	Client      *http.Client
	Timeout     time.Duration
}

type AnthropicMessagesDescriber struct {
	config AnthropicConfig
}

func NewAnthropicMessagesDescriber(config AnthropicConfig) *AnthropicMessagesDescriber {
	if config.Model == "" {
		config.Model = DefaultAnthropicVisionModel
	}
	if config.OAuthBeta == "" {
		config.OAuthBeta = defaultAnthropicOAuthBeta
	}
	if config.Timeout <= 0 {
		config.Timeout = DefaultVisionTimeout
	}
	if config.Client == nil {
		config.Client = http.DefaultClient
	}
	return &AnthropicMessagesDescriber{config: config}
}

func (d *AnthropicMessagesDescriber) Describe(ctx context.Context, image Image, contextText string) (string, error) {
	token := strings.TrimSpace(d.config.AccessToken)
	if d.config.TokenSource != nil {
		resolved, err := d.config.TokenSource.Token(ctx)
		if err != nil || strings.TrimSpace(resolved) == "" {
			return "", fmt.Errorf("Anthropic OAuth authentication failed")
		}
		token = strings.TrimSpace(resolved)
	}
	if token == "" {
		return "", fmt.Errorf("Anthropic OAuth access token is unavailable")
	}
	endpoint, err := sidecarEndpoint(d.config.BaseURL, "/v1/messages")
	if err != nil {
		return "", fmt.Errorf("Anthropic vision endpoint: %w", err)
	}
	content := make([]any, 0, 2)
	if contextText != "" {
		content = append(content, map[string]any{"type": "text", "text": "The user's request about this image: " + clampText(contextText, 800)})
	}
	content = append(content, anthropicImageBlock(image))
	body := map[string]any{
		"model": d.config.Model, "max_tokens": anthropicVisionMaxTokens,
		"system": []any{
			map[string]any{"type": "text", "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK."},
			map[string]any{"type": "text", "text": describeInstruction},
		},
		"messages": []any{map[string]any{"role": "user", "content": content}}, "stream": false,
	}
	headers := cloneHeaders(d.config.Headers)
	headers.Set("Authorization", "Bearer "+token)
	headers.Set("anthropic-version", "2023-06-01")
	headers.Set("anthropic-beta", d.config.OAuthBeta)
	headers.Set("User-Agent", "@anthropic-ai/sdk/0.74.0")
	headers.Set("X-App", "cli")
	var response anthropicResponse
	if err := executeJSON(ctx, d.config.Client, d.config.Timeout, endpoint, headers, body, &response); err != nil {
		return "", fmt.Errorf("Anthropic vision sidecar: %w", err)
	}
	text := strings.TrimSpace(response.text())
	if text == "" {
		return "", fmt.Errorf("Anthropic vision sidecar produced no description")
	}
	return text, nil
}

func anthropicImageBlock(image Image) map[string]any {
	if len(image.Data) > 0 {
		encoded := base64.StdEncoding.EncodeToString(image.Data)
		return map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": image.MediaType, "data": encoded}}
	}
	return map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": image.URL}}
}

type anthropicResponse struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func (r anthropicResponse) text() string {
	var texts []string
	for _, content := range r.Content {
		if content.Type == "text" {
			texts = append(texts, content.Text)
		}
	}
	return strings.Join(texts, "")
}
