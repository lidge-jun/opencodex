import { isOrchestratedUpdateArgv } from "../update/orchestrated-arguments.mjs";

/** Identify command namespaces whose execution must not trigger automatic shim repair. */
export function skipsCodexShimAutoRestore(command: string | undefined, args: string[]): boolean {
  if (command === "uninstall" || command === "remove") return true;
  // Contract discovery and orchestrated update must validate before any repair.
  if (command === "capabilities") return true;
  // Reading the bounded link diagnostics file must not repair, harden or create anything first.
  if (command === "link" && args[1] === "diagnostics") return true;
  if (command === "update" && isOrchestratedUpdateArgv(args)) return true;
  if (command === "sync") return true;
  if (command === "status" || command === "doctor") return true;
  // Explicit orphan-token recovery must not mutate Codex before its guards run.
  if (command === "disconnect" && args.includes("--orphaned-token")) return true;
  // The launcher owns shim handoff after classifying routing, including native fast paths.
  if (command === "codex") return true;
  // Exec admission only observes the selected target; it must never repair a shim first.
  if (command === "internal" && args[1] === "codex-exec-target") return true;
  // `lab` is read-only inspection; it must not trigger shim side effects.
  if (command === "lab") return true;
  // Local messaging owns its helpers; even malformed usage must not repair/start anything.
  if (command === "message") return true;
  // `resolve` is read-only inspection for embedding shells: a lookup made to populate
  // a consent surface must not trigger a shim repair side effect first.
  if (command === "resolve") return true;
  // Local model inventory is read-only; mutations and live commands keep preflight.
  if (command === "models" || command === "model") {
    const subcommand = args[1];
    if (!subcommand || subcommand.startsWith("-") || subcommand === "list" || subcommand === "list-custom") return true;
  }
  // `service status --json` is a passive inventory read for peers such as GOAT: a shim repair
  // before dispatch would change the installation it was asked only to describe.
  // Flags may precede the verb (`ocx service --json status`), exactly as parseServiceArgs reads it.
  if (command === "service" && args.includes("--json")
    && args.slice(1).find(arg => !arg.startsWith("--")) === "status") return true;
  // The desktop's approval-bound stop must validate its snapshot before any unrelated
  // CLI repair changes the installation it was approved against.
  if (command === "stop" && args.some(arg => arg.startsWith("--expect-"))) return true;
  // The entire updater-inspection namespace is zero-effect, including malformed
  // or future actions. A later `apply` implementation must own its preflight.
  if (command === "system" && args[1] === "codex-cli-update") return true;
  if (command === "__update-badge") return true;
  return command === "codex-shim" && ["install", "status", "uninstall", "remove"].includes(args[1] ?? "");
}
