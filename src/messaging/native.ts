import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageBudget } from "./budget";
import { runMessageProcess } from "./process";
import { LocalMessagingError } from "./types";

export type MessageRunner = typeof runMessageProcess;
export interface NativeMessageRuntime {
  argv(args: readonly string[]): readonly string[];
  path?: string;
}
export const TESTED_CODEX_VERSION = "0.160.0";

/** Never reads the agent's config/auth or asks a launcher to ensure/start OCX. */
export async function withNativeMessageHome<T>(path: string | undefined,
  operation: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "ocx-message-"));
  try {
    return await operation({ PATH: path, HOME: root, CODEX_HOME: root, OPENCODEX_HOME: root,
      NO_PROXY: "*", no_proxy: "*", OCX_SHIM_BYPASS: "1", OCX_SHIM_PROBE: "1" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Require the pinned native version and Unix queue flags before submission, without fallback. */
export async function preflightNative(runtime: NativeMessageRuntime, budget: MessageBudget,
  env: NodeJS.ProcessEnv, run: MessageRunner): Promise<void> {
  const version = await run(runtime.argv(["--version"]), budget, { env, timeoutMs: 5000 });
  if (version.exitCode !== 0 || version.stdout.trim() !== `codex-cli ${TESTED_CODEX_VERSION}`) {
    throw new LocalMessagingError("unsupported_runtime", "Local messaging is contract-tested only with Codex 0.160.0; select it with CODEX_CLI_PATH.");
  }
  const help = await run(runtime.argv(["queue", "--help"]), budget, { env, timeoutMs: 5000 });
  if (help.exitCode !== 0 || !/^Usage: codex queue\b/m.test(help.stdout)
    || !["--thread", "--message", "--remote"].every(flag => new RegExp(`^\\s+${flag}\\s+<[^>]+>`, "m").test(help.stdout))
    || !help.stdout.includes("unix://")) {
    throw new LocalMessagingError("unsupported_queue", "The selected Codex runtime does not expose the tested local queue transport.");
  }
}
