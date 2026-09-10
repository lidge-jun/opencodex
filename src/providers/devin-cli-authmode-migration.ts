/**
 * Repair saved Devin rows written while `devin-cli` was a local ACP provider.
 *
 * `devin-cli` used to be a local provider whose adapter spawned `devin acp`;
 * it later became an account provider on the shared `devin` adapter, and the
 * registry id itself has since merged into `devin` outright
 * (devlog/_plan/260913_devin_provider_merge).
 *
 * Only the adapter repair still lives here. The `authMode` half — rewriting
 * `"local"` to `"oauth"` on the registry-id row — moved into
 * devin-provider-merge-migration.ts, which normalizes the row as it moves the
 * key: the `devin-cli` registry entry is gone, so the PROVIDER_REGISTRY lookup
 * that gated the rewrite here could never fire again.
 *
 * The adapter repair must keep working for CUSTOM-NAMED rows. The ACP adapter
 * was removed, so `"devin-cli"` is not a constructible adapter id and
 * `createRegisteredAdapter` would throw `Unknown adapter: devin-cli`. The
 * canonical `devin` row gets its adapter pinned from the registry by
 * `routedProviderConfig`, but a row named e.g. `"devin-acp"` has nothing
 * pinning it and would fail every request. So every row naming the retired
 * adapter is rewritten to `devin`, whatever the row is called, and each
 * rewrite is reported.
 *
 * A row carrying the retired ACP identity URL is repointed at the api-server
 * in the same pass. That URL was never a destination — it existed only so
 * provider validation would accept an `http(s)` scheme for a child process —
 * so leaving it in place would turn a constructible adapter into a request
 * that cannot resolve a host.
 */
import { DEVIN_DEFAULT_API_SERVER } from "../oauth/devin/api-base";
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

/** Exported for the merge migration, which applies the same rule to the row it moves. */
export function isRetiredDevinAcpIdentityUrl(baseUrl: string | undefined): boolean {
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
    if (isRetiredDevinAcpIdentityUrl(row.baseUrl)) {
      // The shared default, not a second copy of the host: a migration that
      // hardcodes it would keep writing the old address after the default moves.
      row.baseUrl = DEVIN_DEFAULT_API_SERVER;
      detail = ` and repointed its baseUrl at ${DEVIN_DEFAULT_API_SERVER}`;
    }
    warnings.push(
      `rewrote "${name}" adapter ${RETIRED_ACP_ADAPTER} -> devin${detail}: the local ACP transport `
      + "was removed, and Devin now streams over Cognition's api-server with the credential the "
      + "installed CLI already holds.",
    );
  }

  return { config, changed, warnings };
}
