import { homedir } from "node:os";
import { join } from "node:path";
import { isLoopbackHostname, shouldInjectApiAuthHeader } from "../../codex/loopback-target";
import { absoluteClientPath } from "../client-path";
import type { ExportContext, ExportModel, ManagedContribution, OpencodeLaunchEnv } from "./contracts";
import { LOOPBACK_API_KEY_PLACEHOLDER, OPENCODE_PROVIDER_ID } from "./constants";
import { authoritativeContextWindow, normalizeExportModels } from "./model-metadata";

/**
 * GitHub Copilot CLI reads custom providers from `providers.json` under
 * `COPILOT_HOME` (default `~/.copilot`), and `COPILOT_PROVIDERS_CONFIG` names the
 * file outright when set. Both overrides are documented in the CLI configuration
 * directory reference; export and detection resolve them here so they agree.
 * A relative override is refused because opencodex and the CLI would anchor it
 * to different working directories.
 */
export function githubCopilotHomeDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const override = env.COPILOT_HOME?.trim();
  if (!override) return join(home, ".copilot");
  return absoluteClientPath(override, home, "COPILOT_HOME");
}

export function githubCopilotConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const override = env.COPILOT_PROVIDERS_CONFIG?.trim();
  if (override) return absoluteClientPath(override, home, "COPILOT_PROVIDERS_CONFIG");
  return join(githubCopilotHomeDir(env, home), "providers.json");
}

/** One `providers[]` entry: an OpenAI-compatible endpoint the CLI dials itself. */
export interface GithubCopilotProvider {
  name: typeof OPENCODE_PROVIDER_ID;
  type: "openai";
  baseUrl: string;
  apiKey: string;
}

/** One `models[]` entry. `wireModel` is the selector the proxy resolves. */
export interface GithubCopilotModel {
  id: string;
  provider: typeof OPENCODE_PROVIDER_ID;
  wireModel: string;
  maxPromptTokens?: number;
}

/** The two arrays opencodex owns inside Copilot's `providers.json`. */
export interface GithubCopilotGeneratedConfig {
  providers: GithubCopilotProvider[];
  models: GithubCopilotModel[];
}

/**
 * One provider named `opencodex` plus one model row per normalized export model.
 *
 * Copilot's `type: "openai"` covers any OpenAI-compatible endpoint and defaults
 * to Chat Completions, which is the proxy's `/v1/chat/completions`. The CLI
 * shows `id` in its picker and sends `wireModel` (falling back to `id`) as the
 * model name, so `wireModel` carries the proxy selector while `id` stays a bare
 * slug the picker can display. `maxPromptTokens` is set only from an
 * authoritative context window: an unknown model otherwise makes the CLI assume
 * 128,000, and inventing a larger number would not enlarge the window.
 *
 * `apiKey` is the non-secret loopback placeholder. Copilot stores the value as
 * plain text and never expands `$ENV` references, so there is no safe place for
 * a real credential and the export refuses any listener that needs one.
 */
function githubCopilotDocument(ctx: ExportContext): GithubCopilotGeneratedConfig {
  const provider: GithubCopilotProvider = {
    name: OPENCODE_PROVIDER_ID,
    type: "openai",
    baseUrl: ctx.baseUrl,
    apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
  };
  return {
    providers: [provider],
    models: normalizeExportModels(ctx.models).map(model => githubCopilotModel(model)),
  };
}

function githubCopilotModel(model: ExportModel): GithubCopilotModel {
  const maxPromptTokens = authoritativeContextWindow(model.contextWindow);
  return {
    id: model.id,
    provider: OPENCODE_PROVIDER_ID,
    wireModel: model.namespaced,
    ...(maxPromptTokens ? { maxPromptTokens } : {}),
  };
}

/** Refuses any listener that needs an admission header: Copilot would send only the placeholder. */
export function buildGithubCopilotClientConfig(ctx: ExportContext): GithubCopilotGeneratedConfig {
  if (shouldInjectApiAuthHeader(ctx.config) || !isLoopbackHostname(new URL(ctx.baseUrl).hostname)) {
    throw new Error("GitHub Copilot's placeholder API key requires a loopback-only listener.");
  }
  return githubCopilotDocument(ctx);
}

export function summarizeGithubCopilot(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as GithubCopilotGeneratedConfig | undefined)?.models ?? [];
  const owned = models.filter(model => model?.provider === OPENCODE_PROVIDER_ID);
  return { modelCount: owned.length, modelsWithoutLimits: owned.filter(model => !model.maxPromptTokens).length };
}

/**
 * Refuse apply and refresh while a model id cannot be named by a selector.
 * Copilot's `models` is an array keyed by `id`, and an id carrying `]` or `=`
 * has no selector the ownership record can spell, so writing it would leave a
 * row disable could not find again. Status and disable stay available.
 */
export function githubCopilotApplyRefusal(ctx: ExportContext): string | null {
  const models = normalizeExportModels(ctx.models);
  if (models.length === 0) return "GitHub Copilot has no models in the selected OpenCodex catalog.";
  if (models.some(model => model.id.includes("]") || model.id.includes("="))) {
    return "A GitHub Copilot model ID cannot be represented by a managed array selector.";
  }
  return null;
}

export function buildGithubCopilotContribution(ctx: ExportContext): ManagedContribution {
  // The writer gates admission before applying. Classification and disable must
  // still work after the operator changes the proxy to a non-loopback bind.
  const doc = githubCopilotDocument(ctx);
  return {
    clientId: "github-copilot",
    fragments: [
      { path: ["providers", `[name=${OPENCODE_PROVIDER_ID}]`], value: doc.providers[0] },
      ...doc.models.map(model => ({ path: ["models", `[id=${model.id}]`], value: model })),
    ],
  };
}
