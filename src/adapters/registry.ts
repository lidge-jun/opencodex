import { createAnthropicAdapter } from "./anthropic";
import { createAzureAdapter } from "./azure";
import type { ProviderAdapter } from "./base";
import { withClinePassDeepSeekV4ToolReplayCompatibility } from "./cline-pass-deepseek-v4-tool-replay";
import { createCommandCodeAdapter } from "./command-code";
import { createCursorAdapter } from "./cursor";
import { createGoogleAdapter } from "./google";
import { createKiroAdapter } from "./kiro";
import { createMimoFreeAdapter } from "./mimo-free";
import { createOpenAIChatAdapter } from "./openai-chat";
import { createResponsesPassthroughAdapter } from "./openai-responses";
import type { OcxProviderConfig } from "../types";
import { createAdapterTierMetadata } from "../providers/fastwire";

export type AdapterCacheRetention = "none" | "short" | "long";

export interface AdapterFactoryContext {
  cacheRetention?: AdapterCacheRetention;
}

export type AdapterWire =
  | "command-code"
  | "openai-chat"
  | "anthropic"
  | "openai-responses"
  | "google"
  | "kiro"
  | "cursor";

export type AdapterMutationContract =
  | "codex-owned"
  | "codex-owned-with-gated-native-fallback";

type AdapterFactory = (
  provider: OcxProviderConfig,
  context: AdapterFactoryContext,
) => ProviderAdapter;

type DirectAdapterDefinition = {
  wire: AdapterWire;
  mutation: AdapterMutationContract;
  create: AdapterFactory;
};

type InheritedAdapterDefinition = {
  /** Semantic contract inheritance only. Runtime construction remains independent. */
  contractParent: string;
  create: AdapterFactory;
};

type AdapterDefinition = DirectAdapterDefinition | InheritedAdapterDefinition;

export const ADAPTER_REGISTRY = {
  "command-code": {
    wire: "command-code",
    mutation: "codex-owned",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createCommandCodeAdapter(provider),
  },
  "openai-chat": {
    wire: "openai-chat",
    mutation: "codex-owned",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) =>
      withClinePassDeepSeekV4ToolReplayCompatibility(createOpenAIChatAdapter(provider)),
  },
  anthropic: {
    wire: "anthropic",
    mutation: "codex-owned",
    create: (provider: OcxProviderConfig, context: AdapterFactoryContext) =>
      createAnthropicAdapter(provider, context.cacheRetention),
  },
  "openai-responses": {
    wire: "openai-responses",
    mutation: "codex-owned",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) =>
      createResponsesPassthroughAdapter(provider),
  },
  google: {
    wire: "google",
    mutation: "codex-owned",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createGoogleAdapter(provider),
  },
  kiro: {
    wire: "kiro",
    mutation: "codex-owned",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createKiroAdapter(provider),
  },
  azure: {
    contractParent: "openai-responses",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createAzureAdapter(provider),
  },
  "azure-openai": {
    contractParent: "openai-responses",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createAzureAdapter(provider),
  },
  cursor: {
    wire: "cursor",
    mutation: "codex-owned-with-gated-native-fallback",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createCursorAdapter(provider),
  },
  "mimo-free": {
    contractParent: "openai-chat",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createMimoFreeAdapter(provider),
  },
} as const satisfies Record<string, AdapterDefinition>;

export type AdapterId = keyof typeof ADAPTER_REGISTRY;
export type RegisteredAdapterDefinition = typeof ADAPTER_REGISTRY[AdapterId];

export function adapterDefinitions(): Array<[AdapterId, RegisteredAdapterDefinition]> {
  return Object.entries(ADAPTER_REGISTRY) as Array<[AdapterId, RegisteredAdapterDefinition]>;
}

export function getAdapterDefinition(adapterId: unknown): RegisteredAdapterDefinition | undefined {
  if (typeof adapterId !== "string" || !Object.hasOwn(ADAPTER_REGISTRY, adapterId)) return undefined;
  return ADAPTER_REGISTRY[adapterId as AdapterId];
}

export function effectiveAdapterContract(adapterId: string): Readonly<{
  wire: AdapterWire;
  mutation: AdapterMutationContract;
}> {
  const visited = new Set<string>();
  let current = adapterId;

  while (true) {
    if (visited.has(current)) {
      throw new Error(`Adapter contract cycle detected at ${current}`);
    }
    visited.add(current);

    const definition = getAdapterDefinition(current);
    if (!definition) throw new Error(`Unknown adapter: ${current}`);
    if ("wire" in definition) {
      return { wire: definition.wire, mutation: definition.mutation };
    }
    current = definition.contractParent;
  }
}

export function createRegisteredAdapter(
  provider: OcxProviderConfig,
  context: AdapterFactoryContext = {},
): ProviderAdapter {
  const definition = getAdapterDefinition(provider.adapter);
  if (!definition) throw new Error(`Unknown adapter: ${provider.adapter}`);
  const adapter = definition.create(provider, context);
  const buildRequest = adapter.buildRequest.bind(adapter);
  adapter.buildRequest = (parsed, incoming) => {
    const attachTierMetadata = (request: Awaited<ReturnType<ProviderAdapter["buildRequest"]>>) => {
      // OpenAI-family adapters report the exact emitted field themselves. Other adapters
      // still report an exact absence at this serialization boundary, which makes a routed
      // Fast downgrade observable without asking core to infer an outbound body shape.
      request.tierLog ??= createAdapterTierMetadata(
        parsed.options.tierObservation,
        parsed.options.tierDecision,
        null,
        null,
      );
      return request;
    };
    const request = buildRequest(parsed, incoming);
    return request instanceof Promise
      ? request.then(attachTierMetadata)
      : attachTierMetadata(request);
  };
  if (adapter.runTurn && !adapter.tierLogForRunTurn) {
    adapter.tierLogForRunTurn = parsed => createAdapterTierMetadata(
      parsed.options.tierObservation,
      parsed.options.tierDecision,
      null,
      null,
    );
  }
  return adapter;
}
