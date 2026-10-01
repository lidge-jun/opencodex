/**
 * Detection of Codex-based omo (LazyCodex), the variant that reads Codex role files and
 * `codex.agents.<role>.model` in `~/.omo/omo.jsonc`.
 *
 * "omo" names three products. Pi-based omo (senpi) owns `~/.omo/agent` and is the omo file
 * integration in `src/integrations/registry.ts`; OpenCode-based omo (oh-my-opencode) keeps its
 * own config under OpenCode. Neither proves LazyCodex is installed, and `~/.omo` exists for all
 * of them, so this reads only LazyCodex's footprint inside CODEX_HOME: the Codex plugin
 * `omo@sisyphuslabs` enabled in config.toml (the key LazyCodex's own doctor checks) and an
 * installed copy of it carrying the `lazycodex-install.json` receipt its installer writes.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LAZYCODEX_PLUGIN_ID = "omo@sisyphuslabs";

export interface LazyCodexDetection {
  readonly detected: boolean;
  readonly pluginEnabled: boolean;
  readonly pluginInstalled: boolean;
}

function pluginEnabled(codexHome: string): boolean {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(join(codexHome, "config.toml"), "utf8"));
  } catch {
    return false;
  }
  const plugins = (parsed as { plugins?: Record<string, { enabled?: unknown } | undefined> } | null)?.plugins;
  return plugins?.[LAZYCODEX_PLUGIN_ID]?.enabled === true;
}

function pluginInstalled(codexHome: string): boolean {
  const root = join(codexHome, "plugins", "cache", "sisyphuslabs", "omo");
  try {
    return readdirSync(root, { withFileTypes: true })
      .some(entry => entry.isDirectory() && existsSync(join(root, entry.name, "lazycodex-install.json")));
  } catch {
    return false;
  }
}

export function detectLazyCodex(codexHome: string): LazyCodexDetection {
  const enabled = pluginEnabled(codexHome);
  const installed = pluginInstalled(codexHome);
  return { detected: enabled && installed, pluginEnabled: enabled, pluginInstalled: installed };
}
