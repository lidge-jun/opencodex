package chat

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func (h *MessagesHandler) shouldPassthrough(model *types.ResolvedModel) bool {
	if h.config.NativeAnthropic != nil {
		return h.config.NativeAnthropic(model)
	}
	provider := strings.ToLower(model.Provider)
	return provider == "anthropic" || provider == "claude"
}

func (h *MessagesHandler) nativePassthrough(w http.ResponseWriter, r *http.Request, raw []byte, prepared *preparedRequest) {
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		writeAnthropicError(w, 400, "invalid request body")
		return
	}
	body["model"] = prepared.resolved.Model
	payload, _ := json.Marshal(body)
	endpoint, err := nativeMessagesURL(prepared.transport.BaseURL)
	if err != nil {
		writeAnthropicError(w, 502, err.Error())
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, strings.NewReader(string(payload)))
	if err != nil {
		writeAnthropicError(w, 500, err.Error())
		return
	}
	request.Header.Set("Content-Type", "application/json")
	for _, name := range []string{"anthropic-version", "anthropic-beta", "accept"} {
		if value := r.Header.Get(name); value != "" {
			request.Header.Set(name, value)
		}
	}
	for name, value := range prepared.transport.Headers {
		request.Header.Set(name, value)
	}
	if prepared.auth != nil {
		for name, value := range prepared.auth.Headers {
			request.Header.Set(name, value)
		}
		if prepared.auth.APIKey != "" {
			request.Header.Set("x-api-key", prepared.auth.APIKey)
		}
		if prepared.auth.AccessToken != "" {
			request.Header.Set("Authorization", "Bearer "+prepared.auth.AccessToken)
		}
	}
	response, err := h.config.Client.Do(request)
	if err != nil {
		writeAnthropicError(w, 502, err.Error())
		return
	}
	defer response.Body.Close()
	for _, name := range []string{"content-type", "request-id", "retry-after"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	if prepared.normalized.Stream {
		buffer := make([]byte, 32<<10)
		flusher, _ := w.(http.Flusher)
		var total int64
		for {
			n, readErr := response.Body.Read(buffer)
			if n > 0 {
				total += int64(n)
				if total > h.config.ResponseLimit {
					return
				}
				if _, err := w.Write(buffer[:n]); err != nil {
					return
				}
				if flusher != nil {
					flusher.Flush()
				}
			}
			if readErr != nil {
				return
			}
		}
	}
	data, err := readBounded(response.Body, h.config.ResponseLimit)
	if err != nil {
		return
	}
	_, _ = w.Write(data)
}

func nativeMessagesURL(base string) (string, error) {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid Anthropic base URL %q", base)
	}
	if strings.HasSuffix(base, "/v1/messages") {
		return base, nil
	}
	base = strings.TrimSuffix(base, "/v1")
	return base + "/v1/messages", nil
}
