// Command Code config export.
import type { ExportContext, ManagedContribution } from "./contracts";
import { normalizeExportModels, authoritativeContextWindow, singleFragment } from "./model-metadata";
import { OPENCODE_PROVIDER_ID, LOOPBACK_API_KEY_PLACEHOLDER } from "./constants";
import { sanitizeCodexReasoningEfforts } from "../../reasoning-effort";

export interface CommandCodeModelEntry {
  reasoningEfforts?: string[];
  contextWindow?: number;
}

export interface CommandCodeProviderBlock {
  name: "OpenCodex";
  api: "openai-completions";
  baseURL: string;
  apiKey: string | boolean;
  models: Record<string, CommandCodeModelEntry>;
}

export interface CommandCodeGeneratedConfig {
  provider: Record<string, CommandCodeProviderBlock>;
  /** The root a pre-existing target already uses; see {@link commandCodeProviderRoot}. */
  providers?: Record<string, CommandCodeProviderBlock>;
}

/**
 * LOSSY spelling-collision key for a routed selector — not model identity.
 *
 * One provider model reaches this exporter under interchangeable spellings: the raw
 * selector keeps inner slashes (`command-code/deepseek/deepseek-v4.1-flash`, what
 * `/v1/models` publishes) while the Codex-facing form encodes them as dashes
 * (`command-code/deepseek-deepseek-v4.1-flash`, what `~/.codex/config.toml` stores and
 * what an operator typing `--model` copies). Command Code addresses models by exact key,
 * so a catalog that carries both spellings can resolve the active model against one and
 * miss it in the other.
 *
 * The slash is meaningful: it separates the provider from the model id, and a provider id
 * never contains one. But the encoding is NOT bijective — `p/a/b` and `p/a-b` are
 * different model ids that encode to the same string. That is the same lossy relation
 * `slugEquivalenceKey` documents in src/providers/slug-codec.ts and the same ambiguity
 * `resolveSlugAliasCollisions` guards in the catalog. Callers must therefore never drop
 * a row on this key alone; buildCommandCodeClientConfig additionally compares provider
 * and id before folding two rows into one.
 */
function canonicalSpellingOf(namespaced: string): string {
  const slash = namespaced.indexOf("/");
  if (slash <= 0) return namespaced;
  return namespaced.slice(0, slash) + "/" + namespaced.slice(slash + 1).replaceAll("/", "-");
}

export function buildCommandCodeClientConfig(ctx: ExportContext): CommandCodeGeneratedConfig {
  const models: Record<string, CommandCodeModelEntry> = {};
  // Fold interchangeable spellings of one model onto a single key. The first
  // occurrence wins per provider+id identity; distinct model ids that happen to
  // share a lossy spelling collision must both remain addressable.
  const emittedIdentitiesByCollision = new Map<string, Set<string>>();
  for (const model of normalizeExportModels(ctx.models)) {
    const emittedKey = model.namespaced;
    const collisionKey = canonicalSpellingOf(model.namespaced);
    const identity = `${model.provider}\u0000${model.id}`;
    const identities = emittedIdentitiesByCollision.get(collisionKey) ?? new Set<string>();
    if (identities.has(identity)) continue;
    identities.add(identity);
    emittedIdentitiesByCollision.set(collisionKey, identities);
    const entry: CommandCodeModelEntry = {};
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.contextWindow = context;
    }
    const efforts = sanitizeCodexReasoningEfforts(model.reasoningEfforts)
      ?.filter(effort => ["low", "medium", "high", "xhigh", "max"].includes(effort));
    if (efforts && efforts.length > 0) {
      entry.reasoningEfforts = efforts;
    }
    models[emittedKey] = entry;
  }
  return {
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        name: "OpenCodex",
        api: "openai-completions",
        baseURL: ctx.baseUrl.replace(/\/v1\/?$/, "") + "/v1",
        apiKey: false,
        models,
      },
    },
  };
}

/**
 * The root key Command Code actually reads: `provider`, else `providers`.
 *
 * Verified against the published client (`command-code@1.66.0`, `dist/cli.mjs`):
 * `const o = e.provider ?? e.providers;` — singular wins, and the plural branch is
 * only reached when the singular root is nullish (`null` or `undefined`). Adding a
 * singular root to a document that already carries a plural one therefore does not
 * merge the two: the old entries stay on disk, byte for byte, and become invisible
 * to the consumer.
 *
 * Evaluates nullish precedence before container validation so that non-nullish
 * invalid singular values (such as strings or arrays) remain selected and are refused
 * by the container guard rather than falling through to write an unreachable plural block.
 */
export function commandCodeProviderRoot(document: unknown): "provider" | "providers" {
  const doc = document as { provider?: unknown; providers?: unknown } | null | undefined;
  if (doc?.provider !== undefined && doc?.provider !== null) return "provider";
  if (doc?.providers !== undefined && doc?.providers !== null) return "providers";
  // Nothing established yet: the singular root is the one this exporter writes.
  return "provider";
}

export function summarizeCommandCode(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const doc = document as CommandCodeGeneratedConfig | undefined;
  const root = commandCodeProviderRoot(document);
  const models = Object.values(doc?.[root]?.[OPENCODE_PROVIDER_ID]?.models ?? {}) as CommandCodeModelEntry[];
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length };
}

/**
 * The provider block, written under whichever root the target document already uses.
 *
 * `ExportContext` carries the parsed target document so the root can be chosen from
 * what is on disk rather than assumed. A fresh file gets the singular root this
 * exporter has always written; a document that already carries a plural root keeps
 * it, so enabling OpenCodex never makes the user's other providers unreadable.
 */
export function buildCommandCodeContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildCommandCodeClientConfig(ctx);
  const root = commandCodeProviderRoot(ctx.document);
  return singleFragment("commandcode", [root, OPENCODE_PROVIDER_ID], doc.provider[OPENCODE_PROVIDER_ID]);
}
