// Command ocx-sidecar is the first Go-owned process of the incremental
// runtime takeover (ADR-0008). It is spawned and supervised by the
// TypeScript proxy front door and serves the declared Go-owned read-only
// management routes (today: GET /api/system/health and
// GET /api/shadow-call-settings) with byte-identical HTTP semantics to the
// in-process TypeScript handlers. See go/internal/sidecar for the contract.
//
// The binary is built CGO_ENABLED=0 and carries no state: everything it must
// echo from the parent (service label, package version) arrives through the
// environment at spawn time, and the config read route reads the operator's
// config.json from the same OPENCODEX_HOME the parent was launched with.
package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/sidecar"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "ocx-sidecar:", err)
		os.Exit(1)
	}
}

func run() error {
	// Differential-oracle subcommands (ADR-0008 tickets #18/#19). The
	// supervisor never passes an argument, so the live sidecar path is
	// unaffected; these exist so the Bun oracle can evaluate the same request
	// vectors and Lab-gate fixtures through the real Go code.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "authcheck":
			return runAuthCheck()
		case "labcheck":
			return runLabCheck()
		}
		return fmt.Errorf("unknown subcommand %q", os.Args[1])
	}
	return serve()
}

func serve() error {
	// Bind first, announce second: the parent only starts forwarding once it
	// has read the ready line, so announcing a listener that failed to bind
	// would leave the front door waiting on a dead child.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	addr := listener.Addr().String()

	cfg := sidecar.Config{
		Service:   "opencodex",
		Version:   os.Getenv("OCX_SIDECAR_VERSION"),
		StartedAt: time.Now(),
	}
	if cfg.Version == "" {
		fmt.Fprintln(os.Stderr, "ocx-sidecar: warning: OCX_SIDECAR_VERSION is unset; reporting version 0.0.0")
	}

	server := &http.Server{
		Handler:           sidecar.NewHandler(cfg),
		ReadHeaderTimeout: 5 * time.Second,
		// Health responses are tiny; an idle client must not pin a socket.
		IdleTimeout: 30 * time.Second,
	}

	// The readiness contract: exactly one line on stdout, "<prefix> http://<host>:<port>".
	// The TypeScript supervisor (src/server/go-sidecar.ts) waits for this line before it
	// registers the sidecar as the owner of GET /api/system/health.
	fmt.Printf("%s http://%s\n", sidecar.ReadyLinePrefix, addr)

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- server.Serve(listener)
	}()

	// Terminate cleanly on SIGTERM/SIGINT so the supervising front door can
	// stop the sidecar without a zombie or a half-written health response.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	select {
	case sig := <-signals:
		fmt.Fprintf(os.Stderr, "ocx-sidecar: received %s; shutting down\n", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			return fmt.Errorf("shutdown: %w", err)
		}
		return nil
	case err := <-serveErr:
		if err == nil {
			return nil
		}
		return fmt.Errorf("serve: %w", err)
	}
}
