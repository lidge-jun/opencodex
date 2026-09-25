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
import { parseResolveArgs, type ResolveArgs } from "./resolve";
import { parseStopApproval } from "./stop-approval";
import { maybeAutoRestoreCodexShim } from "./codex-shim-autorestore";

export interface CliHead {
  kind: "version" | "help" | "ready" | "resolve" | "command";
  command: string | undefined;
  args: string[];
  /** For kind "help": the subcommand whose usage should print, if any. */
  helpTarget?: string;
  /** Present only for `ready`; undefined when the ready args failed to parse. */
  readyArgs?: ReadyArgs;
  /** Present only for `resolve`; undefined when the resolve args failed to parse. */
  resolveArgs?: ResolveArgs;
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
  // Same ordering contract as `ready`: `ocx resolve` rejects any argument with exit
  // 64 BEFORE maybeAutoRestoreCodexShim (or any other preflight with side effects) runs.
  if (command === "resolve") {
    const parsed = parseResolveArgs(args.slice(1));
    if (!parsed.ok) return { kind: "resolve", command, args, resolveArgs: undefined };
    return { kind: "resolve", command, args, resolveArgs: parsed.args };
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
    case "resolve": {
      // Fail-closed impossible-state guard, mirroring ready: the pre-parse above already
      // rejected invalid arguments before any preflight, so a missing resolveArgs means
      // dispatch diverged. Refuse with code 64 and perform NO I/O.
      if (!head.resolveArgs) {
        console.error("Usage: ocx resolve [--json]");
        console.error("  --json prints one JSON document: the config home, the effective port,");
        console.error("  and the identity-checked liveness verdict.");
        process.exit(64);
      }
      maybeAutoRestoreCodexShim(head.command, head.args);
      return head;
    }
    case "command":
      if (head.command === "stop" && !parseStopApproval(head.args.slice(1)).ok) {
        console.error("Usage: ocx stop [--json [--expect-pid <pid> --expect-port <port> --expect-hostname <host> --expect-config-home <home> --expect-cli-version <version> --expect-compatibility-token <hex>]]");
        process.exit(64);
      }
      maybeAutoRestoreCodexShim(head.command, head.args);
      return head;
  }
}
