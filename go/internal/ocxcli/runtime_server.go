package ocxcli

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/embeddedui"
	"github.com/lidge-jun/opencodex/go/internal/managementauth"
	"github.com/lidge-jun/opencodex/go/internal/sidecar"
)

// processInspector is deliberately narrow so reclaim decisions can be tested
// without giving tests permission to signal arbitrary processes.
type processInspector interface {
	Alive(pid int) bool
	Command(pid int) (string, error)
	Terminate(pid int, signal string) error
}

type osProcessInspector struct{}

func (osProcessInspector) Alive(pid int) bool { return doctorProcessAlive(pid) }

func (osProcessInspector) Command(pid int) (string, error) {
	return readProcessCommandLine(pid)
}
func (osProcessInspector) Terminate(pid int, signal string) error {
	if signal != "TERM" {
		return errors.New("unsupported signal")
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Signal(syscall.SIGTERM)
}

// runtimeGOOS is a test seam for platform-branched process inspection.
var runtimeGOOS = func() string { return runtime.GOOS }

type portReclaimer struct {
	home    string
	process processInspector
}

func (r portReclaimer) reclaim(port int) error {
	if port < 1 {
		return nil
	}
	pidPath := filepath.Join(r.home, "ocx.pid")
	runtimePath := filepath.Join(r.home, "runtime-port.json")
	pid := int(readPidFileValue(pidPath))
	// Snapshot both records BEFORE the liveness probe: a replacement runtime
	// can rewrite them while the probe is in flight, and the purge below is
	// authorized only by the exact values observed here (#34).
	runtimeRecordPid := readRuntimePortSnapshotForGuard(runtimePath)
	if pid == 0 {
		if listenerAvailable(port) {
			return nil
		}
		return fmt.Errorf("port %d is occupied by a process that is not the recorded OpenCodex runtime", port)
	}
	if !r.process.Alive(pid) {
		// Stale by liveness: purge only the exact records snapshotted above,
		// so a replacement runtime that started mid-check keeps its state.
		removePidIfValueIs(pidPath, int64(pid))
		removeRuntimePortIfPidIs(runtimePath, runtimeRecordPid)
		return nil
	}
	command, commandErr := r.process.Command(pid)
	if !isOcxStartCommandLine(command) {
		if commandErr == nil {
			// A readable command line that is not an ocx start command means
			// the PID was recycled: refuse to touch it (#34).
			return fmt.Errorf("port %d is occupied by a process that is not a reclaimable OpenCodex runtime", port)
		}
		// Command inspection unavailable: fail open to the previous
		// alive-PID behavior (#34 compatibility for locked-down hosts).
	}
	if err := r.process.Terminate(pid, "TERM"); err != nil {
		return fmt.Errorf("stop stale OpenCodex runtime %d: %w", pid, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for r.process.Alive(pid) && time.Now().Before(deadline) {
		time.Sleep(25 * time.Millisecond)
	}
	if r.process.Alive(pid) {
		return fmt.Errorf("OpenCodex runtime %d did not exit; refusing to steal port %d", pid, port)
	}
	if !listenerAvailable(port) {
		return fmt.Errorf("port %d remains occupied after OpenCodex runtime stopped", port)
	}
	removePidIfValueIs(pidPath, int64(pid))
	removeRuntimePortIfPidIs(runtimePath, runtimeRecordPid)
	return nil
}

func listenerAvailable(port int) bool {
	l, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

// readRuntimePortSnapshotForGuard reads the pid the snapshot guard should
// compare against. An unreadable record is represented by zero, matching the
// TypeScript null snapshot so malformed state can be purged when unchanged.
func readRuntimePortSnapshotForGuard(path string) int64 {
	if record, err := readStatusRuntimeRecordAt(path); err == nil {
		return record.PID
	}
	return 0
}

type standaloneServer struct {
	listener net.Listener
	http     *http.Server
	handler  http.Handler
	home     string
	pid      int
	port     int
	hostname string
	secret   string
	version  string
	started  time.Time
}

func newStandaloneServer(listen, version string) (*standaloneServer, error) {
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		return nil, err
	}
	home, err := config.Dir()
	if err != nil {
		_ = listener.Close()
		return nil, err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		_ = listener.Close()
		return nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	secretRaw := make([]byte, 32)
	if _, err := rand.Read(secretRaw); err != nil {
		_ = listener.Close()
		return nil, err
	}
	server := &standaloneServer{listener: listener, home: home, pid: os.Getpid(), port: port, hostname: listenHost(listener.Addr()), secret: base64.RawURLEncoding.EncodeToString(secretRaw), version: version, started: time.Now()}
	server.handler = server.routes()
	server.http = &http.Server{Handler: server.handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	if err := server.writeRuntime(); err != nil {
		_ = listener.Close()
		_ = removeRuntimeRecordsFor(home, int64(server.pid))
		return nil, err
	}
	return server, nil
}

func (s *standaloneServer) routes() http.Handler {
	dashboard := embeddedui.NewHandler(s.version)
	goOwned := sidecar.NewHandler(sidecar.Config{Service: "opencodex", Version: s.version, StartedAt: s.started, ConfigDir: s.home})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			if r.Method != http.MethodGet {
				http.NotFound(w, r)
				return
			}
			if challenge := r.Header.Get(attestationChallengeHeader); challenge != "" {
				w.Header().Set(attestationProofHeader, managementauth.CreateLocalAttestationProof(s.secret, challenge, int64(s.pid), s.port))
			}
			writeRuntimeJSON(w, http.StatusOK, Health{Status: "ok", Service: "opencodex", Version: s.version, Uptime: time.Since(s.started).Seconds(), PID: int64(s.pid), Port: s.port})
		case "/readyz":
			if r.Method != http.MethodGet {
				http.NotFound(w, r)
				return
			}
			writeRuntimeJSON(w, http.StatusOK, readiness{Service: "opencodex", Version: s.version, Uptime: time.Since(s.started).Seconds(), PID: int64(s.pid), Port: s.port, Status: "ready"})
		case "/readyz/":
			http.NotFound(w, r)
		case "/api/stop":
			if r.Method != http.MethodPost {
				http.NotFound(w, r)
				return
			}
			writeRuntimeJSON(w, http.StatusOK, map[string]any{"ok": true})
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = s.Close(ctx)
			}()
		default:
			if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/v1/responses" {
				goOwned.ServeHTTP(w, r)
				return
			}
			dashboard.ServeHTTP(w, r)
		}
	})
}

func writeRuntimeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func listenHost(addr net.Addr) string {
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil || host == "" || host == "0.0.0.0" || host == "::" {
		return "127.0.0.1"
	}
	return strings.Trim(host, "[]")
}

// writeRuntime publishes both state files byte-compatibly with TypeScript:
// ocx.pid is exactly the decimal pid with no trailing newline (writePid in
// src/config/process-state.ts), runtime-port.json is two-space-indented JSON
// with one trailing newline. Both go through the atomic temp/rename writer so
// a crash mid-write can never publish a torn pid file.
func (s *standaloneServer) writeRuntime() error {
	if err := writeStateFileAtomic(filepath.Join(s.home, "ocx.pid"), []byte(strconv.Itoa(s.pid))); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(RuntimeState{PID: int64(s.pid), Port: s.port, Hostname: s.hostname, AttestationSecret: s.secret}, "", "  ")
	if err != nil {
		return err
	}
	return writeStateFileAtomic(filepath.Join(s.home, "runtime-port.json"), append(raw, '\n'))
}
func (s *standaloneServer) Serve() error { return s.http.Serve(s.listener) }
func (s *standaloneServer) Close(ctx context.Context) error {
	err := s.http.Shutdown(ctx)
	// Guarded by this server's own pid: a replacement runtime that already
	// rewrote the records must not lose them to our shutdown sweep (#34).
	_ = removeRuntimeRecordsFor(s.home, int64(s.pid))
	return err
}

