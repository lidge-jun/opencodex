package ocxcli

// ocx integration — the dispatcher for the integration family
// (src/cli/dispatch.ts). grok/claude/client/native each dispatch to their own
// Go-native handler; a bare or unknown integration family prints the TypeScript
// usage error and exits 2 without the runCliAction wrapper.

import (
	"fmt"
	"strings"
)

func runIntegration(args []string, deps Deps) int {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		fmt.Fprintln(deps.Stderr, "Usage: ocx integration <claude|grok|client> <subcommand>")
		return 2
	}
	switch args[0] {
	case "grok":
		return runGrok(args[1:], deps)
	case "native":
		return runNativeIntegration(args[1:], deps)
	case "claude":
		return runClaudeConfig(args[1:], deps)
	case "client":
		return runClientIntegration(args[1:], deps)
	default:
		fmt.Fprintln(deps.Stderr, "Usage: ocx integration <claude|grok|client> <subcommand>")
		return 2
	}
}

// integrationHelp mirrors the TypeScript registry entry for `ocx help
// integration` (usage + summary + details).
const integrationHelp = "Usage: ocx integration <claude|grok|client|native> ...\n" +
	"\n" +
	"Manage supported client integrations, and the native client toggles.\n" +
	"\n" +
	"`native` shows or flips the native Claude/Claude Desktop/Codex/Grok toggles; the other subcommands manage the reversible file integrations.\n"
