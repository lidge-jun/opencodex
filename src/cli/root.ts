/**
 * CLI head: version/help early exits, `ocx ready` pre-parse, and the bounded
 * Codex-shim auto-restore preflight, in that order (Phase 1 of the CLI
 * deepening — moved out of src/cli/index.ts).
 *
 * `parseCliHead` is pure (no I/O, no process access) so the ordering and the
 * single-parse contract are unit-testable without a subprocess. `runCli` owns
 * the exit paths and the shim preflight, then returns the dispatchable head
 * for the command switch in src/cli/index.ts.
 */
import { hasHelpFlag, printSubcommandUsage, printUsage, printVersion } from "./help";
import { parseReadyArgs, type ReadyArgs } from "./ready";
import { maybeAutoRestoreCodexShim } from "./codex-shim-autorestore";

export interface CliHead {
  kind: "version" | "help" | "ready" | "command";
  command: string | undefined;
  args: string[];
  /** For kind "help": the subcommand whose usage should print, if any. */
  helpTarget?: string;
  /** Present only for `ready`; undefined when the ready args failed to parse. */
  readyArgs?: ReadyArgs;
}

export function parseCliHead(argv: string[]): CliHead {
  const command = argv[0];
  const args = argv;
  if (command === "--version" || command === "-v" || command === "version") {
    return { kind: "version", command, args };
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    // `ocx help <sub>` carries the subcommand; bare/flag help prints the full usage.
    return {
      kind: "help",
      command,
      args,
      ...(command === "help" && args[1] ? { helpTarget: args[1] } : {}),
    };
  }
  if (command !== "help" && hasHelpFlag(args.slice(1))) {
    // `ocx <cmd> --help|-h|help` prints that command's usage, not the full list.
    return { kind: "help", command, args, helpTarget: command };
  }
  // P1: pre-parse `ocx ready` and reject invalid arguments with exit 64 BEFORE
  // maybeAutoRestoreCodexShim (or any discovery/probe/filesystem-capable global
  // preflight) runs. `ready --help` / `help ready` already exited above, so this
  // only sees ready args without a help flag. Valid args are stashed so the
  // switch dispatch can call runReady without a second parse.
  if (command === "ready") {
    const parsed = parseReadyArgs(args.slice(1));
    if (!parsed.ok) return { kind: "ready", command, args, readyArgs: undefined };
    return { kind: "ready", command, args, readyArgs: parsed.args };
  }
  return { kind: "command", command, args };
}

export async function runCli(argv: string[]): Promise<CliHead> {
  const head = parseCliHead(argv);
  switch (head.kind) {
    case "version":
      printVersion();
      process.exit(0);
    case "help": {
      if (head.helpTarget) printSubcommandUsage(head.helpTarget);
      else printUsage();
      process.exit(0);
    }
    case "ready": {
      // Fail-closed impossible-state guard: parseCliHead already ran the
      // pre-parse before any shim/preflight side effect, so reaching here
      // without readyArgs means dispatch diverged. Refuse with code 64 and
      // perform NO I/O (no discovery/probe).
      if (!head.readyArgs) {
        console.error("Usage: ocx ready [--json] [--wait [--timeout <seconds>]]");
        console.error("  --timeout requires --wait; <seconds> must be a positive integer (1..300).");
        console.error("  Default wait timeout is 45 seconds.");
        process.exit(64);
      }
      maybeAutoRestoreCodexShim(head.command, head.args);
      return head;
    }
    case "command":
      maybeAutoRestoreCodexShim(head.command, head.args);
      return head;
  }
}