func runStart(args []string, deps Deps) int {
	portOverride := 0
	for i := 0; i < len(args); i++ {
		if args[i] == "--port" && i+1 < len(args) {
			parsed, err := strconv.Atoi(args[i+1])
			if err != nil || parsed < 1 || parsed > 65535 {
				fmt.Fprintln(deps.Stderr, "Usage: ocx start [--port <port>]")
				return ExitUsage
			}
			portOverride = parsed
			i++
			continue
		}
		fmt.Fprintln(deps.Stderr, "Usage: ocx start [--port <port>]")
		return ExitUsage
	}
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	port, host := cfg.ListenTarget()
	if portOverride > 0 {
		port = portOverride
	}
	if host == "" {
		host = "127.0.0.1"
	}
	home, err := config.Dir()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	if err := (portReclaimer{home: home, process: osProcessInspector{}}).reclaim(port); err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	server, err := newStandaloneServer(net.JoinHostPort(host, strconv.Itoa(port)), deps.Version)
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	fmt.Fprintf(deps.Stdout, "OpenCodex listening on http://%s\n", server.listener.Addr())
	return serveUntilSignal(server, deps.Stderr)
}
func serveUntilSignal(server *standaloneServer, stderr io.Writer) int {
	done := make(chan error, 1)
	go func() { done <- server.Serve() }()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case <-signals:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Close(ctx); err != nil {
			fmt.Fprintln(stderr, err)
			return ExitFailure
		}
		return ExitOK
	case err := <-done:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintln(stderr, err)
			return ExitFailure
		}
		return ExitOK
	}
}

// runStop implements the Go-owned stop ladder for the standalone runtime:
// graceful drain through POST /api/stop when the listener answers, then
// SIGTERM with a bounded wait, then a hard refusal rather than SIGKILL-by-
// default: killing an unknown owner is the same hazard port reclaim guards
// against. Runtime records are cleared only after the process is gone.
func runStop(args []string, deps Deps) int {
	if len(args) != 0 {
		fmt.Fprintln(deps.Stderr, "Usage: ocx stop")
		return ExitUsage
	}
	state, err := deps.ReadRuntime()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(deps.Stdout, "No proxy is running.")
			return ExitOK
		}
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	home, err := config.Dir()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	inspector := osProcessInspector{}
	if !inspector.Alive(int(state.PID)) {
		_ = removeRuntimeRecordsFor(home, state.PID)
		fmt.Fprintf(deps.Stdout, "No proxy is running (stale record for PID %d removed).\n", state.PID)
		return ExitOK
	}
	if command, commandErr := inspector.Command(int(state.PID)); commandErr == nil && !isOcxStartCommandLine(command) {
		// #34: the PID is alive but no longer names an OpenCodex runtime —
		// the OS recycled it. Signaling it would kill an unrelated process.
		fmt.Fprintf(deps.Stderr, "Recorded PID %d is alive but is not an OpenCodex runtime; refusing to stop it.\n", state.PID)
		fmt.Fprintln(deps.Stderr, "Stop the actual proxy (see 'ocx status'), or remove the stale record manually.")
		return ExitFailure
	}
	client := &http.Client{Timeout: 10 * time.Second}
	host := strings.TrimSpace(state.Hostname)
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "127.0.0.1"
	}
	stopURL := fmt.Sprintf("http://%s/api/stop", net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(state.Port)))
	request, requestErr := http.NewRequest(http.MethodPost, stopURL, nil)
	graceful := false
	if requestErr == nil {
		if response, doErr := client.Do(request); doErr == nil {
			_ = response.Body.Close()
			graceful = response.StatusCode == http.StatusOK
		}
	}
	if !graceful {
		process, signalErr := os.FindProcess(int(state.PID))
		if signalErr == nil {
			signalErr = process.Signal(syscall.SIGTERM)
		}
		if err := signalErr; err != nil {
			fmt.Fprintf(deps.Stderr, "Failed to stop proxy (PID %d): %v\n", state.PID, err)
			return ExitFailure
		}
	}
	deadline := time.Now().Add(8 * time.Second)
	for inspector.Alive(int(state.PID)) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if inspector.Alive(int(state.PID)) {
		fmt.Fprintf(deps.Stderr, "Proxy (PID %d) did not exit after stop request.\n", state.PID)
		return ExitFailure
	}
	_ = removeRuntimeRecordsFor(home, state.PID)
	fmt.Fprintf(deps.Stdout, "Proxy (PID %d) stopped.\n", state.PID)
	return ExitOK
}
