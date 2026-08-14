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

export type AdapterWrapperFactory = (
  parent: ProviderAdapter,
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
  wrap: AdapterWrapperFactory;
}

export type AdapterDefinitionInput = DirectAdapterDefinitionInput | WrappedAdapterDefinitionInput;

export type AdapterDefinition<T extends AdapterDefinitionInput = AdapterDefinitionInput> = Readonly<
  T & { requiredToolContracts: typeof REQUIRED_ROUTED_TOOL_CONTRACTS }
>;

type ValidAdapterRegistry<T extends Record<string, AdapterDefinitionInput>> = {
  [K in keyof T]: T[K] extends WrappedAdapterDefinitionInput
    ? T[K]["extends"] extends Exclude<keyof T, K>
      ? T[K]
      : never
    : T[K];
};

type AssertNever<T extends never> = T;
type _UnknownWrapperParentIsRejected = AssertNever<
  ValidAdapterRegistry<{
    base: DirectAdapterDefinitionInput;
    broken: WrappedAdapterDefinitionInput & { extends: "not-registered" };
  }>["broken"]
>;
type _SelfWrapperParentIsRejected = AssertNever<
  ValidAdapterRegistry<{
    self: WrappedAdapterDefinitionInput & { extends: "self" };
  }>["self"]
>;

export function defineAdapterRegistry<const T extends Record<string, AdapterDefinitionInput>>(
  definitions: T & ValidAdapterRegistry<T>,
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
