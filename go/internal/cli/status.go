package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/service"
)

func runStatus(ctx context.Context, args []string, streams IO) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx status")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	pid, port := readRuntime()
	healthy := probeHealth(ctx, cfg.Host, port)
	fmt.Fprintf(streams.Out, "Proxy:  healthy=%t pid=%d port=%d\n", healthy, pid, port)
	manager, managerErr := service.NewManager(serviceConfig(*cfg))
	if managerErr == nil {
		status, statusErr := manager.Status()
		if statusErr == nil {
			fmt.Fprintf(streams.Out, "Service: installed=%t running=%t\n", status.Installed, status.Running)
		}
	}
	if pid > 0 && !platform.ProcessAlive(pid) {
		fmt.Fprintln(streams.Out, "Runtime: stale PID file")
	}
	return nil
}

func readRuntime() (int, int) {
	pidPath, portPath, err := runtimePaths()
	if err != nil {
		return 0, 0
	}
	pidBytes, _ := os.ReadFile(pidPath)
	portBytes, _ := os.ReadFile(portPath)
	pid, _ := strconv.Atoi(string(pidBytes))
	port, _ := strconv.Atoi(string(portBytes))
	return pid, port
}

func probeHealth(parent context.Context, host string, port int) bool {
	if port <= 0 {
		return false
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort(host, strconv.Itoa(port))+"/health", nil)
	if err != nil {
		return false
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	var body struct {
		Service string `json:"service"`
		Status  string `json:"status"`
	}
	return response.StatusCode == http.StatusOK && json.NewDecoder(response.Body).Decode(&body) == nil && body.Service == "opencodex" && body.Status == "ok"
}
