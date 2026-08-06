/**
 * Routing policy profiles (RI-04): schema validation, normalization, revision
 * digest, and id/alias resolution. Mirrors the combos module discipline
 * (`src/combos/types.ts`) so both virtual-routing namespaces stay consistent.
 */

import { createHash } from "node:crypto";
import type {
  OcxConfig,
  OcxRoutingProfileConfig,
  OcxRoutingUnknownEvidenceMode,
} from "../types";
import { codexAccountNamespaceEntries } from "../codex/account-namespaces";
import { listComboIds, resolveComboId } from "../combos";
import { hasOwnProvider } from "../config";

export const POLICY_NAMESPACE = "policy";

export const POLICY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const POLICY_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
export const NATIVE_OPENAI_FAMILY_PATTERN = /^(?:gpt-|o1-|o3-|o4-|codex-)/;

export const DEFAULT_PROFILE_WEIGHTS = {
  latency: 0.55,
  health: 0.25,
  cost: 0.10,
  quota: 0.10,
} as const;

export const DEFAULT_UNKNOWN_EVIDENCE: Record<"capability" | "health" | "quota" | "cost", OcxRoutingUnknownEvidenceMode> = {
  capability: "exclude",
  health: "penalize",
  quota: "penalize",
  cost: "penalize",
};

export interface RoutingProfileValidationIssue {
  path: Array<string | number>;
  message: string;
}

export interface NormalizedRoutingProfileRequirements {
  minContextWindow?: number;
  /** Minimum remaining quota headroom fraction (0..1). */
  minQuotaHeadroom?: number;
  tools?: boolean;
  imageInput?: boolean;
  structuredOutput?: boolean;
  reasoningEffort?: string;
  serviceTier?: string;
  localOnly?: boolean;
  remoteAllowed?: boolean;
  encryptedCodexTasks?: boolean;
}

export interface NormalizedRoutingProfile {
  id: string;
  alias: string | null;
  candidates: Array<{ provider: string; model: string }>;
  require: NormalizedRoutingProfileRequirements;
  optimize: { latency: number; health: number; cost: number; quota: number };
  limits: { maxEstimatedCostUsd?: number };
  unknownEvidence: Record<"capability" | "health" | "quota" | "cost", OcxRoutingUnknownEvidenceMode>;
  revision: string;
}

const REQUIRE_KEYS = [
  "minContextWindow",
  "minQuotaHeadroom",
  "tools",
  "imageInput",
  "structuredOutput",
  "reasoningEffort",
  "serviceTier",
  "localOnly",
  "remoteAllowed",
  "encryptedCodexTasks",
] as const;

const UNKNOWN_EVIDENCE_KEYS = ["capability", "health", "quota", "cost"] as const;

export function isValidPolicyId(id: string): boolean {
  return POLICY_ID_PATTERN.test(id);
}

export function policyModelId(id: string): string {
  return `${POLICY_NAMESPACE}/${id}`;
}

export function policyPublicModelId(id: string, profile: { alias?: string | null }): string {
  const alias = typeof profile.alias === "string" ? profile.alias.trim() : "";
  return alias || policyModelId(id);
}

export function parsePolicyModelId(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || modelId.slice(0, slash) !== POLICY_NAMESPACE) return null;
  const id = modelId.slice(slash + 1);
  return id.length > 0 ? id : null;
}

/**
 * Resolve a client-requested model id to a policy profile id. The canonical
 * `policy/<id>` form wins first; otherwise an exact alias match.
 */
export function resolvePolicyProfileId(
  config: { routingProfiles?: Record<string, OcxRoutingProfileConfig> },
  modelId: string,
): string | null {
  const direct = parsePolicyModelId(modelId);
  if (direct) return direct;
  const profiles = config.routingProfiles;
  if (!profiles) return null;
  for (const [id, raw] of Object.entries(profiles)) {
    if (!raw || typeof raw !== "object") continue;
    const alias = typeof raw.alias === "string" ? raw.alias.trim() : "";
    if (alias && alias === modelId) return id;
  }
  return null;
}

