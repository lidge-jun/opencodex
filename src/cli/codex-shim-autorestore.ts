import { autoRestoreCodexShim, autoRestoreCodexShimAsync } from "../codex/shim";
import { codexShimAutoRestoreEnabled, readConfigDiagnostics } from "../config";
import { skipsCodexShimAutoRestore } from "./preflight-exemptions";

// Re-exported for existing importers; the list itself lives in a leaf module so a caller that
// only needs it (the config-root startup wait) does not link the shim repair machinery.
export { skipsCodexShimAutoRestore };

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

export async function maybeAutoRestoreCodexShimAsync(command: string | undefined, args: string[]): Promise<void> {
  if (!skipsCodexShimAutoRestore(command, args)) await runCodexShimAutoRestoreAsync();
}

export async function runCodexShimAutoRestoreAsync(): Promise<void> {
  try {
    const result = await autoRestoreCodexShimAsync({
      enabled: () => codexShimAutoRestoreEnabled(DEFAULT_DEPS.readConfig().config, DEFAULT_DEPS.env),
    });
    if (result.status === "restored") DEFAULT_DEPS.warn(`⚠️  ${result.message} (automatic repair after Codex update)`);
    else if ((result.status === "deferred" || result.status === "ineligible") && result.message) DEFAULT_DEPS.warn(`⚠️  ${result.message}`);
  } catch (error) {
    DEFAULT_DEPS.warn(`⚠️  Codex shim auto-restore failed; continuing without it: ${error instanceof Error ? error.message : String(error)}. Run 'ocx codex-shim install' after the Codex update finishes.`);
  }
}
