import type { OcxRoutingProfileConfig } from "../types";

/** Canonical public namespace reserved for routing-policy model ids. */
export const POLICY_NAMESPACE = "policy";

/** Public namespace prefixes claimed by slash-qualified routing-profile aliases. */
export function routingProfileAliasNamespacePrefixes(
  config: { routingProfiles?: Record<string, OcxRoutingProfileConfig> },
): string[] {
  return Object.values(config.routingProfiles ?? {}).flatMap((profile) => {
    const alias = typeof profile?.alias === "string" ? profile.alias.trim() : "";
    const slash = alias.indexOf("/");
    return slash > 0 ? [alias.slice(0, slash)] : [];
  });
}