function aliasIssues(
  id: string,
  alias: string,
  config: Pick<OcxConfig, "providers" | "combos" | "routingProfiles" | "codexAccountNamespaces">,
  options: { excludeProfileId?: string } = {},
): RoutingProfileValidationIssue[] {
  const issues: RoutingProfileValidationIssue[] = [];
  if (!POLICY_ALIAS_PATTERN.test(alias)) {
    issues.push({
      path: ["alias"],
      message: "alias must use letters, numbers, dot, underscore, or hyphen, with at most one \"/\" segment",
    });
    return issues;
  }
  if (alias === POLICY_NAMESPACE || alias.startsWith(`${POLICY_NAMESPACE}/`)) {
    issues.push({
      path: ["alias"],
      message: `alias must not use the reserved "${POLICY_NAMESPACE}/" namespace`,
    });
  }
  if (alias === "combo" || alias.startsWith("combo/")) {
    issues.push({
      path: ["alias"],
      message: `alias must not use the reserved "combo/" namespace`,
    });
  }
  if (!alias.includes("/") && NATIVE_OPENAI_FAMILY_PATTERN.test(alias)) {
    issues.push({
      path: ["alias"],
      message: "bare aliases in the OpenAI native family (gpt-*, o1-*, o3-*, o4-*, codex-*) are not allowed",
    });
  }
  // Cross-namespace collisions: providers, combos, account namespaces, and
  // sibling profile aliases all own public model ids that must stay unique.
  if (hasOwnProvider(config.providers, alias)) {
    issues.push({ path: ["alias"], message: `alias "${alias}" collides with configured provider name "${alias}"` });
  }
  if (resolveComboId({ combos: config.combos }, alias)) {
    issues.push({ path: ["alias"], message: `alias "${alias}" collides with a configured combo selector` });
  }
  if (alias.includes("/") && codexAccountNamespaceEntries(config).some(([namespace]) => namespace === alias.split("/")[0])) {
    issues.push({ path: ["alias"], message: `alias "${alias}" collides with a configured codex account namespace` });
  }
  if (alias.includes("/") && hasOwnProvider(config.providers, alias.split("/")[0])) {
    issues.push({
      path: ["alias"],
      message: `alias "${alias}" collides with the provider routing namespace "${alias.split("/")[0]}"`,
    });
  }
  for (const [otherId, other] of Object.entries(config.routingProfiles ?? {})) {
    if (otherId === id || otherId === options.excludeProfileId) continue;
    const otherAlias = typeof other?.alias === "string" ? other.alias.trim() : "";
    if (otherAlias && otherAlias === alias) {
      issues.push({ path: ["alias"], message: `alias "${alias}" is already used by profile "${otherId}"` });
    }
  }
  return issues;
}

