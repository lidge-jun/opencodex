// Package responsesrelay contains the deliberately small native Responses
// wire contract. It is independent from the server and sidecar packages so
// the native runtime can adopt it without importing the legacy bridge.
package responsesrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

const (
	AdapterOpenAIResponses Adapter = "openai-responses"
	AdapterAzure           Adapter = "azure"
	AdapterAzureOpenAI     Adapter = "azure-openai"

	// UnsupportedCode is stable client-facing vocabulary for requests outside
	// the first native adapter subset.
	UnsupportedCode = "standalone_go_unsupported"

	MaxResponseBodyBytes = 32 * 1024 * 1024
)

type Adapter string

// Provider is the validated, key-auth portion of a native provider row.
// Headers are optional non-credential provider headers and are copied after
// generated authentication, matching the Responses adapter precedence.
type Provider struct {
	Adapter  Adapter
	BaseURL  string
	AuthMode string
	APIKey   string
	Headers  http.Header
}

// UnsupportedError is returned for any provider or request shape that this
// package cannot prove equivalent to the native Responses subset.
type UnsupportedError struct{ Reason string }

func (e *UnsupportedError) Error() string {
	if e == nil || e.Reason == "" {
		return UnsupportedCode
	}
	return UnsupportedCode + ": " + e.Reason
}

func (e *UnsupportedError) Code() string { return UnsupportedCode }

// StatusCode exposes the stable HTTP mapping required by the native data
// plane. Callers can translate unsupported provider/request shapes without
// depending on error text.
func (e *UnsupportedError) StatusCode() int { return http.StatusNotImplemented }

func unsupported(format string, args ...any) error {
	return &UnsupportedError{Reason: fmt.Sprintf(format, args...)}
}

func IsUnsupported(err error) bool {
	var target *UnsupportedError
	return errors.As(err, &target)
}

// Validate checks the strict ticket #66 subset and returns the normalized
// upstream Responses URL. It intentionally rejects rather than guessing.
func (p Provider) Validate() (string, error) {
	if p.Adapter != AdapterOpenAIResponses && p.Adapter != AdapterAzure && p.Adapter != AdapterAzureOpenAI {
		return "", unsupported("adapter %q is not a Responses-family adapter", p.Adapter)
	}
	if p.AuthMode != "key" {
		return "", unsupported("auth mode %q is not key auth", p.AuthMode)
	}
	key, ok := resolveAPIKey(p.APIKey)
	if !ok || strings.TrimSpace(key) == "" {
		return "", unsupported("provider requires a non-empty API key")
	}
	if p.Adapter == AdapterAzure || p.Adapter == AdapterAzureOpenAI {
		if strings.Contains(p.BaseURL, "{") || strings.Contains(p.BaseURL, "}") {
			return "", unsupported("Azure base URL contains an unresolved placeholder")
		}
	}
	endpoint, err := responsesURL(p.BaseURL)
	if err != nil {
		return "", unsupported("base URL is not a safe Responses endpoint: %v", err)
	}
	for name, values := range p.Headers {
		if !validProviderHeader(name, values) {
			return "", unsupported("provider header %q is not allowed", name)
		}
	}
	return endpoint, nil
}

