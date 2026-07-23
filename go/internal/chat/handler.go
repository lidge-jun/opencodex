package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	defaultRequestBodyLimit = int64(8 << 20)
	defaultResponseLimit    = int64(64 << 20)
)

// AdapterResolver constructs the provider adapter selected by the registry.
type AdapterResolver func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error)

// HandlerConfig supplies the existing routing and transport owners to compatibility handlers.
type HandlerConfig struct {
	Registry        types.Registry
	Auth            types.AuthProvider
	ResolveAdapter  AdapterResolver
	Client          *http.Client
	BodyLimit       int64
	ResponseLimit   int64
	Compactor       types.CompactionHandler
	NativeAnthropic func(*types.ResolvedModel) bool
	NativeCompact   func(*types.ResolvedModel) bool
}

type Handler struct{ config HandlerConfig }

var _ types.RouteHandler = (*Handler)(nil)

func NewHandler(config HandlerConfig) *Handler { return &Handler{config: withHandlerDefaults(config)} }

func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	raw, err := readRequestBody(w, r, h.config.BodyLimit)
	if err != nil {
		writeChatError(w, http.StatusBadRequest, err.Error())
		return
	}
	normalized, err := ParseInbound(raw)
	if err != nil {
		writeChatError(w, http.StatusBadRequest, err.Error())
		return
	}
	requestedModel := normalized.ModelID
	prepared, err := h.config.prepare(r.Context(), r.Header, normalized)
	if err != nil {
		writeChatErrorFor(w, err)
		return
	}
	response, err := h.config.do(r.Context(), prepared)
	if err != nil {
		writeChatErrorFor(w, err)
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		message := readProviderError(response.Body, h.config.ResponseLimit)
		if message == "" {
			message = fmt.Sprintf("upstream error (%d)", response.StatusCode)
		}
		writeChatError(w, response.StatusCode, message)
		return
	}
	if normalized.Stream {
		if err := WriteChatStream(r.Context(), w, requestedModel, prepared.adapter.ParseStream(r.Context(), response.Body)); err != nil && !errors.Is(err, context.Canceled) {
			return
		}
		return
	}
	defer response.Body.Close()
	payload, err := readBounded(response.Body, h.config.ResponseLimit)
	if err != nil {
		writeChatError(w, http.StatusBadGateway, err.Error())
		return
	}
	events, err := prepared.adapter.ParseUnary(r.Context(), payload)
	if err != nil {
		writeChatError(w, http.StatusBadGateway, err.Error())
		return
	}
	completion, err := BuildChatCompletion(events, requestedModel)
	if err != nil {
		writeChatError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, completion)
}

type preparedRequest struct {
	normalized *types.NormalizedRequest
	resolved   *types.ResolvedModel
	transport  *types.Transport
	auth       *types.AuthContext
	adapter    types.Adapter
	headers    http.Header
}

func (c HandlerConfig) prepare(ctx context.Context, incoming http.Header, normalized *types.NormalizedRequest) (*preparedRequest, error) {
	if c.Registry == nil || c.ResolveAdapter == nil {
		return nil, statusError{status: 503, message: "routing integration is not configured"}
	}
	resolved, err := c.Registry.ResolveModel(normalized.ModelID)
	if err != nil {
		return nil, statusError{status: 404, message: err.Error()}
	}
	var auth *types.AuthContext
	if c.Auth != nil {
		auth, err = c.Auth.ResolveAuth(ctx, resolved.Provider, threadID(incoming))
		if err != nil {
			return nil, statusError{status: 401, message: err.Error()}
		}
	}
	transport, err := c.Registry.ResolveTransport(resolved.Provider, auth)
	if err != nil {
		return nil, statusError{status: 502, message: err.Error()}
	}
	adapter, err := c.ResolveAdapter(resolved, transport, auth, incoming.Clone())
	if err != nil {
		return nil, statusError{status: 502, message: err.Error()}
	}
	normalized.ModelID = resolved.Model
	return &preparedRequest{normalized: normalized, resolved: resolved, transport: transport, auth: auth, adapter: adapter, headers: incoming.Clone()}, nil
}

func (c HandlerConfig) do(ctx context.Context, prepared *preparedRequest) (*http.Response, error) {
	request, err := prepared.adapter.BuildRequest(ctx, prepared.normalized)
	if err != nil {
		return nil, statusError{status: 400, message: err.Error()}
	}
	if prepared.auth != nil {
		for name, value := range prepared.auth.Headers {
			if strings.TrimSpace(name) != "" && strings.TrimSpace(value) != "" {
				request.Header.Set(name, value)
			}
		}
	}
	response, err := c.Client.Do(request)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			return nil, statusError{status: 499, message: "client cancelled request"}
		}
		return nil, statusError{status: 502, message: err.Error()}
	}
	return response, nil
}

type statusError struct {
	status  int
	message string
}

func (e statusError) Error() string { return e.message }

func withHandlerDefaults(config HandlerConfig) HandlerConfig {
	if config.Client == nil {
		config.Client = &http.Client{Timeout: 10 * time.Minute}
	}
	if config.BodyLimit <= 0 {
		config.BodyLimit = defaultRequestBodyLimit
	}
	if config.ResponseLimit <= 0 {
		config.ResponseLimit = defaultResponseLimit
	}
	return config
}

func readRequestBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	if r.Body == nil {
		return nil, fmt.Errorf("request body is required")
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, fmt.Errorf("invalid request body: %w", err)
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || !strings.HasPrefix(trimmed, "{") {
		return nil, fmt.Errorf("request body must be a JSON object")
	}
	return data, nil
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	limited := io.LimitReader(reader, limit+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("upstream response exceeded %d bytes", limit)
	}
	return data, nil
}

func readProviderError(reader io.Reader, limit int64) string {
	data, _ := readBounded(reader, min64(limit, 1<<20))
	var body struct {
		Error   any    `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(data, &body) == nil {
		switch value := body.Error.(type) {
		case string:
			if value != "" {
				return value
			}
		case map[string]any:
			if message, ok := value["message"].(string); ok {
				return message
			}
		}
		if body.Message != "" {
			return body.Message
		}
	}
	return strings.TrimSpace(string(data))
}

func writeChatErrorFor(w http.ResponseWriter, err error) {
	var typed statusError
	if errors.As(err, &typed) {
		writeChatError(w, typed.status, typed.message)
		return
	}
	writeChatError(w, http.StatusInternalServerError, err.Error())
}

func writeChatError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": message, "type": chatErrorType(status), "param": nil, "code": chatErrorCode(status)}})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func threadID(headers http.Header) string {
	if value := headers.Get("x-codex-parent-thread-id"); value != "" {
		return value
	}
	return headers.Get("thread-id")
}
func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
