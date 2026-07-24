package chat

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type handlerAdapter struct{ endpoint string }

type incompleteHandlerAdapter struct {
	handlerAdapter
	events []types.AdapterEvent
}

type handlerAuth struct{ context *types.AuthContext }

func (a handlerAuth) ResolveAuth(context.Context, string, string) (*types.AuthContext, error) {
	return a.context, nil
}
func (handlerAuth) RecordOutcome(string, types.OutcomeStatus, *types.RetryMeta) {}

func (a handlerAdapter) BuildRequest(ctx context.Context, req *types.NormalizedRequest) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, strings.NewReader(`{}`))
}
func (handlerAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, 2)
	events <- types.AdapterEvent{Type: types.EventTextDelta, Text: "streamed"}
	events <- types.AdapterEvent{Type: types.EventDone, Usage: &types.Usage{InputTokens: 1, OutputTokens: 1}}
	close(events)
	return events
}
func (handlerAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return []types.AdapterEvent{{Type: types.EventTextDelta, Text: "unary"}, {Type: types.EventDone, Usage: &types.Usage{InputTokens: 2, OutputTokens: 1}}}, nil
}

func (a incompleteHandlerAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, len(a.events))
	for _, event := range a.events {
		events <- event
	}
	close(events)
	return events
}

func (a incompleteHandlerAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return a.events, nil
}

func TestHandlerRoutesUnaryChatCompletion(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	handler := NewHandler(HandlerConfig{Registry: reg, ResolveAdapter: func(model *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
		if model.Model != "wire" || transport.BaseURL != upstream.URL {
			t.Fatalf("route = %+v %+v", model, transport)
		}
		return handlerAdapter{endpoint: upstream.URL}, nil
	}})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"acme/wire","messages":[{"role":"user","content":"hi"}]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"content":"unary"`) || !strings.Contains(response.Body.String(), `"total_tokens":3`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestHandlerRejectsOversizedBody(t *testing.T) {
	handler := NewHandler(HandlerConfig{BodyLimit: 16})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"m","messages":[{"role":"user","content":"too long"}]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != 400 || !strings.Contains(response.Body.String(), "request body too large") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestMessagesHandlerNativeAnthropicPassthrough(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" || r.Header.Get("x-api-key") != "native-key" {
			t.Fatalf("request = %s headers=%v", r.URL.Path, r.Header)
		}
		payload, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(payload), `"model":"claude-wire"`) {
			t.Fatalf("payload = %s", payload)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"message","content":[{"type":"text","text":"native"}]}`))
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "anthropic", BaseURL: upstream.URL, DefaultModel: "claude-wire", Models: []registry.ModelDefinition{{ID: "claude-wire"}}})
	handler := NewMessagesHandler(HandlerConfig{
		Registry: reg,
		Auth:     handlerAuth{context: &types.AuthContext{APIKey: "native-key"}},
		ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
			return handlerAdapter{endpoint: upstream.URL}, nil
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"anthropic/claude-wire","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"native"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestMessagesHandlerReturns529ForIncompleteUnaryResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "claude-wire", Models: []registry.ModelDefinition{{ID: "claude-wire"}}})
	handler := NewMessagesHandler(HandlerConfig{Registry: reg, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
		return incompleteHandlerAdapter{
			handlerAdapter: handlerAdapter{endpoint: upstream.URL},
			events:         []types.AdapterEvent{{Type: types.EventIncomplete, Reason: "adapter_eof"}},
		}, nil
	}})
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"acme/claude-wire","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != 529 || !strings.Contains(response.Body.String(), `"type":"overloaded_error"`) || !strings.Contains(response.Body.String(), `upstream response was incomplete (adapter_eof)`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestCompactHandlerNativePassthroughUsesCompactEndpoint(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses/compact" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"output":[]}`))
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "openai", BaseURL: upstream.URL + "/v1", DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	handler := NewCompactHandler(HandlerConfig{Registry: reg, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
		return handlerAdapter{endpoint: upstream.URL}, nil
	}})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses/compact", strings.NewReader(`{"model":"openai/wire","input":[]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"output"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}
