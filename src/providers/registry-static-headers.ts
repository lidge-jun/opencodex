import type { OcxProviderConfig } from "../types";
import type { ProviderRegistryEntry } from "./registry/types";

/**
 * A row's headers without its registry `staticHeaders`, for a row whose transport no longer
 * matches the registry entry.
 *
 * `providerConfigSeed` writes the registry headers into the saved row, and a
 * `preserveCustomDestination` preset keeps a row whose `baseUrl` was changed afterwards
 * (`ocx provider add <id> --base-url`, a config edit). Without this, headers meant for the
 * preset's host would follow the row to the new one. While the row still targets the registry
 * host (same scheme and hostname; only the path or adapter changed) its headers are kept as
 * they are. Otherwise every header named like a registry static header is dropped, whatever its
 * value, so a copy seeded by an older release with a different value does not follow the row
 * either; headers with other names are kept.
 */
export function withoutRegistryStaticHeaderCopies(
  entry: Readonly<Pick<ProviderRegistryEntry, "staticHeaders" | "baseUrl">> | undefined,
  row: Readonly<Pick<OcxProviderConfig, "baseUrl" | "headers">>,
): Record<string, string> | undefined {
  const headers = row.headers;
  if (!entry?.staticHeaders || !headers) return headers;
  if (sameOrigin(entry.baseUrl, row.baseUrl || entry.baseUrl)) return headers;
  const owned = new Set(Object.keys(entry.staticHeaders).map(name => name.toLowerCase()));
  const kept = Object.entries(headers).filter(([name]) => !owned.has(name.toLowerCase()));
  if (kept.length === Object.keys(headers).length) return headers;
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

function sameOrigin(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
  } catch {
    return false;
  }
}
