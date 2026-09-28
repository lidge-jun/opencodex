import { homedir } from "node:os";
import { KILO_CONFIG_CANDIDATES, kiloCandidatePath, kiloHomeDir } from "../clients/config-export";
import { loadTarget, parseConfig, PARSE_FAILED, type IntegrationIO } from "./config-io";

/** Kilo deep-merges every global candidate, so an off-target provider can override ours. */
export function inspectKiloCandidates(input: {
  io: IntegrationIO;
  selectedPath: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): { kind: "ok" } | { kind: "unsafe"; path: string; why: "unparseable" | "not-regular-file" }
  | { kind: "conflict"; paths: string[] } {
  const dir = kiloHomeDir(input.env ?? process.env, input.home ?? homedir());
  const conflictPaths: string[] = [];
  for (const name of KILO_CONFIG_CANDIDATES) {
    const path = kiloCandidatePath(dir, name);
    const loaded = loadTarget(input.io, path);
    if (!loaded.ok) return { kind: "unsafe", path, why: loaded.why === "read-failed" ? "unparseable" : "not-regular-file" };
    if (loaded.before === null) continue;
    const parsed = parseConfig(loaded.before, "json", { jsonc: true });
    if (parsed === PARSE_FAILED) return { kind: "unsafe", path, why: "unparseable" };
    if (path !== input.selectedPath && typeof parsed === "object" && parsed !== null
      && !Array.isArray(parsed) && Object.hasOwn(parsed, "provider")) {
      const provider = (parsed as Record<string, unknown>).provider;
      if (typeof provider === "object" && provider !== null && !Array.isArray(provider)
        && Object.hasOwn(provider, "opencodex")) conflictPaths.push(path);
    }
  }
  return conflictPaths.length > 0 ? { kind: "conflict", paths: conflictPaths } : { kind: "ok" };
}
