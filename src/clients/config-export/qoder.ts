import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isLoopbackHostname, shouldInjectApiAuthHeader } from "../../codex/loopback-target";
import { ClientPathError } from "../client-path";
import type { ExportContext, ManagedContribution, OpencodeLaunchEnv } from "./contracts";
import { LOOPBACK_API_KEY_PLACEHOLDER, OPENCODE_PROVIDER_ID } from "./constants";
import { authoritativeContextWindow, normalizeExportModels } from "./model-metadata";

/**
 * Qoder's configuration directory: `QODER_CONFIG_DIR` when set, otherwise `~/.qoder`
 * (https://docs.qoder.com/cli/settings-reference). Export and detection both resolve it here.
 * A relative override is refused because opencodex and Qoder would anchor it to different cwds.
 */
export function qoderHomeDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const override = env.QODER_CONFIG_DIR?.trim();
  if (!override) return join(home, ".qoder");
  if (override === "~") return home;
  if (override.startsWith("~/") || override.startsWith("~\\")) return join(home, override.slice(2));
  if (!isAbsolute(override)) {
    throw new ClientPathError(
      `QODER_CONFIG_DIR must be an absolute path or start with ~; "${override}" depends on the working directory, `
      + "so opencodex and Qoder would disagree about which file it names.",
    );
  }
  return override;
}

export function qoderConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(qoderHomeDir(env, home), "settings.json");
}

/** Qoder IDE and qodercli share this custom-provider catalog. */
export function buildQoderClientConfig(ctx: ExportContext) {
  if (shouldInjectApiAuthHeader(ctx.config) || !isLoopbackHostname(new URL(ctx.baseUrl).hostname)) {
    throw new Error("Qoder's placeholder API key requires a loopback-only listener.");
  }
  return qoderDocument(ctx);
}

function qoderDocument(ctx: ExportContext) {
  const models = normalizeExportModels(ctx.models);
  return {
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        type: "openai-compatible",
        protocol: "openai",
        displayName: "opencodex",
        baseUrl: ctx.baseUrl,
        apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
        ...(models[0] ? { defaultModel: models[0].namespaced } : {}),
        // Register each key once; legacy customModels entries shadow this provider.
        models: models.map(model => ({
          model: model.namespaced,
          displayName: model.namespaced,
          contextWindow: authoritativeContextWindow(model.contextWindow) ?? 128000,
        })),
      },
    },
  };
}

export type QoderGeneratedConfig = ReturnType<typeof buildQoderClientConfig>;

export function summarizeQoder(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as QoderGeneratedConfig | undefined)?.providers?.[OPENCODE_PROVIDER_ID]?.models ?? [];
  return { modelCount: models.length, modelsWithoutLimits: 0 };
}

export function buildQoderContribution(ctx: ExportContext): ManagedContribution {
  // The writer gates admission before applying. Classification and disable must
  // still work after the operator changes the proxy to a non-loopback bind.
  const doc = qoderDocument(ctx);
  return {
    clientId: "qoder",
    fragments: [
      { path: ["providers", OPENCODE_PROVIDER_ID], value: doc.providers[OPENCODE_PROVIDER_ID] },
    ],
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Does an unowned legacy `modelConfigs.customModels` row name a model this
 * contribution's provider catalog exports? Qoder rejects the whole provider
 * when one key appears in both catalogs, so keeping such a row while adding
 * `providers.opencodex` recreates the failure the provider-only export fixes,
 * and deleting it would discard configuration we never wrote. `owned` holds
 * the rows an ownership record still names; refresh removes those itself.
 */
export function qoderLegacyCatalogCollision(
  doc: unknown,
  contribution: ManagedContribution,
  owned: ReadonlySet<unknown>,
): boolean {
  const provider = contribution.fragments.find(fragment => fragment.path.length === 2
    && fragment.path[0] === "providers" && fragment.path[1] === OPENCODE_PROVIDER_ID)?.value;
  const exported = new Set(isPlainRecord(provider) && Array.isArray(provider.models)
    ? provider.models.flatMap(model => isPlainRecord(model) && typeof model.model === "string" ? [model.model] : [])
    : []);
  const modelConfigs = isPlainRecord(doc) ? doc.modelConfigs : undefined;
  const rows = isPlainRecord(modelConfigs) ? modelConfigs.customModels : undefined;
  if (exported.size === 0 || !Array.isArray(rows)) return false;
  return rows.some(row => isPlainRecord(row) && row.provider === OPENCODE_PROVIDER_ID
    && typeof row.model === "string" && exported.has(row.model) && !owned.has(row));
}
