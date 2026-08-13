import type { OcxProviderConfig } from "../types";
import type { ProviderAdapter } from "./base";

export const REQUIRED_ROUTED_TOOL_CONTRACTS = [
  "tools.code-mode-nested-helper",
  "tools.freeform-exact-roundtrip",
  "tools.tool-choice-final-catalog",
  "tools.continuation-replay",
] as const;

export type RequiredRoutedToolContract = typeof REQUIRED_ROUTED_TOOL_CONTRACTS[number];

export type MutationContract =
  | "mutation.codex-owned"
  | "mutation.codex-owned-with-gated-native-fallback";

export type AdapterWire =
  | "openai-chat"
  | "anthropic"
  | "google"
  | "command-code"
  | "kiro"
  | "openai-responses"
  | "cursor";

export type AdapterCacheRetention = "none" | "short" | "long";

export interface AdapterFactoryContext {
  cacheRetention?: AdapterCacheRetention;
}

export type AdapterFactory = (
  provider: OcxProviderConfig,
  context: AdapterFactoryContext,
) => ProviderAdapter;

export interface DirectAdapterDefinitionInput {
  kind: "direct";
  wire: AdapterWire;
  mutation: MutationContract;
  create: AdapterFactory;
}

export interface WrappedAdapterDefinitionInput {
  kind: "wrapper";
  extends: string;
  create: AdapterFactory;
}

export type AdapterDefinitionInput = DirectAdapterDefinitionInput | WrappedAdapterDefinitionInput;

export type AdapterDefinition<T extends AdapterDefinitionInput = AdapterDefinitionInput> = Readonly<
  T & { requiredToolContracts: typeof REQUIRED_ROUTED_TOOL_CONTRACTS }
>;

export function defineAdapterRegistry<const T extends Record<string, AdapterDefinitionInput>>(
  definitions: T,
): { readonly [K in keyof T]: AdapterDefinition<T[K]> } {
  const registered = Object.fromEntries(
    Object.entries(definitions).map(([id, definition]) => [
      id,
      Object.freeze({
        ...definition,
        requiredToolContracts: REQUIRED_ROUTED_TOOL_CONTRACTS,
      }),
    ]),
  );
  return Object.freeze(registered) as unknown as {
    readonly [K in keyof T]: AdapterDefinition<T[K]>;
  };
}
