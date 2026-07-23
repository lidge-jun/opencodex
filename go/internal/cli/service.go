package cli

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/service"
)

func runService(args []string, streams IO) error {
	command := "install"
	if len(args) > 0 {
		command = args[0]
		args = args[1:]
	}
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx service [install|start|stop|status|uninstall]")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	manager, err := service.NewManager(serviceConfig(*cfg))
	if err != nil {
		return err
	}
	switch command {
	case "install":
		if err := prepareServiceToken(*cfg); err != nil {
			return err
		}
		if err := manager.Install(); err != nil {
			return err
		}
		fmt.Fprintf(streams.Out, "Service installed and started: %s\n", manager.ArtifactPath())
	case "start":
		return manager.Start()
	case "stop":
		if err := manager.Stop(); err != nil {
			return err
		}
		return stopTrackedProxy(*cfg)
	case "uninstall", "remove":
		if err := manager.Uninstall(); err != nil {
			return err
		}
		if err := stopTrackedProxy(*cfg); err != nil {
			return err
		}
		dir, _ := configDir()
		_ = os.Remove(filepath.Join(dir, "service-api-token"))
		return nil
	case "status":
		status, statusErr := manager.Status()
		if statusErr != nil {
			return statusErr
		}
		fmt.Fprintf(streams.Out, "installed=%t running=%t artifact=%s\n", status.Installed, status.Running, manager.ArtifactPath())
		if status.Detail != "" {
			fmt.Fprintln(streams.Out, status.Detail)
		}
	default:
		return fmt.Errorf("unknown service subcommand %q", command)
	}
	return nil
}

func stopTrackedProxy(cfg config.Config) error {
	pid, port := readRuntime()
	if pid <= 0 {
		return nil
	}
	if port <= 0 {
		port = cfg.Port
	}
	if port <= 0 {
		port = config.DefaultPort
	}
	token, _ := platform.LoadServiceToken(os.Getenv("OPENCODEX_API_AUTH_TOKEN"), filepath.Join(mustConfigDir(), "service-api-token"))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return platform.StopProcess(ctx, pid, serviceBaseURLAt(cfg, port), token)
}

func mustConfigDir() string { dir, _ := configDir(); return dir }

func serviceBaseURLAt(cfg config.Config, port int) string {
	host := cfg.Host
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port))
}

func serviceConfig(cfg config.Config) service.Config {
	executable, _ := os.Executable()
	dir, _ := configDir()
	path, _ := configPath()
	port := cfg.Port
	if port <= 0 {
		port = config.DefaultPort
	}
	environment := map[string]string{"OCX_SERVICE": "1", "PATH": os.Getenv("PATH"), "OCX_API_TOKEN_FILE": filepath.Join(dir, "service-api-token")}
	if value := strings.TrimSpace(os.Getenv("CODEX_HOME")); value != "" {
		environment["CODEX_HOME"] = value
	}
	if value := strings.TrimSpace(os.Getenv("OPENCODEX_HOME")); value != "" {
		environment["OPENCODEX_HOME"] = value
	}
	arguments := []string{"serve", "--service", "--config", path, "--token-file", filepath.Join(dir, "service-api-token"), "--port", strconv.Itoa(port)}
	if codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME")); codexHome != "" {
		arguments = append(arguments, "--codex-home", codexHome)
	}
	return service.Config{
		Executable:  executable,
		Arguments:   arguments,
		Environment: environment,
		LogPath:     filepath.Join(dir, "service.log"),
		StateDir:    dir,
	}
}

func prepareServiceToken(cfg config.Config) error {
	host := strings.TrimSpace(cfg.Host)
	loopback := host == "" || host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
	token := strings.TrimSpace(os.Getenv("OPENCODEX_API_AUTH_TOKEN"))
	if token == "" {
		token = strings.TrimSpace(cfg.AuthToken)
	}
	if !loopback && token == "" {
		return fmt.Errorf("OPENCODEX_API_AUTH_TOKEN is required for non-loopback service binds")
	}
	if token == "" {
		return nil
	}
	if strings.ContainsAny(token, "\r\n") {
		return fmt.Errorf("service token must not contain line breaks")
	}
	dir, err := configDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, "service-api-token")
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		return err
	}
	return platform.HardenSecretPath(path, false)
}

func serviceBaseURL(cfg config.Config) string {
	host := cfg.Host
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(cfg.Port))
}
