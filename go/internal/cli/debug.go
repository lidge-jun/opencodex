package cli

import (
	"fmt"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func runDebug(args []string, streams IO) error {
	command := "status"
	if len(args) > 0 {
		command = args[0]
	}
	if len(args) > 1 {
		return fmt.Errorf("usage: ocx debug <status|on|off|stack-on|stack-off>")
	}
	cfg, path, err := loadConfig()
	if err != nil {
		return err
	}
	switch command {
	case "status":
		fmt.Fprintf(streams.Out, "debug=%t includeStack=%t logLevel=%s logFile=%s\n", cfg.Debug.Enabled, cfg.Debug.IncludeStack, cfg.Log.Level, cfg.Log.File)
		return nil
	case "on":
		cfg.Debug.Enabled = true
	case "off":
		cfg.Debug.Enabled = false
	case "stack-on":
		cfg.Debug.Enabled, cfg.Debug.IncludeStack = true, true
	case "stack-off":
		cfg.Debug.IncludeStack = false
	default:
		return fmt.Errorf("unknown debug subcommand %q", command)
	}
	return config.Save(path, cfg)
}
