import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExportContext, ManagedContribution, OpencodeLaunchEnv } from "./contracts";
import {
  KILO_API_KEY_ENV_REF,
  KILO_CONFIG_SCHEMA,
  OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG,
  OPENCODE_PROVIDER_ID,
} from "./constants";
import {
  authoritativeContextWindow,
  exportModelLabel,
  normalizeExportModels,
  opencodeModelCapabilities,
  outputBudgetFor,
  proxyAdmissionHeaders,
  singleFragment,
} from "./model-metadata";

export const KILO_CONFIG_CANDIDATES = [
  "kilo.jsonc",
  "kilo.json",
  "opencode.jsonc",
  "opencode.json",
  "config.json",
] as const;

export interface KiloModelEntry {
  name: string;
  limit?: { context: number; output: number };
  attachment?: boolean;
  modalities?: { input: string[]; output: string[] };
}

export interface KiloProviderBlock {
  npm: string;
  name: string;
  options: {
    baseURL: string;
    apiKey?: string;
    headers?: Record<string, string>;
  };
  models: Record<string, KiloModelEntry>;
}

export interface KiloGeneratedConfig {
  $schema: string;
  provider: Record<string, KiloProviderBlock>;
}

export function kiloHomeDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(xdg, "kilo");
}

export function kiloConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const dir = kiloHomeDir(env, home);
  for (const name of KILO_CONFIG_CANDIDATES) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return join(dir, "kilo.jsonc");
}

function kiloProviderBlock(ctx: ExportContext): KiloProviderBlock {
  const config = ctx.config ?? OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG;
  const models: Record<string, KiloModelEntry> = {};
  for (const model of normalizeExportModels(ctx.models)) {
    const entry: KiloModelEntry = { name: exportModelLabel(model) };
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.limit = { context, output: outputBudgetFor(context) };
    }
    const capabilities = opencodeModelCapabilities(model.inputModalities);
    if (capabilities) {
      entry.attachment = capabilities.attachment;
      entry.modalities = capabilities.modalities;
    }
    models[model.namespaced] = entry;
  }
  const headers = proxyAdmissionHeaders(config, KILO_API_KEY_ENV_REF);
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "OpenCodex",
    options: headers ? { baseURL: ctx.baseUrl, headers } : { baseURL: ctx.baseUrl, apiKey: KILO_API_KEY_ENV_REF },
    models,
  };
}

export function buildKiloClientConfig(ctx: ExportContext): KiloGeneratedConfig {
  return {
    $schema: KILO_CONFIG_SCHEMA,
    provider: { [OPENCODE_PROVIDER_ID]: kiloProviderBlock(ctx) },
  };
}

export function summarizeKilo(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = Object.values((document as KiloGeneratedConfig | undefined)?.provider?.[OPENCODE_PROVIDER_ID]?.models ?? {});
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => !model.limit).length };
}

export function buildKiloContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildKiloClientConfig(ctx);
  return singleFragment("kilo", ["provider", OPENCODE_PROVIDER_ID], doc.provider[OPENCODE_PROVIDER_ID]);
}
