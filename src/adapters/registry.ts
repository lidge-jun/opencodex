import { createAnthropicAdapter } from "./anthropic";
import { createAzureAdapter } from "./azure";
import type { ProviderAdapter } from "./base";
import { createClaudeAgentSdkAdapter } from "./claude-agent-sdk/adapter";
import { withClinePassDeepSeekV4ToolReplayCompatibility } from "./cline-pass-deepseek-v4-tool-replay";
import { withUniqueToolCallIds } from "./unique-tool-call-ids";
import { createCodeBuddyAdapter } from "./codebuddy/adapter";
import { createQoderAdapter } from "./qoder/adapter";
import { createCommandCodeAdapter } from "./command-code";
import { createCursorAdapter } from "./cursor";
import { createDevinAdapter } from "./devin";
import { createGoogleAdapter } from "./google";
import { createKiroAdapter } from "./kiro";
import { createMimoFreeAdapter } from "./mimo-free";
import { createOpenAIChatAdapter } from "./openai-chat";
import { createOllamaNativeAdapter } from "./ollama-native";
import { createResponsesPassthroughAdapter } from "./openai-responses";
import type { OcxProviderConfig } from "../types";
import { createAdapterTierMetadata } from "../providers/fastwire";
import { resolveDeprecatedProviderId } from "../providers/deprecated-provider-aliases";
import { withInputMediaGuard } from "./input-media-guard";

export type AdapterCacheRetention = "none" | "short" | "long";

export interface AdapterFactoryContext {
  cacheRetention?: AdapterCacheRetention;
  /**
   * The configured provider row this adapter serves.
   *
   * Needed when one adapter backs two provider ids whose credentials differ:
   * `devin` and `devin-cli` share a transport and a token format but sign in to
   * different accounts and can sit on different Cognition tenants, and the tenant
   * is recorded on the credential rather than in the registry. Optional, and
   * every other adapter ignores it.
   */
  providerId?: string;
}

export type AdapterWire =
  | "codebuddy"
  | "command-code"
  | "openai-chat"
  | "ollama-native"
  | "anthropic"
  | "openai-responses"
  | "google"
  | "kiro"
  | "cursor"
  | "devin";

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
  codebuddy: {
    wire: "codebuddy",
    mutation: "codex-owned",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createCodeBuddyAdapter(provider),
  },
  "command-code": {
    wire: "command-code",
    mutation: "codex-owned",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createCommandCodeAdapter(provider),
  },
  "openai-chat": {
    wire: "openai-chat",
    mutation: "codex-owned",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) =>
      withUniqueToolCallIds(withClinePassDeepSeekV4ToolReplayCompatibility(createOpenAIChatAdapter(provider))),
  },
  "ollama-native": {
    wire: "ollama-native",
    mutation: "codex-owned",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createOllamaNativeAdapter(provider),
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
  devin: {
    wire: "devin",
    mutation: "codex-owned",
    create: (provider: OcxProviderConfig, context: AdapterFactoryContext) => createDevinAdapter(provider, context),
  },
  "mimo-free": {
    contractParent: "openai-chat",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createMimoFreeAdapter(provider),
  },
  qoder: {
    contractParent: "codebuddy",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createQoderAdapter(provider),
  },
  "claude-agent-sdk": {
    // Anthropic's Claude Agent SDK drives the same harness this repo already reaches through the
    // CodeBuddy and Qoder CLIs, so the contract is inherited rather than restated. The family owns
    // its options and env, and the harness owns the credential: the adapter stores and injects none.
    contractParent: "codebuddy",
    create: (provider: OcxProviderConfig, _context: AdapterFactoryContext) => createClaudeAgentSdkAdapter(provider),
  },
} as const satisfies Record<string, AdapterDefinition>;

export type AdapterId = keyof typeof ADAPTER_REGISTRY;
export type RegisteredAdapterDefinition = typeof ADAPTER_REGISTRY[AdapterId];

export function adapterDefinitions(): Array<[AdapterId, RegisteredAdapterDefinition]> {
  return Object.entries(ADAPTER_REGISTRY) as Array<[AdapterId, RegisteredAdapterDefinition]>;
}

export function getAdapterDefinition(adapterId: unknown): RegisteredAdapterDefinition | undefined {
  if (typeof adapterId !== "string") return undefined;
  // A retired provider id is also a retired adapter id, and the adapter string is the half a saved
  // row can still carry: the rename projection leaves a row in place when the destination is taken,
  // and a hand-edited config never runs the projection at all. No other form of that mechanism
  // exists, so both lookups read one table and cannot disagree about what an id means.
  const resolved = resolveDeprecatedProviderId(adapterId);
  if (!Object.hasOwn(ADAPTER_REGISTRY, resolved)) return undefined;
  return ADAPTER_REGISTRY[resolved as AdapterId];
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
  const wire = effectiveAdapterContract(provider.adapter).wire;
  if (wire !== "openai-responses") {
    withInputMediaGuard(adapter, wire);
  }
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
