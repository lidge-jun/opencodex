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

export function skipsCodexShimAutoRestore(command: string | undefined, args: string[]): boolean {
  if (command === "uninstall" || command === "remove") return true;
  return command === "codex-shim" && ["install", "uninstall", "remove"].includes(args[1] ?? "");
}

export function maybeAutoRestoreCodexShim(
  command: string | undefined,
  args: string[],
  deps: CodexShimAutoRestoreCliDeps = DEFAULT_DEPS,
): void {
  if (skipsCodexShimAutoRestore(command, args)) return;
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
