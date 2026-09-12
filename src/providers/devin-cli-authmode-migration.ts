/**
 * Repair saved Devin rows written while `devin-cli` was a local ACP provider.
 *
 * Two repairs, both from the same history: `devin-cli` used to be a local
 * provider whose adapter spawned `devin acp`, and it is now an account provider
 * that streams over Cognition's api-server on the shared `devin` adapter.
 *
 * `authMode` — `derive.ts` seeds it from the registry's `authKind`, so every
 * config written while `devin-cli` was local carries `"local"`. The management
 * write boundary fails closed on that mismatch: `auth-cors.ts` rejects
 * `authMode: "local"` when the registry entry is not local. Without this, an
 * existing install can no longer save provider changes from the dashboard.
 *
 * `adapter` — the ACP adapter has been removed, so `"devin-cli"` is no longer a
 * constructible adapter id and `createRegisteredAdapter` would throw
 * `Unknown adapter: devin-cli`. The registry-id row survives that removal on its
 * own because `routedProviderConfig` pins the adapter from the registry, but a
 * custom-named row such as `"devin-acp"` has nothing pinning it and would fail
 * every request. So every row naming the retired adapter is rewritten to
 * `devin`, whatever the row is called, and each rewrite is reported.
 *
 * A row carrying the retired ACP identity URL is repointed at the api-server in
 * the same pass. That URL was never a destination — it existed only so provider
 * validation would accept an `http(s)` scheme for a child process — so leaving
 * it in place would turn a constructible adapter into a request that cannot
 * resolve a host.
 */
import { PROVIDER_REGISTRY } from "./registry";
import type { OcxConfig } from "../types";

export interface DevinCliAuthModeProjection {
  config: OcxConfig;
  changed: boolean;
  warnings: string[];
}

/** The adapter id the removed ACP transport was registered under. */
const RETIRED_ACP_ADAPTER = "devin-cli";
/** Identity-only URL the ACP rows carried; never a destination. */
const RETIRED_ACP_IDENTITY_HOST = "cli.devin.ai";
const DEVIN_API_SERVER = "https://server.codeium.com";

function retiredIdentityUrl(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== "string") return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === RETIRED_ACP_IDENTITY_HOST;
  } catch {
    return false;
  }
}

export function projectDevinCliAuthMode(config: OcxConfig): DevinCliAuthModeProjection {
  const warnings: string[] = [];
  let changed = false;

  // Every row, not only the registry id: a custom-named row had no registry pin,
  // so after the ACP removal it is the one that cannot construct an adapter.
  for (const [name, row] of Object.entries(config.providers ?? {})) {
    if (!row || row.adapter !== RETIRED_ACP_ADAPTER) continue;
    row.adapter = "devin";
    changed = true;
    let detail = "";
    if (retiredIdentityUrl(row.baseUrl)) {
      row.baseUrl = DEVIN_API_SERVER;
      detail = ` and repointed its baseUrl at ${DEVIN_API_SERVER}`;
    }
    warnings.push(
      `rewrote "${name}" adapter ${RETIRED_ACP_ADAPTER} -> devin${detail}: the local ACP transport `
      + "was removed, and Devin now streams over Cognition's api-server with the credential the "
      + "installed CLI already holds.",
    );
  }

  const prov = config.providers?.["devin-cli"];
  if (!prov) return { config, changed, warnings };

  const entry = PROVIDER_REGISTRY.find(row => row.id === "devin-cli");
  if (!entry || entry.authKind !== "oauth") return { config, changed, warnings };

  if (prov.authMode !== "local") return { config, changed, warnings };
  prov.authMode = "oauth";
  warnings.push(
    'rewrote "devin-cli" authMode local -> oauth: the registry no longer classifies it as local, '
    + "and the management write boundary fails closed on the mismatch.",
  );
  return { config, changed: true, warnings };
}

