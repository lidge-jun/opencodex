import { createAnthropicAdapter } from "./anthropic";
import { createAzureAdapter } from "./azure";
import { createCursorAdapter, type CursorAdapterDeps } from "./cursor";
import { createGoogleAdapter } from "./google";
import { createKiroAdapter } from "./kiro";
import { createMimoFreeAdapter, type MimoFreeAdapterDeps } from "./mimo-free";
import { createOpenAIChatAdapter } from "./openai-chat";
import { createCommandCodeAdapter } from "./command-code";
import { createResponsesPassthroughAdapter } from "./openai-responses";
import type { OcxProviderConfig } from "../types";
import {
  defineAdapterRegistry,
  type AdapterDefinition,
  type AdapterFactoryContext,
  type DirectAdapterDefinitionInput,
} from "./contracts";

type RegistryFactoryContext = AdapterFactoryContext & {
  cursorDeps?: CursorAdapterDeps;
  mimoDeps?: MimoFreeAdapterDeps;
};

function createRegisteredCursorAdapter(provider: OcxProviderConfig, context: AdapterFactoryContext) {
  return createCursorAdapter(provider, (context as RegistryFactoryContext).cursorDeps);
}

function createRegisteredMimoFreeAdapter(provider: OcxProviderConfig, context: AdapterFactoryContext) {
  return createMimoFreeAdapter(provider, (context as RegistryFactoryContext).mimoDeps);
}

export const ADAPTER_REGISTRY = defineAdapterRegistry({
  "command-code": {
    kind: "direct",
    wire: "command-code",
    mutation: "mutation.codex-owned",
    create: provider => createCommandCodeAdapter(provider),
  },
  "openai-chat": {
    kind: "direct",
    wire: "openai-chat",
    mutation: "mutation.codex-owned",
    create: provider => createOpenAIChatAdapter(provider),
  },
  anthropic: {
    kind: "direct",
    wire: "anthropic",
    mutation: "mutation.codex-owned",
    create: (provider, context) => createAnthropicAdapter(provider, context.cacheRetention),
  },
  "openai-responses": {
    kind: "direct",
    wire: "openai-responses",
    mutation: "mutation.codex-owned",
    create: provider => createResponsesPassthroughAdapter(provider),
  },
  google: {
    kind: "direct",
    wire: "google",
    mutation: "mutation.codex-owned",
    create: provider => createGoogleAdapter(provider),
  },
  kiro: {
    kind: "direct",
    wire: "kiro",
    mutation: "mutation.codex-owned",
    create: provider => createKiroAdapter(provider),
  },
  azure: {
    kind: "wrapper",
    extends: "openai-responses",
    create: provider => createAzureAdapter(provider),
  },
  "azure-openai": {
    kind: "wrapper",
    extends: "openai-responses",
    create: provider => createAzureAdapter(provider),
  },
  cursor: {
    kind: "direct",
    wire: "cursor",
    mutation: "mutation.codex-owned-with-gated-native-fallback",
    create: createRegisteredCursorAdapter,
  },
  "mimo-free": {
    kind: "wrapper",
    extends: "openai-chat",
    create: createRegisteredMimoFreeAdapter,
  },
});

export type AdapterId = keyof typeof ADAPTER_REGISTRY;
export type RegisteredAdapterDefinition = typeof ADAPTER_REGISTRY[AdapterId];
export type EffectiveAdapterContract = AdapterDefinition<DirectAdapterDefinitionInput>;

export function adapterDefinitions(): Array<[AdapterId, RegisteredAdapterDefinition]> {
  return Object.entries(ADAPTER_REGISTRY) as Array<[AdapterId, RegisteredAdapterDefinition]>;
}

export function getAdapterDefinition(adapterId: string): RegisteredAdapterDefinition | undefined {
  return ADAPTER_REGISTRY[adapterId as AdapterId];
}

export function effectiveAdapterContract(adapterId: string): EffectiveAdapterContract {
  const visited = new Set<string>();
  let current = adapterId;

  while (true) {
    if (visited.has(current)) {
      throw new Error(`Adapter wrapper cycle detected at ${current}`);
    }
    visited.add(current);

    const definition = getAdapterDefinition(current);
    if (!definition) throw new Error(`Unknown adapter: ${current}`);
    if (definition.kind === "direct") return definition;
    current = definition.extends;
  }
}

export function createRegisteredAdapter(
  provider: OcxProviderConfig,
  context: RegistryFactoryContext = {},
) {
  const definition = getAdapterDefinition(provider.adapter);
  if (!definition) throw new Error(`Unknown adapter: ${provider.adapter}`);
  return definition.create(provider, context);
}