export function routingProfileIssues(
  id: string,
  raw: unknown,
  config: Pick<OcxConfig, "providers" | "combos" | "routingProfiles" | "codexAccountNamespaces">,
  options: { excludeProfileId?: string } = {},
): RoutingProfileValidationIssue[] {
  const issues: RoutingProfileValidationIssue[] = [];
  if (!isValidPolicyId(id)) {
    issues.push({
      path: [],
      message: "profile id must start with a letter/number and use letters, numbers, dot, underscore, or hyphen (max 64)",
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path: [], message: "routing profile must be an object" });
    return issues;
  }
  const body = raw as Record<string, unknown>;

  if (body.alias !== undefined) {
    if (typeof body.alias !== "string") {
      issues.push({ path: ["alias"], message: "alias must be a string" });
    } else {
      const alias = body.alias.trim();
      if (alias) issues.push(...aliasIssues(id, alias, config, options));
    }
  }

  if (!Array.isArray(body.candidates) || body.candidates.length === 0) {
    issues.push({ path: ["candidates"], message: "candidates must be a non-empty array" });
  } else {
    const seen = new Set<string>();
    body.candidates.forEach((rawCandidate, index) => {
      if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) {
        issues.push({ path: ["candidates", index], message: `candidates[${index}] must be an object` });
        return;
      }
      const candidate = rawCandidate as Record<string, unknown>;
      const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
      const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
      if (!provider) {
        issues.push({ path: ["candidates", index, "provider"], message: `candidates[${index}].provider is required` });
      } else if (!hasOwnProvider(config.providers, provider)) {
        issues.push({
          path: ["candidates", index, "provider"],
          message: `candidates[${index}].provider "${provider}" is not configured`,
        });
      } else if (config.providers[provider]?.disabled === true) {
        issues.push({
          path: ["candidates", index, "provider"],
          message: `candidates[${index}].provider "${provider}" is disabled`,
        });
      }
      if (!model) {
        issues.push({ path: ["candidates", index, "model"], message: `candidates[${index}].model is required` });
      }
      if (provider && model) {
        const key = `${provider}/${model}`;
        if (seen.has(key)) {
          issues.push({ path: ["candidates", index], message: `duplicate policy candidate "${key}"` });
        } else {
          seen.add(key);
        }
      }
    });
  }

  if (body.require !== undefined) {
    if (!body.require || typeof body.require !== "object" || Array.isArray(body.require)) {
      issues.push({ path: ["require"], message: "require must be an object" });
    } else {
      const require = body.require as Record<string, unknown>;
      if (require.minContextWindow !== undefined
        && (typeof require.minContextWindow !== "number"
          || !Number.isInteger(require.minContextWindow)
          || require.minContextWindow < 1)) {
        issues.push({ path: ["require", "minContextWindow"], message: "minContextWindow must be a positive integer" });
      }
      if (require.minQuotaHeadroom !== undefined
        && (typeof require.minQuotaHeadroom !== "number"
          || !Number.isFinite(require.minQuotaHeadroom)
          || require.minQuotaHeadroom < 0
          || require.minQuotaHeadroom > 1)) {
        issues.push({ path: ["require", "minQuotaHeadroom"], message: "minQuotaHeadroom must be a number from 0 to 1" });
      }
      for (const key of ["tools", "imageInput", "structuredOutput", "localOnly", "remoteAllowed", "encryptedCodexTasks"] as const) {
        if (require[key] !== undefined && typeof require[key] !== "boolean") {
          issues.push({ path: ["require", key], message: `${key} must be a boolean` });
        }
      }
      if (require.reasoningEffort !== undefined && typeof require.reasoningEffort !== "string") {
        issues.push({ path: ["require", "reasoningEffort"], message: "reasoningEffort must be a string" });
      }
      if (require.serviceTier !== undefined && typeof require.serviceTier !== "string") {
        issues.push({ path: ["require", "serviceTier"], message: "serviceTier must be a string" });
      } else if (require.serviceTier === "unknown") {
        issues.push({
          path: ["require", "serviceTier"],
          message: "serviceTier must not use the reserved \"unknown\" value (it encodes missing evidence)",
        });
      }
    }
  }

  if (body.optimize !== undefined) {
    if (!body.optimize || typeof body.optimize !== "object" || Array.isArray(body.optimize)) {
      issues.push({ path: ["optimize"], message: "optimize must be an object" });
    } else {
      const optimize = body.optimize as Record<string, unknown>;
      const effective: Record<"latency" | "health" | "cost" | "quota", number> = { ...DEFAULT_PROFILE_WEIGHTS };
      for (const key of ["latency", "health", "cost", "quota"] as const) {
        if (optimize[key] !== undefined) {
          if (typeof optimize[key] !== "number"
            || !Number.isFinite(optimize[key])
            || optimize[key] < 0) {
            issues.push({ path: ["optimize", key], message: `${key} must be a non-negative number` });
          } else {
            effective[key] = optimize[key];
          }
        }
      }
      if (Object.values(effective).every(weight => weight === 0)) {
        issues.push({ path: ["optimize"], message: "at least one optimize weight must be positive" });
      }
    }
  }

  if (body.limits !== undefined) {
    if (!body.limits || typeof body.limits !== "object" || Array.isArray(body.limits)) {
      issues.push({ path: ["limits"], message: "limits must be an object" });
    } else {
      const limits = body.limits as Record<string, unknown>;
      if (limits.maxEstimatedCostUsd !== undefined
        && (typeof limits.maxEstimatedCostUsd !== "number"
          || !Number.isFinite(limits.maxEstimatedCostUsd)
          || limits.maxEstimatedCostUsd < 0)) {
        issues.push({ path: ["limits", "maxEstimatedCostUsd"], message: "maxEstimatedCostUsd must be a non-negative number" });
      }
    }
  }

  if (body.unknownEvidence !== undefined) {
    if (!body.unknownEvidence || typeof body.unknownEvidence !== "object" || Array.isArray(body.unknownEvidence)) {
      issues.push({ path: ["unknownEvidence"], message: "unknownEvidence must be an object" });
    } else {
      const unknownEvidence = body.unknownEvidence as Record<string, unknown>;
      for (const key of UNKNOWN_EVIDENCE_KEYS) {
        if (unknownEvidence[key] !== undefined
          && (unknownEvidence[key] !== "allow"
            && unknownEvidence[key] !== "penalize"
            && unknownEvidence[key] !== "exclude")) {
          issues.push({ path: ["unknownEvidence", key], message: `${key} must be "allow", "penalize", or "exclude"` });
        }
      }
    }
  }

  return issues;
}

