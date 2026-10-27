import { autoRestoreCodexShim } from "../codex/shim";
import { codexShimAutoRestoreEnabled, readConfigDiagnostics } from "../config";

export interface CodexShimAutoRestoreCliDeps {
  env: NodeJS.ProcessEnv;
  warn: (message: string) => void;
  restore: typeof autoRestoreCodexShim;
  readConfig: typeof readConfigDiagnostics;
}

const DEFAULT_DEPS: CodexShimAutoRestoreCliDeps = {
  env: process.env,
  warn: message => console.warn(message),
  restore: autoRestoreCodexShim,
  readConfig: readConfigDiagnostics,
};

/** Identify command namespaces whose execution must not trigger automatic shim repair. */
export function skipsCodexShimAutoRestore(command: string | undefined, args: string[]): boolean {
  if (command === "uninstall" || command === "remove") return true;
  if (command === "status" || command === "doctor") return true;
  // `lab` is read-only inspection; it must not trigger shim side effects.
  if (command === "lab") return true;
  // Local messaging owns its helpers; even malformed usage must not repair/start anything.
  if (command === "message") return true;
  // `resolve` is read-only inspection for embedding shells: a lookup made to populate
  // a consent surface must not trigger a shim repair side effect first.
  if (command === "resolve") return true;
  // `service status --json` is a passive inventory read for peers such as GOAT: a shim repair
  // before dispatch would change the installation it was asked only to describe.
  // Flags may precede the verb (`ocx service --json status`), exactly as parseServiceArgs reads it.
  if (command === "service" && args.includes("--json")
    && args.slice(1).find(arg => !arg.startsWith("--")) === "status") return true;
  // The desktop's approval-bound stop must validate its snapshot before any unrelated
  // CLI repair changes the installation it was approved against.
  if (command === "stop" && args.some(arg => arg.startsWith("--expect-"))) return true;
  // A pinned sync (#7694) must change nothing when its expected Home or hub key does not hold,
  // so the root preflight may not repair the shim first; the sync runner repairs it only after
  // the locked identity check passed (runCodexShimAutoRestore in src/cli/dispatch.ts).
  if (command === "sync" && args.some(arg => /^--expect-(link|hub-key)(=|$)/.test(arg))) return true;
  // The entire updater-inspection namespace is zero-effect, including malformed
  // or future actions. A later `apply` implementation must own its preflight.
  if (command === "system" && args[1] === "codex-cli-update") return true;
  if (command === "__update-badge") return true;
  return command === "codex-shim" && ["install", "status", "uninstall", "remove"].includes(args[1] ?? "");
}

export function maybeAutoRestoreCodexShim(
  command: string | undefined,
  args: string[],
  deps: CodexShimAutoRestoreCliDeps = DEFAULT_DEPS,
): void {
  if (skipsCodexShimAutoRestore(command, args)) return;
  runCodexShimAutoRestore(deps);
}

/** The repair itself, without the command gate: for a caller that deferred it past its own check. */
export function runCodexShimAutoRestore(deps: CodexShimAutoRestoreCliDeps = DEFAULT_DEPS): void {
  try {
    const result = deps.restore({
      enabled: () => codexShimAutoRestoreEnabled(deps.readConfig().config, deps.env),
    });
    if (result.status === "restored") {
      deps.warn(`⚠️  ${result.message} (automatic repair after Codex update)`);
    } else if ((result.status === "deferred" || result.status === "ineligible") && result.message) {
      deps.warn(`⚠️  ${result.message}`);
    }
  } catch (error) {
    deps.warn(
      `⚠️  Codex shim auto-restore failed; continuing without it: ${
        error instanceof Error ? error.message : String(error)
      }. Run 'ocx codex-shim install' after the Codex update finishes.`,
    );
  }
}
