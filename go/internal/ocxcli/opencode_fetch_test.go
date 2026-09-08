package ocxcli

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// opencodeFetchCatalog against an httptest server: header contract, error
// text mapping (mirroring fetchOpencodeProxyModels), and the array guard.

func TestOpencodeFetchCatalog(t *testing.T) {
	var sawAccept, sawKey string
	var modelsJSON = `[{"namespaced":"provider1/model-a","provider":"provider1","id":"model-a"}]`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAccept = r.Header.Get("Accept")
		sawKey = r.Header.Get("X-OpenCodex-API-Key")
		if r.URL.Path == "/api/models" {
			_, _ = w.Write([]byte(modelsJSON))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	host, portText := serverHostPort(t, server.URL)
	port, _ := strconv.Atoi(portText)
	state := RuntimeState{Hostname: host, Port: port}
	rows, err := opencodeFetchCatalog(Deps{}, state, "  the-key  ")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if sawAccept != "application/json" {
		t.Fatalf("Accept = %q", sawAccept)
	}
	if sawKey != "the-key" {
		t.Fatalf("X-OpenCodex-API-Key = %q (trimmed token expected)", sawKey)
	}
	if rows == nil || rows.Kind() != jsonwire.Array {
		t.Fatalf("rows = %v", rows)
	}
	if got := len(rows.Elements()); got != 1 {
		t.Fatalf("rows length = %d", got)
	}
}

func serverHostPort(t *testing.T, raw string) (string, string) {
	t.Helper()
	trimmed := strings.TrimPrefix(raw, "http://")
	host, port, ok := strings.Cut(trimmed, ":")
	if !ok {
		t.Fatalf("server url %q", raw)
	}
	return host, port
}

func TestOpencodeFetchCatalogErrorTexts(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		delay  time.Duration
		want   string
	}{
		{name: "body error string", status: 401, body: `{"error":"no such key"}`, want: "no such key"},
		{name: "status fallback", status: 503, body: ``, want: "Management request failed (503)"},
		{name: "status fallback non-object", status: 400, body: `"oops"`, want: "Management request failed (400)"},
		{name: "non-array payload", status: 200, body: `{"models":[]}`, want: "Management API returned an unexpected /api/models payload."},
		{name: "non-json payload", status: 200, body: `not json`, want: "Management API returned an unexpected /api/models payload."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.delay > 0 {
					time.Sleep(tc.delay)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			host, portText := serverHostPort(t, server.URL)
			port, _ := strconv.Atoi(portText)
			_, err := opencodeFetchCatalog(Deps{}, RuntimeState{Hostname: host, Port: port}, "key")
			if err == nil || err.Error() != tc.want {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestOpencodeFetchCatalogTimeoutText(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(400 * time.Millisecond)
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()
	host, portText := serverHostPort(t, server.URL)
	port, _ := strconv.Atoi(portText)
	deps := Deps{HTTPClient: &http.Client{Timeout: 80 * time.Millisecond}}
	_, err := opencodeFetchCatalog(deps, RuntimeState{Hostname: host, Port: port}, "key")
	if err == nil || err.Error() != "Management API timed out while fetching /api/models." {
		t.Fatalf("err = %v, want the timeout text", err)
	}
}

// TestOpencodeFetchCatalogUnauthenticatedHeaders pins that an empty trimmed
// token sends no admission header (mirroring the TS fetch).
func TestOpencodeFetchCatalogUnauthenticatedHeaders(t *testing.T) {
	var sawKey bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawKey = r.Header.Get("X-OpenCodex-API-Key") != ""
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()
	host, portText := serverHostPort(t, server.URL)
	port, _ := strconv.Atoi(portText)
	if _, err := opencodeFetchCatalog(Deps{}, RuntimeState{Hostname: host, Port: port}, "   "); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if sawKey {
		t.Fatal("admission header sent for an empty token")
	}
}

// TestOpencodeLaunchChildEnv pins the child environment assembly: both owned
// keys are replaced (not appended) and everything else passes through.
func TestOpencodeLaunchChildEnv(t *testing.T) {
	t.Setenv("OPENCODE_CONFIG_CONTENT", "stale-content")
	t.Setenv("OPENCODEX_OPENCODE_API_KEY", "stale-key")
	t.Setenv("KEEP_ME", "v")
	env := opencodeLaunchChildEnv(`{"$schema":"https://opencode.ai/config.json"}`, "real-key")
	seen := map[string]string{}
	for _, kv := range env {
		key, value, _ := strings.Cut(kv, "=")
		seen[key] = value
	}
	if seen["OPENCODE_CONFIG_CONTENT"] != `{"$schema":"https://opencode.ai/config.json"}` {
		t.Fatalf("content key = %q", seen["OPENCODE_CONFIG_CONTENT"])
	}
	if seen["OPENCODEX_OPENCODE_API_KEY"] != "real-key" {
		t.Fatalf("admission key = %q", seen["OPENCODEX_OPENCODE_API_KEY"])
	}
	if seen["KEEP_ME"] != "v" {
		t.Fatalf("foreign env lost: %q", seen["KEEP_ME"])
	}
	count := 0
	for _, kv := range env {
		if strings.HasPrefix(kv, "OPENCODE_CONFIG_CONTENT=") || strings.HasPrefix(kv, "OPENCODEX_OPENCODE_API_KEY=") {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("owned keys appear %d times (want exactly 2 replacements)", count)
	}
}
