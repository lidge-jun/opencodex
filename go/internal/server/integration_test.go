package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

type integrationAdapter struct{ endpoint string }

func (a integrationAdapter) BuildRequest(ctx context.Context, _ *types.NormalizedRequest) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, strings.NewReader(`{}`))
}

func (integrationAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, 2)
	events <- types.AdapterEvent{Type: types.EventTextDelta, Text: "integrated"}
	events <- types.AdapterEvent{Type: types.EventDone, Usage: &types.Usage{InputTokens: 2, OutputTokens: 1}}
	close(events)
	return events
}

func (integrationAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return []types.AdapterEvent{{Type: types.EventTextDelta, Text: "integrated"}, {Type: types.EventDone, Usage: &types.Usage{InputTokens: 2, OutputTokens: 1}}}, nil
}

func TestIntegrationWiresDataAndManagementRoutes(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	store := oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	if err := store.SaveCredential(context.Background(), "acme", oauth.OAuthCredentials{Access: "test-access", Refresh: "test-refresh", Expires: time.Now().Add(time.Hour).UnixMilli()}); err != nil {
		t.Fatalf("SaveCredential() error = %v", err)
	}
	auth := oauth.NewAuthResolver(store, map[string]oauth.ProviderAuthConfig{"acme": {Mode: oauth.AuthModeOAuth}}, nil)
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	usageLog := usage.NewLog(filepath.Join(t.TempDir(), "usage.jsonl"))
	proxy := New(Config{
		Registry: reg, Auth: auth, UsageRecorder: usageLog, Version: "integration",
		ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, resolvedAuth *types.AuthContext, _ http.Header) (types.Adapter, error) {
			if resolvedAuth == nil || resolvedAuth.AccessToken != "test-access" {
				t.Fatalf("OAuth auth context was not resolved: %+v", resolvedAuth)
			}
			return integrationAdapter{endpoint: upstream.URL}, nil
		},
	})
	server := httptest.NewServer(proxy.Handler())
	defer server.Close()

	assertRequest(t, http.MethodGet, server.URL+"/health", "", http.StatusOK, `"status":"ok"`)
	assertRequest(t, http.MethodPost, server.URL+"/v1/responses", `{"model":"acme/wire","stream":true}`, http.StatusOK, "event: response.completed")
	assertRequest(t, http.MethodGet, server.URL+"/api/logs", "", http.StatusOK, `"provider":"acme"`)
	assertRequest(t, http.MethodPost, server.URL+"/v1/chat/completions", `{"model":"acme/wire","messages":[{"role":"user","content":"hello"}]}`, http.StatusOK, `"object":"chat.completion"`)
	assertRequest(t, http.MethodGet, server.URL+"/api/system", "", http.StatusOK, `"version":"integration"`)
	assertRequest(t, http.MethodPost, server.URL+"/v1/responses/compact", `{"model":"acme/wire","input":[{"type":"message","role":"user","content":"retain me"}]}`, http.StatusOK, `"output"`)

	entries, err := usageLog.ReadAll()
	if err != nil || len(entries) != 1 || entries[0].Usage == nil || usage.CanonicalTotal(*entries[0].Usage) != 3 {
		t.Fatalf("usage entries = %+v, error = %v", entries, err)
	}
}

func assertRequest(t *testing.T, method, url, body string, wantStatus int, wantBody string) {
	t.Helper()
	request, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(response.Body)
	if response.StatusCode != wantStatus || !strings.Contains(string(payload), wantBody) {
		t.Fatalf("%s %s = %d %s, want %d containing %q", method, url, response.StatusCode, payload, wantStatus, wantBody)
	}
}
