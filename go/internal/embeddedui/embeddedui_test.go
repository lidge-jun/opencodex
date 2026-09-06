package embeddedui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerServesEmbeddedDashboardAndHealth(t *testing.T) {
	handler := NewHandler("9.9.9")
	for _, test := range []struct{ path, wantType, wantBody string }{
		{"/", "text/html", "opencodex"},
		{"/dashboard/providers", "text/html", "opencodex"},
		{"/healthz", "application/json", "\"service\":\"opencodex\""},
	} {
		request := httptest.NewRequest(http.MethodGet, test.path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d", test.path, response.Code)
		}
		if !strings.Contains(response.Header().Get("Content-Type"), test.wantType) {
			t.Fatalf("%s content type = %q", test.path, response.Header().Get("Content-Type"))
		}
		if !strings.Contains(response.Body.String(), test.wantBody) {
			t.Fatalf("%s body = %q", test.path, response.Body.String())
		}
	}
}

func TestHandlerRejectsEscapingPathsAndUnknownAsset(t *testing.T) {
	handler := NewHandler("9.9.9")
	for _, path := range []string{"/../go.mod", "/assets/missing.js"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", path, response.Code)
		}
	}
}
