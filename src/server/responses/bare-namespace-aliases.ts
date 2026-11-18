import type { RoutedNamespaceToolAliases } from "../../responses/namespace-tool-compat";

type ToolIdentity = { namespace: string; name: string; freeform?: boolean };

/**
 * The bare aliases a request authorized through `buildToolBridgeMaps`: each alias that one namespaced identity claims
 * under its own bare name. Passthrough restoration runs before the undeclared-tool guard copies them into the declared
 * set, so the dispatcher restores calls to these identities first (src/server/responses/passthrough-dispatch.ts).
 */
export function authorizedBareNamespaceToolAliases(toolNsMap: Iterable<[string, ToolIdentity]>): RoutedNamespaceToolAliases {
  return new Map(
    [...toolNsMap].flatMap(([alias, identity]) =>
      alias === identity.name
        ? [[alias, { namespace: identity.namespace, name: identity.name, kind: identity.freeform ? "custom" as const : "function" as const }] as const]
        : []
    ),
  );
}