function normalizedRequirements(raw: OcxRoutingProfileConfig): NormalizedRoutingProfileRequirements {
  const require = raw.require;
  if (!require) return {};
  const out: NormalizedRoutingProfileRequirements = {};
  for (const key of REQUIRE_KEYS) {
    const value = require[key];
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function normalizedUnknownEvidence(raw: OcxRoutingProfileConfig): NormalizedRoutingProfile["unknownEvidence"] {
  const configured = raw.unknownEvidence;
  const out = { ...DEFAULT_UNKNOWN_EVIDENCE };
  if (configured) {
    for (const key of UNKNOWN_EVIDENCE_KEYS) {
      const value = configured[key];
      if (value === "allow" || value === "penalize" || value === "exclude") {
        out[key] = value;
      }
    }
  }
  return out;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function profileRevision(profile: Omit<NormalizedRoutingProfile, "revision">): string {
  const digest = createHash("sha256").update(canonicalJson(profile)).digest("hex");
  return digest.slice(0, 16);
}

export function normalizeRoutingProfile(id: string, raw: OcxRoutingProfileConfig): NormalizedRoutingProfile {
  const alias = typeof raw.alias === "string" ? raw.alias.trim() : "";
  const weights = { ...DEFAULT_PROFILE_WEIGHTS, ...(raw.optimize ?? {}) };
  const weightSum = weights.latency + weights.health + weights.cost + weights.quota;
  const safeSum = weightSum > 0 ? weightSum : 1;
  const profile: Omit<NormalizedRoutingProfile, "revision"> = {
    id,
    alias: alias || null,
    candidates: raw.candidates.map(candidate => ({
      provider: candidate.provider.trim(),
      model: candidate.model.trim(),
    })),
    require: normalizedRequirements(raw),
    optimize: {
      latency: weights.latency / safeSum,
      health: weights.health / safeSum,
      cost: weights.cost / safeSum,
      quota: weights.quota / safeSum,
    },
    limits: {
      ...(raw.limits?.maxEstimatedCostUsd !== undefined
        ? { maxEstimatedCostUsd: raw.limits.maxEstimatedCostUsd }
        : {}),
    },
    unknownEvidence: normalizedUnknownEvidence(raw),
  };
  return { ...profile, revision: profileRevision(profile) };
}

export function getRoutingProfile(
  config: { routingProfiles?: Record<string, OcxRoutingProfileConfig> },
  id: string,
): NormalizedRoutingProfile | undefined {
  const profiles = config.routingProfiles;
  if (!profiles || !Object.hasOwn(profiles, id)) return undefined;
  return normalizeRoutingProfile(id, profiles[id]!);
}

export function listRoutingProfileIds(config: { routingProfiles?: Record<string, OcxRoutingProfileConfig> }): string[] {
  // Code-unit comparison: deterministic across ICU versions/platforms, which
  // matters for the API/CLI list contract (ids may contain ".", "_", "-").
  return Object.keys(config.routingProfiles ?? {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
