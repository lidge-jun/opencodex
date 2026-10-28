import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readConfigDiagnostics, websocketsEnabled } from "../config";
import { readBoundedCodexConfig } from "../codex/inject/bounded-config-reader";
import { buildProviderTableBlockForTarget } from "../codex/inject/config-toml";
import { standaloneCodexRoutingTarget, validateCodexRoutingTarget } from "../codex/inject/routing-target";
import { readClientConnectionState } from "../client/state";
import { codexHasOtherTokenConsumers, codexTokenConfigShapeIsSafe } from "./codex-launch-policy";
import { codexLaunchHomeIsOwned, codexLaunchProjectAliasIsOwned, codexLaunchSystemNamespaceIsSafe } from "./codex-launch-ownership";
import type { CodexTokenRefusal, CodexTokenRefusalReporter } from "./codex-launch-diagnostics";

/** Resolve once; the credential verifier and child must use this exact directory. */
export function resolveCodexLaunchHome(env: Record<string, string | undefined>): string | null {
  try {
    // Object spread loses Windows process.env's case-insensitive lookup. Refuse
    // noncanonical aliases rather than pass conflicting names to CreateProcess.
    if (process.platform === "win32" && Object.keys(env).some(key => key !== "CODEX_HOME" && key.toUpperCase() === "CODEX_HOME")) return null;
    // Explicit values are native literal paths: no tilde expansion or whitespace trim.
    // An implicit managed home is safe only when also made explicit for the child.
    const userHome = (process.platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
    const raw = env.CODEX_HOME === undefined ? join(userHome, ".codex") : env.CODEX_HOME;
    if (!raw.trim()) return null;
    const home = realpathSync(resolve(raw));
    return statSync(home).isDirectory() ? home : null;
  } catch { return null; }
}

/** Config classification is a startup hint; credentials need an independently bound destination. */
export function codexCredentialDestinationIsTrusted(home: string, systemNamespaceDirectory?: string, report?: CodexTokenRefusalReporter): boolean {
  const refuse = (reason: CodexTokenRefusal): false => { report?.(reason); return false; };
  try {
    if (!codexLaunchHomeIsOwned(home)) return refuse("ownership");
    if (!codexLaunchSystemNamespaceIsSafe(systemNamespaceDirectory, report)) return false;
    const additionalLayers = [join(home, "auth.json"), join(home, "managed_config.toml"), join(home, "requirements.toml")];
    if (process.platform !== "win32") additionalLayers.push("/etc/codex/config.toml", "/etc/codex/managed_config.toml", "/etc/codex/requirements.toml");
    for (const path of additionalLayers) {
      try { lstatSync(path); return refuse("additionalLayer"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse("layerInspection"); }
    }
    const diagnostics = readConfigDiagnostics();
    if (diagnostics.error || diagnostics.source === "fallback") return refuse("installationConfig");
    const cfg = diagnostics.config;
    let target = standaloneCodexRoutingTarget(cfg.port, cfg);
    if (cfg.runtimeRole === "client") {
      // Direct clients bind to persisted connection state; link clients use an authless relay.
      const connection = readClientConnectionState();
      if (connection.kind !== "connected" || connection.value.transport === "link") return refuse("connection");
      target = validateCodexRoutingTarget({ baseUrl: `${connection.value.serverUrl}/v1`, requiresAdmissionToken: true, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" });
    }
    const url = new URL(target.baseUrl);
    if (!target.requiresAdmissionToken) return refuse("admission");
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) return refuse("loopback");
    const content = readBoundedCodexConfig(join(home, "config.toml"));
    if (content === null) return refuse("configRead");
    const config = Bun.TOML.parse(content) as Record<string, unknown>;
    if (codexHasOtherTokenConsumers(config)) return refuse("consumers");
    if (!codexTokenConfigShapeIsSafe(config)) return refuse("configShape");
    // This native feature resolves OS/PAC routes without honoring NO_PROXY.
    const features = config.features as Record<string, unknown> | undefined;
    if (features?.respect_system_proxy !== undefined && features.respect_system_proxy !== false) return refuse("systemProxy");
    // Codex layers project configs and profiles after the home. Without proving those layers,
    // conservatively leave authentication to the user's environment.
    if (config.profile !== undefined || config.model_provider !== "opencodex") return refuse("provider");
    for (const key of ["openai_base_url", "experimental_realtime_ws_base_url"]) {
      if (config[key] !== undefined && config[key] !== target.baseUrl) return refuse("rootUrl");
    }
    for (let directory = process.cwd(); ; directory = dirname(directory)) {
      const projectConfig = join(directory, ".codex", "config.toml");
      try {
        lstatSync(projectConfig);
        // Same-file aliases qualify only when their lexical entries and redirect
        // targets are protected against replacement by another principal.
        try { if (realpathSync(projectConfig) !== realpathSync(join(home, "config.toml"))
          || !codexLaunchProjectAliasIsOwned(projectConfig)) return refuse("project"); }
        catch { return refuse("project"); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse("layerInspection"); }
      // A nested .git need not be Codex's root: custom project_root_markers can select
      // an outer workspace. Without proving that selection, inspect every ancestor.
      if (dirname(directory) === directory) break;
    }
    const providers = config.model_providers as Record<string, unknown> | undefined;
    const provider = providers?.opencodex as Record<string, unknown> | undefined;
    const expected = (Bun.TOML.parse(buildProviderTableBlockForTarget(target, websocketsEnabled(cfg))) as { model_providers: { opencodex: Record<string, unknown> } }).model_providers.opencodex;
    // Display names are cosmetic; every transport and credential-bearing field must match
    // the block emitted by our writer for this installation/connection.
    if (!provider || typeof provider.name !== "string") return refuse("providerTransport");
    const { name: _name, ...transport } = provider;
    const { name: _expectedName, ...expectedTransport } = expected;
    return isDeepStrictEqual(transport, expectedTransport) || refuse("providerTransport");
  } catch { return refuse("inspection"); }
}
