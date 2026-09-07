package ocxcli

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReclaimPortRemovesStaleProcessRecords(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ocx.pid"), []byte("999999\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "runtime-port.json"), []byte("{\"pid\":999999,\"port\":10100}"), 0o600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("loopback listeners unavailable: %v", err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	reclaimer := portReclaimer{home: dir, process: &fakeProcess{alive: false}}
	if err := reclaimer.reclaim(port); err != nil {
		t.Fatalf("reclaim stale state: %v", err)
	}
	for _, name := range []string{"ocx.pid", "runtime-port.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s remains: %v", name, err)
		}
	}
}

func TestReclaimPortTerminatesKnownTypeScriptOwner(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ocx.pid"), []byte("42\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	process := &fakeProcess{alive: true, command: "bun src/cli/index.ts start"}
	reclaimer := portReclaimer{home: dir, process: process}
	// Hold no listener and use a port outside the recorded state: the reclaimer
	// must still terminate the live recorded TS runtime and clear the records.
	if err := reclaimer.reclaim(10100); err != nil {
		t.Fatalf("reclaim TS owner: %v", err)
	}
	if !process.terminated || process.signal != "TERM" {
		t.Fatalf("process = %#v", process)
	}
}

func TestReclaimPortRefusesForeignListener(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	process := &fakeProcess{alive: true, command: "python foreign-server.py"}
	reclaimer := portReclaimer{home: t.TempDir(), process: process}
	if err := reclaimer.reclaim(port); err == nil || !strings.Contains(err.Error(), "occupied") {
		t.Fatalf("reclaim error = %v", err)
	}
	if process.terminated {
		t.Fatal("foreign process was terminated")
	}
}

func TestStandaloneServerOwnsListenerDashboardHealthAndGoRoutes(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	server, err := newStandaloneServer("127.0.0.1:0", "9.9.9")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	go server.Serve()
	base := "http://" + server.listener.Addr().String()
	for _, path := range []string{"/", "/healthz", "/api/custom-models"} {
		response, err := http.Get(base + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body := new(bytes.Buffer)
		_, _ = body.ReadFrom(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK || body.Len() == 0 {
			t.Fatalf("GET %s = %d %q", path, response.StatusCode, body.String())
		}
	}
	ready := httptest.NewRecorder()
	server.handler.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusOK || !strings.Contains(ready.Body.String(), "\"status\":\"ready\"") {
		t.Fatalf("ready = %d %s", ready.Code, ready.Body.String())
	}
	raw, err := os.ReadFile(filepath.Join(home, "runtime-port.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "\"pid\"") || !strings.Contains(string(raw), "\"attestationSecret\"") {
		t.Fatalf("runtime record = %s", raw)
	}
}

func TestStandaloneServerApiStopDrainsAndReleasesRecords(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	server, err := newStandaloneServer("127.0.0.1:0", "9.9.9")
	if err != nil {
		t.Skipf("loopback listeners unavailable: %v", err)
	}
	go server.Serve()
	base := "http://" + server.listener.Addr().String()
	response, err := http.Post(base+"/api/stop", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /api/stop: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/stop = %d", response.StatusCode)
	}
	deadline := time.Now().Add(5 * time.Second)
	for _, statErr := os.Stat(filepath.Join(home, "runtime-port.json")); !errors.Is(statErr, os.ErrNotExist) && time.Now().Before(deadline); {
		time.Sleep(25 * time.Millisecond)
		_, statErr = os.Stat(filepath.Join(home, "runtime-port.json"))
	}
	if _, statErr := os.Stat(filepath.Join(home, "runtime-port.json")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("runtime record remains: %v", statErr)
	}
}

type fakeProcess struct {
	alive      bool
	command    string
	terminated bool
	signal     string
}

func (p *fakeProcess) Alive(int) bool              { return p.alive }
func (p *fakeProcess) Command(int) (string, error) { return p.command, nil }
func (p *fakeProcess) Terminate(_ int, signal string) error {
	p.terminated = true
	p.signal = signal
	p.alive = false
	return nil
}
