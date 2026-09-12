/**
 * Repair a saved `devin-cli` row that still claims `authMode: "local"`.
 *
 * `derive.ts` seeds `authMode` from the registry's `authKind`, so every config
 * written while `devin-cli` was a local provider carries `"local"`. The registry
 * now classifies it as an account provider, and the management write boundary
 * fails closed on that mismatch: `auth-cors.ts` rejects `authMode: "local"` when
 * the registry entry is not local. Without this, an existing install can no
 * longer save provider changes from the dashboard.
 *
 * It rewrites exactly that one field, on exactly that mismatch. A row the user
 * retargeted at another adapter is left alone, and so is any other value.
 *
 * It also WARNS, without changing anything, when the saved row still names the
 * ACP adapter. That field no longer selects the transport — `routedProviderConfig`
 * pins the adapter from the registry for any row whose name is a registry id — so
 * an operator who deliberately chose ACP would otherwise switch transports
 * silently. The warning names the custom-id row that still gets them ACP.
 */
import { PROVIDER_REGISTRY } from "./registry";
import type { OcxConfig } from "../types";

export interface DevinCliAuthModeProjection {
  config: OcxConfig;
  changed: boolean;
  warnings: string[];
}

const ACP_ESCAPE_HATCH =
  'a custom-named row still reaches it, e.g. "devin-acp": { "adapter": "devin-cli", "baseUrl": "https://cli.devin.ai" }';

export function projectDevinCliAuthMode(config: OcxConfig): DevinCliAuthModeProjection {
  const warnings: string[] = [];
  const prov = config.providers?.["devin-cli"];
  if (!prov) return { config, changed: false, warnings };

  const entry = PROVIDER_REGISTRY.find(row => row.id === "devin-cli");
  if (!entry || entry.authKind !== "oauth") return { config, changed: false, warnings };

  // Non-mutating: the saved adapter no longer decides the transport, so leaving
  // it in place preserves nothing except a signal worth reporting once.
  if (prov.adapter === "devin-cli") {
    warnings.push(
      'the saved "devin-cli" row names the ACP adapter, but that provider id now streams over '
      + `Cognition's api-server and the adapter is pinned from the registry; for the CLI's own agent loop, ${ACP_ESCAPE_HATCH}.`,
    );
  }

  if (prov.authMode !== "local") return { config, changed: warnings.length > 0 ? false : false, warnings };
  prov.authMode = "oauth";
  warnings.push(
    'rewrote "devin-cli" authMode local -> oauth: the registry no longer classifies it as local, '
    + "and the management write boundary fails closed on the mismatch.",
  );
  return { config, changed: true, warnings };
}

