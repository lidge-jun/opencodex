package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"time"
)

type Liveness struct {
	Started time.Time
	Version string
}

func NewLiveness(version string) *Liveness { return &Liveness{Started: time.Now(), Version: version} }
func (l *Liveness) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"service": "opencodex", "status": "ok", "version": l.Version, "uptime": time.Since(l.Started).Seconds(), "pid": os.Getpid()})
}

// ProbeLiveness verifies both HTTP success and opencodex service identity.
func ProbeLiveness(ctx context.Context, client *http.Client, url string) bool {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	if client == nil {
		client = &http.Client{Timeout: 750 * time.Millisecond}
	}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	var body struct {
		Service string `json:"service"`
		Status  string `json:"status"`
	}
	return json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&body) == nil && body.Service == "opencodex" && body.Status == "ok"
}
