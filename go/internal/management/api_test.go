package management

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestManagementRouteRegistration(t *testing.T) {
	cfg := config.Default()
	api, err := New(Options{Config: &cfg, Version: "test"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	mux := http.NewServeMux()
	api.Register(mux)

	for _, test := range []struct {
		method, path string
		want         int
	}{
		{http.MethodGet, "/api/config", http.StatusOK},
		{http.MethodPut, "/api/config", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/providers", http.StatusOK},
		{http.MethodGet, "/api/system/runtime", http.StatusOK},
	} {
		request := httptest.NewRequest(test.method, test.path, nil)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != test.want {
			t.Errorf("%s %s status = %d, want %d; body=%s", test.method, test.path, response.Code, test.want, response.Body.String())
		}
	}

	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/not-registered", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("unregistered status = %d, want 404", response.Code)
	}
}
