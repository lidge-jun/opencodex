package cli

import (
	"fmt"
	"io"
)

var commandHelp = map[string]string{
	"serve":    "Usage: ocx serve [--host HOST] [--port PORT]\n\nStart the proxy in the foreground.",
	"account":  "Usage: ocx account <list|switch|add|remove|refresh> [arguments]",
	"provider": "Usage: ocx provider <list|add|remove|default> [arguments]",
	"models":   "Usage: ocx models <list|add|remove> [arguments]",
	"init":     "Usage: ocx init\n\nInteractively configure a provider.",
	"status":   "Usage: ocx status\n\nShow proxy and service status.",
	"doctor":   "Usage: ocx doctor\n\nRun local configuration, process, and network diagnostics.",
	"claude":   "Usage: ocx claude [claude arguments...]\n\nLaunch Claude Code with proxy environment variables.",
	"debug":    "Usage: ocx debug <status|on|off|stack-on|stack-off>",
	"service":  "Usage: ocx service [install|start|stop|status|uninstall]",
	"update":   "Usage: ocx update --url HTTPS_URL --sha256 HEX [--destination PATH]",
}

func PrintHelp(writer io.Writer, command string) error {
	if command != "" {
		text, ok := commandHelp[command]
		if !ok {
			return fmt.Errorf("unknown help topic %q", command)
		}
		_, err := fmt.Fprintln(writer, text)
		return err
	}
	_, err := fmt.Fprint(writer, `opencodex (ocx) — Universal provider proxy for Codex

Usage:
  ocx serve [--port PORT]     Start the proxy server
  ocx init                    Interactive provider setup
  ocx status                  Show proxy and service status
  ocx doctor                  Run diagnostics
  ocx service [subcommand]    Manage the background service
  ocx provider <subcommand>   Manage providers
  ocx account <subcommand>    Manage provider accounts
  ocx models <subcommand>     List or edit configured models
  ocx claude [args...]        Launch Claude Code through the proxy
  ocx debug <subcommand>      Configure runtime diagnostics
  ocx update [options]        Replace the binary with a verified update
  ocx help [command]          Show help
  ocx --version               Print version
`)
	return err
}
