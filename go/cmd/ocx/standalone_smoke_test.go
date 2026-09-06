package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStandaloneBinaryServesEmbeddedDashboardWithoutCheckout(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", "..", ".."))
	binary := filepath.Join(t.TempDir(), "ocx")
	build := exec.Command("go", "build", "-buildvcs=false", "-o", binary, ".")
	build.Dir = "."
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	clean := t.TempDir()
	env := append(os.Environ(), "HOME="+clean, "USERPROFILE="+clean, "OPENCODEX_HOME="+filepath.Join(clean, ".opencodex"), "PATH="+t.TempDir())
	for _, args := range [][]string{{"--version"}, {"--help"}, {"codex-shim", "status"}} {
		command := exec.Command(binary, args...)
		command.Dir, command.Env = clean, env
		if output, err := command.CombinedOutput(); err != nil || len(bytes.TrimSpace(output)) == 0 {
			t.Fatalf("%s: %v %s", args, err, output)
		}
	}
	// The lifecycle owner has intentionally not moved in #40. A standalone binary
	// must fail with a repairable instruction instead of assuming a checkout/Bun.
	service := exec.Command(binary, "service", "status")
	service.Dir, service.Env = clean, env
	output, err := service.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "OCX_TYPESCRIPT_CLI") {
		t.Fatalf("service status error = %v output=%q", err, output)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	command := exec.CommandContext(ctx, binary, "serve-dashboard", "--listen", "127.0.0.1:0")
	command.Dir, command.Env = clean, env
	var stdout bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stdout
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); _ = command.Wait() })
	deadline := time.Now().Add(5 * time.Second)
	var base string
	for time.Now().Before(deadline) {
		for _, line := range strings.Split(stdout.String(), "\n") {
			if strings.HasPrefix(line, "OpenCodex embedded dashboard listening on http://") {
				base = strings.TrimPrefix(line, "OpenCodex embedded dashboard listening on ")
				break
			}
		}
		if base != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if base == "" {
		t.Fatalf("server did not announce listener: %q", stdout.String())
	}
	for _, path := range []string{"/healthz", "/"} {
		response, err := http.Get(base + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK || len(body) == 0 {
			t.Fatalf("GET %s = %d %q", path, response.StatusCode, body)
		}
	}
	_ = root
}
