package cli

import (
	"context"
	"fmt"
	"net"
	"os"
	"runtime"
	"time"
)

func runDoctor(ctx context.Context, args []string, streams IO) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx doctor")
	}
	dir, err := configDir()
	if err != nil {
		return err
	}
	cfg, path, configErr := loadConfig()
	fmt.Fprintf(streams.Out, "OS: %s/%s\nConfig directory: %s\nConfig file: %s\n", runtime.GOOS, runtime.GOARCH, dir, path)
	if configErr != nil {
		fmt.Fprintf(streams.Out, "[FAIL] config: %v\n", configErr)
	} else {
		fmt.Fprintln(streams.Out, "[PASS] config parses and validates")
	}
	if info, statErr := os.Stat(dir); statErr == nil {
		fmt.Fprintf(streams.Out, "[PASS] config directory mode: %s\n", info.Mode().Perm())
	} else if !os.IsNotExist(statErr) {
		fmt.Fprintf(streams.Out, "[FAIL] config directory: %v\n", statErr)
	}
	if cfg != nil {
		probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		connection, dialErr := (&net.Dialer{}).DialContext(probeCtx, "tcp", "chatgpt.com:443")
		if dialErr != nil {
			fmt.Fprintf(streams.Out, "[WARN] ChatGPT network probe: %v\n", dialErr)
		} else {
			connection.Close()
			fmt.Fprintln(streams.Out, "[PASS] outbound HTTPS connectivity")
		}
		_, port := readRuntime()
		fmt.Fprintf(streams.Out, "[INFO] proxy health: %t\n", probeHealth(ctx, cfg.Host, port))
	}
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"} {
		if value := os.Getenv(name); value != "" {
			fmt.Fprintf(streams.Out, "[INFO] %s is set\n", name)
		}
	}
	return nil
}
