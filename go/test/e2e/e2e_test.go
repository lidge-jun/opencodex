package e2e

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type memoryAuthProvider struct{}

func (memoryAuthProvider) ResolveAuth(_ context.Context, provider, _ string) (*types.AuthContext, error) {
	return &types.AuthContext{Kind: "oauth", Provider: provider, AccountID: provider + "-account", AccessToken: "memory-token", Headers: map[string]string{"X-Mock-OAuth": provider}}, nil
}

func (memoryAuthProvider) RecordOutcome(string, types.OutcomeStatus, *types.RetryMeta) {}

type memoryUsageRecorder struct {
	mu      sync.Mutex
	records []types.UsageRecord
}

func (r *memoryUsageRecorder) Record(_ context.Context, record *types.UsageRecord) error {
	if record == nil {
		return errors.New("usage record is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.records = append(r.records, *record)
	return nil
}

func (r *memoryUsageRecorder) Records() []types.UsageRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]types.UsageRecord(nil), r.records...)
}

type cannedAdapter struct{ endpoint string }

func (a cannedAdapter) BuildRequest(ctx context.Context, _ *types.NormalizedRequest) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, strings.NewReader(`{}`))
}

func (cannedAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, 3)
	usage := &types.Usage{InputTokens: 7, OutputTokens: 3, TotalTokens: 10}
	events <- types.AdapterEvent{Type: types.EventTextDelta, Text: "canned response"}
	events <- types.AdapterEvent{Type: types.EventUsage, Usage: usage}
	events <- types.AdapterEvent{Type: types.EventDone, Usage: usage, StopReason: "stop"}
	close(events)
	return events
}

func (cannedAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	usage := &types.Usage{InputTokens: 7, OutputTokens: 3, TotalTokens: 10}
	return []types.AdapterEvent{
		{Type: types.EventTextDelta, Text: "canned response"},
		{Type: types.EventUsage, Usage: usage},
		{Type: types.EventDone, Usage: usage, StopReason: "stop"},
	}, nil
}

type resolvedCapture struct {
	mu     sync.Mutex
	models []types.ResolvedModel
}

func (c *resolvedCapture) Add(model *types.ResolvedModel) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.models = append(c.models, *model)
}

func (c *resolvedCapture) Last() types.ResolvedModel {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.models[len(c.models)-1]
}

type proxyHarness struct {
	baseURL string
	cancel  context.CancelFunc
	done    <-chan error
}

func startProxy(t *testing.T, proxy *server.Server) proxyHarness {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	httpServer := proxy.HTTPServer(listener.Addr().String())
	httpServer.BaseContext = func(net.Listener) context.Context { return ctx }
	done := make(chan error, 1)
	go func() {
		err := httpServer.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		done <- err
	}()
	go func() {
		<-ctx.Done()
		drainCtx, drainCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer drainCancel()
		_ = proxy.Lifecycle().Drain(drainCtx)
		_ = httpServer.Shutdown(drainCtx)
	}()
	return proxyHarness{baseURL: "http://" + listener.Addr().String(), cancel: cancel, done: done}
}

