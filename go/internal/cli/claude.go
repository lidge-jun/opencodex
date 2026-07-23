package cli

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strconv"

	"github.com/lidge-jun/opencodex-go/internal/platform"
)

func runClaude(ctx context.Context, args []string, streams IO) error {
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	_, port := readRuntime()
	if port <= 0 {
		port = cfg.Port
	}
	host := cfg.Host
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	baseURL := "http://" + net.JoinHostPort(host, strconv.Itoa(port))
	var command *exec.Cmd
	if runtime.GOOS == "windows" {
		command = platform.WindowsCommand("claude", args...)
	} else {
		command = exec.CommandContext(ctx, "claude", args...)
	}
	command.Stdin, command.Stdout, command.Stderr = streams.In, streams.Out, streams.Err
	command.Env = append(os.Environ(), "ANTHROPIC_BASE_URL="+baseURL, "ANTHROPIC_AUTH_TOKEN="+defaultToken(cfg.AuthToken), "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1")
	if err := command.Run(); err != nil {
		return fmt.Errorf("launch Claude Code: %w", err)
	}
	return nil
}

func defaultToken(token string) string {
	if token != "" {
		return token
	}
	return "opencodex-local"
}
