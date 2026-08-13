import {
  currentExternalCodexModelProvider,
  getCodexRoutingKind,
  type CodexRoutingKind,
} from "../codex/inject";
import { loadConfig, resolveEnvValue } from "../config";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export interface CodexShimReadinessInputs {
  routingKind: CodexRoutingKind;
  externalProvider: string | null;
  processProxyEnvPresent: boolean;
  configuredProxyResolved: boolean;
}

function externalProviderLabel(provider: string | null): string {
  return provider
    ? `external model_provider ${JSON.stringify(provider)}`
    : "the active Codex route";
}

export function codexShimReadinessWarnings(
  inputs: CodexShimReadinessInputs,
): string[] {
  const warnings: string[] = [];
  const provider = externalProviderLabel(inputs.externalProvider);

  if (inputs.routingKind === "unknown") {
    warnings.push(
      inputs.externalProvider
        ? `Codex still selects ${provider}. The shim can start OpenCodex, but it does not redirect that provider; point it at the live OpenCodex /v1 endpoint with wire_api = "responses", or switch to the built-in openai provider and run 'ocx sync'.`
        : "Codex routing could not be verified. The shim can start OpenCodex, but it may not redirect Codex; run 'ocx doctor' before relying on autostart.",
    );
  } else if (inputs.routingKind === "custom-local") {
    warnings.push(
      `Codex uses ${provider} through a user-owned local gateway. The shim can start OpenCodex, but OpenCodex does not own that route; run 'ocx doctor' to verify its lifecycle.`,
    );
  } else if (inputs.routingKind === "custom-remote") {
    warnings.push(
      `Codex uses ${provider} through a remote gateway. The shim only starts a local OpenCodex proxy and will not affect those requests.`,
    );
  }

  if (inputs.processProxyEnvPresent && !inputs.configuredProxyResolved) {
    warnings.push(
      "Proxy environment variables are present only in this process while config.proxy is unset or unresolved. Codex launchers and background services may not inherit them; persist config.proxy before relying on autostart.",
    );
  }

  return warnings;
}

export function collectCodexShimReadinessWarnings(): string[] {
  const config = loadConfig();
  let externalProvider: string | null = null;
  try {
    externalProvider = currentExternalCodexModelProvider();
  } catch {
    // Routing readiness is advisory; getCodexRoutingKind() already reports an
    // unreadable config as unknown, so preserve that warning instead of failing.
  }
  return codexShimReadinessWarnings({
    routingKind: getCodexRoutingKind(),
    externalProvider,
    processProxyEnvPresent: PROXY_ENV_KEYS.some(key => Boolean(process.env[key]?.trim())),
    configuredProxyResolved: Boolean(resolveEnvValue(config.proxy)?.trim()),
  });
}
