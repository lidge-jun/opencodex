import { resolveCodexHomeDir } from "../codex/home";

/** Resolve the effective existing Codex home using the shared policy, without creating it. */
export function messageCodexHome(env: NodeJS.ProcessEnv): string {
  return resolveCodexHomeDir({ env });
}
