package embeddedui

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func get(t *testing.T, handler http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
	return response
}

// fallbackHandler pins the resolver to "no live build" so fallback tests stay
// hermetic even when the checkout carries a gui/dist build.
func fallbackHandler() http.Handler {
	return NewHandlerWithResolver("9.9.9", func() string { return "" })
}

func TestFallbackServesThinDashboardAndHealth(t *testing.T) {
	handler := fallbackHandler()
	for _, test := range []struct{ path, wantBody string }{
		{"/", "opencodex proxy dashboard"},
		{"/dashboard/providers", "opencodex proxy dashboard"}, // SPA fallback to index.html
	} {
		response := get(t, handler, test.path)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d", test.path, response.Code)
		}
		if !strings.Contains(response.Header().Get("Content-Type"), "text/html") {
			t.Fatalf("%s content type = %q", test.path, response.Header().Get("Content-Type"))
		}
		if !strings.Contains(response.Body.String(), test.wantBody) {
			t.Fatalf("%s body = %q", test.path, response.Body.String())
		}
	}
	health := get(t, handler, "/healthz")
	if health.Code != http.StatusOK || !strings.Contains(health.Body.String(), "\"service\":\"opencodex\"") {
		t.Fatalf("/healthz = %d %q", health.Code, health.Body.String())
	}
}

func TestFallbackServesProviderIconsFromMirroredSource(t *testing.T) {
	handler := fallbackHandler()
	for _, path := range []string{"/favicon.png", "/provider-icons/openai.svg", "/icons.svg"} {
		response := get(t, handler, path)
		if response.Code != http.StatusOK || response.Body.Len() == 0 {
			t.Fatalf("GET %s = %d len=%d", path, response.Code, response.Body.Len())
		}
	}
}

func TestLiveDashboardOverlayTakesPrecedence(t *testing.T) {
	dist := t.TempDir()
	assets := filepath.Join(dist, "assets")
	if err := os.MkdirAll(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	liveIndex := "<!doctype html><title>live</title>"
	if err := os.WriteFile(filepath.Join(dist, "index.html"), []byte(liveIndex), 0o644); err != nil {
		t.Fatal(err)
	}
	liveAsset := "console.log('live');"
	if err := os.WriteFile(filepath.Join(assets, "index-deadbeef.js"), []byte(liveAsset), 0o644); err != nil {
		t.Fatal(err)
	}
	handler := NewHandlerWithResolver("9.9.9", func() string { return dist })

	root := get(t, handler, "/")
	if root.Code != http.StatusOK || root.Body.String() != liveIndex {
		t.Fatalf("/ = %d %q, want the live build", root.Code, root.Body.String())
	}
	asset := get(t, handler, "/assets/index-deadbeef.js")
	if asset.Code != http.StatusOK || asset.Body.String() != liveAsset {
		t.Fatalf("asset = %d %q, want the live build file", asset.Code, asset.Body.String())
	}
	// A request that exists only in the embedded fallback must not shadow the
	// live build: unknown paths 404 instead of silently serving the fallback.
	missing := get(t, handler, "/assets/nope.js")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing asset = %d, want 404", missing.Code)
	}
	// Extensionless SPA paths fall back to the live build's index.html.
	spa := get(t, handler, "/logs")
	if spa.Code != http.StatusOK || spa.Body.String() != liveIndex {
		t.Fatalf("/logs = %d %q, want live index", spa.Code, spa.Body.String())
	}
}

func TestFallbackStillServedWhenLiveBuildLacksFile(t *testing.T) {
	dist := t.TempDir()
	if err := os.WriteFile(filepath.Join(dist, "index.html"), []byte("<!doctype html><title>live</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	handler := NewHandlerWithResolver("9.9.9", func() string { return dist })
	// favicon.png lives in the embedded tree (mirrored from gui/public), not in
	// the Vite build output; a live build must still fall back to the embed for
	// assets it does not ship.
	response := get(t, handler, "/favicon.png")
	if response.Code != http.StatusOK || response.Body.Len() == 0 {
		t.Fatalf("favicon = %d len=%d, want embedded fallback", response.Code, response.Body.Len())
	}
}

func TestHandlerRejectsEscapingPathsAndUnknownAsset(t *testing.T) {
	handler := fallbackHandler()
	for _, path := range []string{"/../go.mod", "/assets/missing.js", "/provider-icons/../secret"} {
		response := get(t, handler, path)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", path, response.Code)
		}
	}
}

func TestHandlerHeadAndMethodGuard(t *testing.T) {
	handler := fallbackHandler()
	head := httptest.NewRecorder()
	handler.ServeHTTP(head, httptest.NewRequest(http.MethodHead, "/", nil))
	if head.Code != http.StatusOK {
		t.Fatalf("HEAD / = %d", head.Code)
	}
	post := httptest.NewRecorder()
	handler.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/", nil))
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST / = %d, want 405", post.Code)
	}
	_ = io.Discard
}

func TestFindGuiDistWalksUpFromWorkingDirectory(t *testing.T) {
	original, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(original) })
	// The embeddedui package lives under <repo>/go/internal/embeddedui; the
	// repository root's gui/dist must be found two levels up. gui/dist exists
	// only when a GUI build ran locally, so make the assertion tolerant: when
	// the tree has no gui/dist, the walk must still terminate and find nothing
	// instead of walking off the filesystem root.
	got := findGuiDist()
	root := filepath.Dir(filepath.Dir(filepath.Dir(original)))
	if info, statErr := os.Stat(filepath.Join(root, "gui", "dist", "index.html")); statErr == nil && !info.IsDir() {
		if got != filepath.Join(root, "gui", "dist") {
			t.Fatalf("findGuiDist() = %q, want %q", got, filepath.Join(root, "gui", "dist"))
		}
	} else if got != "" {
		t.Fatalf("findGuiDist() = %q, want \"\" when no gui/dist exists", got)
	}
}
