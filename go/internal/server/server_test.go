package server

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

type fakeAdapter struct{ endpoint string }

func (a fakeAdapter) BuildRequest(ctx context.Context, req *types.NormalizedRequest) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, strings.NewReader(string(req.RawBody)))
}
func (fakeAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	ch := make(chan types.AdapterEvent)
	close(ch)
	return ch
}
func (fakeAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return []types.AdapterEvent{{Type: types.EventTextDelta, Text: "ok"}, {Type: types.EventDone}}, nil
}

func TestResponsesRouteResolvesAndBridges(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	server := New(Config{Registry: reg, ResolveAdapter: func(model *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
		if model.Model != "wire" || transport.BaseURL != upstream.URL {
			t.Fatalf("routing values: %+v %+v", model, transport)
		}
		return fakeAdapter{endpoint: upstream.URL}, nil
	}})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"acme/wire","stream":false}`))
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"completed"`) {
		t.Fatalf("response: %d %s", response.Code, response.Body.String())
	}
}

func TestHealthDoesNotRequireAuth(t *testing.T) {
	server := New(Config{Token: "secret"})
	request := httptest.NewRequest(http.MethodGet, "/health", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
}