// BuildRequest creates the exact upstream request. The JSON body is copied
// byte-for-byte; this package does not re-serialize or silently rewrite it.
func BuildRequest(ctx context.Context, p Provider, body []byte) (*http.Request, error) {
	endpoint, err := p.Validate()
	if err != nil {
		return nil, err
	}
	if err := validateRequestBody(body); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, unsupported("request could not be constructed: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for name, values := range p.Headers {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}
	key, _ := resolveAPIKey(p.APIKey)
	if p.Adapter == AdapterAzure || p.Adapter == AdapterAzureOpenAI {
		req.Header.Del("Authorization")
		req.Header.Set("api-key", key)
	} else {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	return req, nil
}

// Do sends one native request. The returned response body remains open for
// the caller, which is important for SSE callers that need incremental relay.
func Do(ctx context.Context, client *http.Client, p Provider, body []byte) (*http.Response, error) {
	if client == nil {
		client = http.DefaultClient
	}
	req, err := BuildRequest(ctx, p, body)
	if err != nil {
		return nil, err
	}
	return client.Do(req)
}

// ReadJSONResponse reads a non-streaming response without changing its JSON.
// The returned bytes therefore retain tool calls and usage exactly as sent by
// the upstream provider.
func ReadJSONResponse(resp *http.Response) ([]byte, error) {
	if resp == nil || resp.Body == nil {
		return nil, errors.New("responsesrelay: nil response body")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > MaxResponseBodyBytes {
		return nil, errors.New("responsesrelay: upstream response exceeds body limit")
	}
	return body, nil
}

func resolveAPIKey(raw string) (string, bool) {
	if strings.HasPrefix(raw, "${") && strings.HasSuffix(raw, "}") {
		return os.LookupEnv(raw[2 : len(raw)-1])
	}
	if strings.HasPrefix(raw, "$") && len(raw) > 1 {
		return os.LookupEnv(raw[1:])
	}
	if strings.HasPrefix(raw, "keychain:") {
		return "", false
	}
	return raw, true
}

func responsesURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return "", errors.New("scheme, host, credentials, or URL syntax is invalid")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("query and fragment are not supported")
	}
	path := strings.TrimRight(parsed.Path, "/")
	if strings.HasSuffix(path, "/responses") {
		path = strings.TrimRight(strings.TrimSuffix(path, "/responses"), "/")
	}
	if strings.HasSuffix(path, "/v1") {
		path = strings.TrimRight(strings.TrimSuffix(path, "/v1"), "/")
	}
	parsed.Path = path + "/v1/responses"
	parsed.RawPath = ""
	return parsed.String(), nil
}

func validateRequestBody(body []byte) error {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(body, &root); err != nil || root == nil {
		return unsupported("request body must be a JSON object")
	}
	allowed := map[string]bool{
		"model": true, "input": true, "instructions": true, "stream": true,
		"stream_options": true, "max_output_tokens": true, "tools": true,
		"tool_choice": true,
	}
	for field := range root {
		if !allowed[field] {
			return unsupported("request field %q is outside the native Responses subset", field)
		}
	}
	var model string
	rawModel, ok := root["model"]
	if !ok || json.Unmarshal(rawModel, &model) != nil || strings.TrimSpace(model) == "" {
		return unsupported("request model must be a non-empty string")
	}
	if rawStream, ok := root["stream"]; ok {
		var stream bool
		if json.Unmarshal(rawStream, &stream) != nil {
			return unsupported("stream must be a boolean")
		}
	}
	if rawOptions, ok := root["stream_options"]; ok {
		var options map[string]json.RawMessage
		if json.Unmarshal(rawOptions, &options) != nil || options == nil {
			return unsupported("stream_options must be an object")
		}
		for field := range options {
			if field != "include_usage" {
				return unsupported("stream_options.%s is not supported", field)
			}
		}
		var includeUsage bool
		if rawInclude, present := options["include_usage"]; !present || json.Unmarshal(rawInclude, &includeUsage) != nil {
			return unsupported("stream_options.include_usage must be boolean")
		}
		var stream bool
		if rawStream, present := root["stream"]; !present || json.Unmarshal(rawStream, &stream) != nil || !stream {
			return unsupported("stream_options requires stream=true")
		}
	}
	if _, ok := root["previous_response_id"]; ok {
		return unsupported("previous_response_id requires native response state")
	}
	if rawTools, ok := root["tools"]; ok {
		var tools []map[string]json.RawMessage
		if json.Unmarshal(rawTools, &tools) != nil {
			return unsupported("tools must be an array of function tools")
		}
		for _, tool := range tools {
			var typ string
			if json.Unmarshal(tool["type"], &typ) != nil || typ != "function" {
				return unsupported("only function tools are supported")
			}
			if _, hosted := tool["namespace"]; hosted {
				return unsupported("namespaced and hosted tools are not supported")
			}
		}
	}
	if rawInput, ok := root["input"]; ok {
		var inputText string
		if json.Unmarshal(rawInput, &inputText) == nil {
			return nil
		}
		var input []map[string]json.RawMessage
		if json.Unmarshal(rawInput, &input) != nil {
			return unsupported("input must be a string or an array of items")
		}
		for _, item := range input {
			if item == nil {
				return unsupported("input array contains a non-object item")
			}
			var typ string
			_ = json.Unmarshal(item["type"], &typ)
			if strings.HasPrefix(typ, "compaction") || typ == "custom_tool_call" || typ == "reasoning" {
				return unsupported("input item type %q is not supported", typ)
			}
		}
	}
	return nil
}

func validProviderHeader(name string, values []string) bool {
	if strings.TrimSpace(name) == "" || strings.EqualFold(name, "authorization") || strings.EqualFold(name, "api-key") || strings.EqualFold(name, "cookie") {
		return false
	}
	for _, value := range values {
		if strings.ContainsAny(value, "\r\n") {
			return false
		}
	}
	return true
}