func TestProxyEndToEnd(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Mock-OAuth") == "" {
			t.Error("upstream request did not receive OAuth header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	providers := []registry.Provider{
		{ID: "openai", Adapter: "mock", BaseURL: upstream.URL, AuthKind: registry.AuthOAuth, DefaultModel: "gpt-canned", Models: []registry.ModelDefinition{{ID: "gpt-canned"}}},
		{ID: "anthropic", Adapter: "mock", BaseURL: upstream.URL, AuthKind: registry.AuthOAuth, DefaultModel: "claude-canned", Models: []registry.ModelDefinition{{ID: "claude-canned"}}},
		{ID: "google", Adapter: "mock", BaseURL: upstream.URL, AuthKind: registry.AuthOAuth, DefaultModel: "gemini-canned", Models: []registry.ModelDefinition{{ID: "gemini-canned"}}},
	}
	reg := registry.New(providers...)
	comboResolver, err := combos.New(map[string]combos.Combo{
		"balanced": {Targets: []combos.Target{{Provider: "openai", Model: "gpt-canned"}}},
	}, map[string]combos.Provider{"openai": {}, "anthropic": {}, "google": {}})
	if err != nil {
		t.Fatal(err)
	}
	managementConfig := config.Default()
	managementConfig.DefaultProvider = "openai"
	managementConfig.Providers = map[string]config.ProviderConfig{
		"openai":    {Adapter: "mock", BaseURL: upstream.URL, DefaultModel: "gpt-canned"},
		"anthropic": {Adapter: "mock", BaseURL: upstream.URL, DefaultModel: "claude-canned"},
		"google":    {Adapter: "mock", BaseURL: upstream.URL, DefaultModel: "gemini-canned"},
	}
	managementRouter, err := management.NewAPI(management.Options{Config: &managementConfig, Registry: reg, Version: "wp24-e2e"})
	if err != nil {
		t.Fatal(err)
	}
	recorder := &memoryUsageRecorder{}
	capture := &resolvedCapture{}
	proxy := server.New(server.Config{
		Registry: reg, Combos: comboResolver, Auth: memoryAuthProvider{}, Management: managementRouter,
		UsageRecorder: recorder, Version: "wp24-e2e",
		ResolveAdapter: func(model *types.ResolvedModel, _ *types.Transport, auth *types.AuthContext, _ http.Header) (types.Adapter, error) {
			if auth == nil || auth.AccessToken != "memory-token" {
				return nil, errors.New("mock OAuth was not resolved")
			}
			capture.Add(model)
			return cannedAdapter{endpoint: upstream.URL}, nil
		},
	})
	harness := startProxy(t, proxy)

	response := doRequest(t, http.MethodGet, harness.baseURL+"/health", "")
	assertStatusContains(t, response, http.StatusOK, `"status":"ok"`)

	response = doRequest(t, http.MethodPost, harness.baseURL+"/v1/responses", `{"model":"openai/gpt-canned","stream":true,"input":"hello"}`)
	assertStatusContains(t, response, http.StatusOK, "event: response.output_text.delta", `"delta":"canned response"`, `"usage":{"input_tokens":7`, "event: response.completed")

	response = doRequest(t, http.MethodPost, harness.baseURL+"/v1/chat/completions", `{"model":"openai/gpt-canned","stream":true,"messages":[{"role":"user","content":"hello"}]}`)
	assertStatusContains(t, response, http.StatusOK, `"choices"`, `"delta":{"content":"canned response"}`, `"usage":{"completion_tokens":3`, "data: [DONE]")

	response = doRequest(t, http.MethodPost, harness.baseURL+"/v1/messages", `{"model":"google/gemini-canned","max_tokens":32,"messages":[{"role":"user","content":"hello"}]}`)
	assertStatusContains(t, response, http.StatusOK, `"content":[{"text":"canned response","type":"text"}]`, `"stop_reason":"end_turn"`)

	response = doRequest(t, http.MethodGet, harness.baseURL+"/api/system", "")
	assertStatusContains(t, response, http.StatusOK, `"version":"wp24-e2e"`, `"goVersion":`)

	response = doRequest(t, http.MethodPost, harness.baseURL+"/v1/responses/compact", `{"model":"google/gemini-canned","input":[{"type":"message","role":"user","content":"retain me"}]}`)
	assertStatusContains(t, response, http.StatusOK, `"output"`)

	response = doRequest(t, http.MethodGet, harness.baseURL+"/api/providers", "")
	assertStatusContains(t, response, http.StatusOK, `"name":"openai"`, `"name":"anthropic"`, `"name":"google"`)

	response = doRequest(t, http.MethodPost, harness.baseURL+"/v1/responses", `{"model":"combo/balanced","stream":true,"input":"hello"}`)
	assertStatusContains(t, response, http.StatusOK, "event: response.completed")
	resolved := capture.Last()
	if resolved.Provider != "openai" || resolved.Model != "gpt-canned" || resolved.Selector != "combo/balanced" {
		t.Fatalf("combo resolved model = %#v", resolved)
	}

	records := recorder.Records()
	if len(records) != 2 {
		t.Fatalf("usage record count = %d, want 2: %#v", len(records), records)
	}
	for _, record := range records {
		if record.Usage.InputTokens != 7 || record.Usage.OutputTokens != 3 || record.Status != types.OutcomeSuccess {
			t.Fatalf("usage record = %#v", record)
		}
	}

	harness.cancel()
	select {
	case err := <-harness.done:
		if err != nil {
			t.Fatalf("proxy shutdown error = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("proxy did not shut down cleanly")
	}
}

type responseData struct {
	status int
	body   string
}

func doRequest(t *testing.T, method, url, body string) responseData {
	t.Helper()
	request, err := http.NewRequest(method, url, bytes.NewBufferString(body))
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
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return responseData{status: response.StatusCode, body: string(payload)}
}

func assertStatusContains(t *testing.T, response responseData, wantStatus int, fragments ...string) {
	t.Helper()
	if response.status != wantStatus {
		t.Fatalf("status = %d, want %d; body=%s", response.status, wantStatus, response.body)
	}
	for _, fragment := range fragments {
		if !strings.Contains(response.body, fragment) {
			t.Fatalf("body does not contain %q: %s", fragment, response.body)
		}
	}
}
