import { providerConfigSeed } from "../derive";
import { getProviderRegistryEntry, type ProviderRegistryEntry } from "../registry";
import type { OcxProviderConfig } from "../../types";
import {
  REPLIT_ANTHROPIC_PROVIDER_ID,
  REPLIT_OPENAI_PROVIDER_ID,
} from "./constants";
import type { ValidatedReplitOrigin } from "./origin";

export interface ReplitDerivedProvider {
  name: typeof REPLIT_OPENAI_PROVIDER_ID | typeof REPLIT_ANTHROPIC_PROVIDER_ID;
  provider: OcxProviderConfig;
}

export interface ReplitProviderPair {
  openai: ReplitDerivedProvider & { name: typeof REPLIT_OPENAI_PROVIDER_ID };
  anthropic: ReplitDerivedProvider & { name: typeof REPLIT_ANTHROPIC_PROVIDER_ID };
}

let replitRegistrySeedTestHooks: {
  openai?: ProviderRegistryEntry;
  anthropic?: ProviderRegistryEntry;
} | null = null;

/** Test-only seam for promoted-registry derivation without adding real registry rows. */
export function setReplitRegistrySeedTestHooks(
  hooks: { openai?: ProviderRegistryEntry; anthropic?: ProviderRegistryEntry } | null,
): void {
  replitRegistrySeedTestHooks = hooks;
}

function resolveRegistrySeed(providerId: string): OcxProviderConfig | undefined {
  const testEntry = providerId === REPLIT_OPENAI_PROVIDER_ID
    ? replitRegistrySeedTestHooks?.openai
    : providerId === REPLIT_ANTHROPIC_PROVIDER_ID
      ? replitRegistrySeedTestHooks?.anthropic
      : undefined;
  const entry = testEntry ?? getProviderRegistryEntry(providerId);
  return entry ? providerConfigSeed(entry) : undefined;
}

function customOpenAiFallback(): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    authMode: "key",
    liveModels: true,
    note: "User-deployed Replit gateway companion (OpenAI Chat wire)",
    baseUrl: "",
  };
}

function customAnthropicFallback(): OcxProviderConfig {
  return {
    adapter: "anthropic",
    authMode: "key",
    apiKeyTransport: "bearer",
    liveModels: false,
    note: "User-deployed Replit gateway companion (Anthropic Messages wire)",
    baseUrl: "",
  };
}

export function deriveReplitProviderPair(origin: ValidatedReplitOrigin): ReplitProviderPair {
  const openaiSeed = resolveRegistrySeed(REPLIT_OPENAI_PROVIDER_ID) ?? customOpenAiFallback();
  const anthropicSeed = resolveRegistrySeed(REPLIT_ANTHROPIC_PROVIDER_ID) ?? customAnthropicFallback();
  const openaiProvider: OcxProviderConfig = {
    ...openaiSeed,
    baseUrl: `${origin}/v1`,
  };
  delete openaiProvider.apiKeyTransport;
  return {
    openai: {
      name: REPLIT_OPENAI_PROVIDER_ID,
      provider: openaiProvider,
    },
    anthropic: {
      name: REPLIT_ANTHROPIC_PROVIDER_ID,
      provider: {
        ...anthropicSeed,
        baseUrl: origin,
        liveModels: anthropicSeed.liveModels ?? false,
      },
    },
  };
}
