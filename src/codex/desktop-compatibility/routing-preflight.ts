import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { OcxConfig } from "../../types";
import { nativeCompatibilityOwner, type NativeCompatibilityOwner } from "./routing-binding";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// These are routing inputs, not proof of a conversation's final provider. Their
// changes revoke the observed context even if the loopback URL stays the same.
const ROUTING_KEYS = ["providers", "defaultProvider", "defaultModelAliases", "customModels", "combos", "routingProfiles",
  "subagentModelFallback", "subagentModelFallbackByModel", "injectionModel", "compactionRouting", "compactionRecovery",
  "blockedModelRedirects", "shadowCallIntercept", "protocols", "memoryModels"] as const satisfies readonly (keyof OcxConfig)[];
function routingDigest(text: string, owner: NativeCompatibilityOwner): string {
  const native = Bun.TOML.parse(text) as Record<string, unknown>;
  // Desktop refreshes MCP endpoints after launch. Tool transport metadata and TOML
  // formatting do not select the model transport. Keep all other (including unknown)
  // native fields bound, rather than an allowlist that could miss a new routing key.
  const { mcp_servers: _mcpServers, ...nativeContext } = native;
  const projection = Object.fromEntries(ROUTING_KEYS.map(key => [key, owner.config[key]]));
  const serialized = JSON.stringify([nativeContext, owner.hostname, owner.port, owner.loopbackPort, projection], (_key, value) =>
    record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  if (Buffer.byteLength(serialized) > 1048576) throw new Error("Routing snapshot too large");
  return createHash("sha256").update(serialized).digest("hex");
}
/** Validates the effective root/profile routing only; it does not prove a thread's selected provider. */
export function matchesNativeCompatibilityRouting(text: string, owner: NativeCompatibilityOwner | null): boolean {
  if (!owner || owner.config.codexDesktopAuthless === true || owner.config.runtimeRole === "client") return false;
  try {
    const root: unknown = Bun.TOML.parse(text);
    if (!record(root)) return false;
    let effective = root;
    if (root.profile !== undefined) {
      if (typeof root.profile !== "string" || !record(root.profiles)) return false;
      const profile = root.profiles[root.profile];
      if (!record(profile)) return false;
      effective = { ...root, ...profile };
    }
    if ((effective.model_provider ?? "openai") !== "openai" || effective.forced_login_method === "api") return false;
    if (typeof effective.openai_base_url !== "string") return false;
    const url = new URL(effective.openai_base_url);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password
      || url.search || url.hash || !["/v1", "/v1/"].includes(url.pathname) || !url.port) return false;
    const port = Number(url.port), matchesPort = (value: number | undefined) => Number.isInteger(value) && Number(value) > 0 && value === port;
    // The companion always binds IPv4. localhost can resolve to another address family.
    if (matchesPort(owner.loopbackPort) && url.hostname === "127.0.0.1") return true;
    if (!matchesPort(owner.port)) return false;
    return url.hostname === "127.0.0.1" ? ["127.0.0.1", "0.0.0.0"].includes(owner.hostname)
      : ["::1", "[::1]", "::", "[::]"].includes(owner.hostname);
  } catch { return false; }
}
export function createNativeRoutingVerifier(codexHome: string, readOwner = nativeCompatibilityOwner) {
  const path = join(codexHome, "config.toml");
  let baseline: string | undefined, invalidated = false;
  return () => {
    if (invalidated) return false;
    try {
      // Process-level overrides could put the app on another transport despite its TOML.
      if (["CODEX_API_BASE_URL", "CODEX_APP_SERVER_WS_URL", "CODEX_ELECTRON_USER_DATA_PATH", "ELECTRON_RUN_AS_NODE"].some(key => process.env[key]?.trim())) { invalidated = true; return false; }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) { invalidated = true; return false; }
      const text = readFileSync(path, "utf8"), owner = readOwner();
      if (!owner || !matchesNativeCompatibilityRouting(text, owner)) { invalidated = true; return false; }
      const current = routingDigest(text, owner);
      if (baseline !== undefined && current !== baseline) { invalidated = true; return false; }
      baseline ??= current;
      return true;
    } catch { invalidated = true; return false; }
  };
}
