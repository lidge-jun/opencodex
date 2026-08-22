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
  OcxRoutingUnknownCostCapMode,
} from "../types";
import { codexAccountNamespaceEntries } from "../codex/account-namespaces";
import { listComboIds, resolveComboId } from "../combos";
import { hasOwnProvider } from "../config/provider-name";
import { MAX_COMPATIBILITY_REQUIRED_SUITES } from "./compatibility/types";
import { POLICY_NAMESPACE } from "./profile-namespace";

export { POLICY_NAMESPACE };

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

export const DEFAULT_DEGRADED_EVIDENCE: OcxRoutingUnknownEvidenceMode = "penalize";
export const DEFAULT_COMPATIBILITY_UNKNOWN_EVIDENCE: OcxRoutingUnknownEvidenceMode = "exclude";

export interface NormalizedRoutingProfileCompatibility {
  requiredSuites: Array<{ suiteId: string; evidenceLayer: "protocol_conformance" | "live_route_compatibility" }>;
  minStatus?: "PROBED" | "VERIFIED";
  maxEvidenceAgeMs?: number;
  unknownEvidence: OcxRoutingUnknownEvidenceMode;
  degradedEvidence: OcxRoutingUnknownEvidenceMode;
}

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
  limits: { maxEstimatedCostUsd?: number; onUnknownCost?: OcxRoutingUnknownCostCapMode };
  unknownEvidence: Record<"capability" | "health" | "quota" | "cost", OcxRoutingUnknownEvidenceMode>;
  compatibility?: NormalizedRoutingProfileCompatibility;
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
const EVIDENCE_LAYERS = new Set(["protocol_conformance", "live_route_compatibility"]);

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
      if (limits.onUnknownCost !== undefined
        && limits.onUnknownCost !== "allow"
        && limits.onUnknownCost !== "exclude") {
        issues.push({ path: ["limits", "onUnknownCost"], message: 'onUnknownCost must be "allow" or "exclude"' });
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

  if (body.compatibility !== undefined) {
    if (!body.compatibility || typeof body.compatibility !== "object" || Array.isArray(body.compatibility)) {
      issues.push({ path: ["compatibility"], message: "compatibility must be an object" });
    } else {
      const compatibility = body.compatibility as Record<string, unknown>;
      if (compatibility.requiredSuites !== undefined) {
        if (!Array.isArray(compatibility.requiredSuites)) {
          issues.push({ path: ["compatibility", "requiredSuites"], message: "requiredSuites must be an array" });
        } else {
          if (compatibility.requiredSuites.length > MAX_COMPATIBILITY_REQUIRED_SUITES) {
            issues.push({
              path: ["compatibility", "requiredSuites"],
              message: `requiredSuites must contain at most ${MAX_COMPATIBILITY_REQUIRED_SUITES} entries`,
            });
          }
          const seen = new Set<string>();
          compatibility.requiredSuites.forEach((rawSuite, index) => {
            if (!rawSuite || typeof rawSuite !== "object" || Array.isArray(rawSuite)) {
              issues.push({ path: ["compatibility", "requiredSuites", index], message: "suite entry must be an object" });
              return;
            }
            const suite = rawSuite as Record<string, unknown>;
            const suiteId = typeof suite.suiteId === "string" ? suite.suiteId.trim() : "";
            const layer = suite.evidenceLayer;
            if (!suiteId) {
              issues.push({ path: ["compatibility", "requiredSuites", index, "suiteId"], message: "suiteId is required" });
            }
            if (layer !== "protocol_conformance" && layer !== "live_route_compatibility") {
              issues.push({
                path: ["compatibility", "requiredSuites", index, "evidenceLayer"],
                message: "evidenceLayer must be protocol_conformance or live_route_compatibility",
              });
            }
            if (suiteId && typeof layer === "string" && EVIDENCE_LAYERS.has(layer)) {
              const key = `${layer}:${suiteId}`;
              if (seen.has(key)) {
                issues.push({ path: ["compatibility", "requiredSuites", index], message: `duplicate required suite "${key}"` });
              } else {
                seen.add(key);
              }
            }
          });
        }
      }
      if (compatibility.minStatus !== undefined
        && compatibility.minStatus !== "PROBED"
        && compatibility.minStatus !== "VERIFIED") {
        issues.push({ path: ["compatibility", "minStatus"], message: 'minStatus must be "PROBED" or "VERIFIED"' });
      }
      if (compatibility.maxEvidenceAgeMs !== undefined
        && (typeof compatibility.maxEvidenceAgeMs !== "number"
          || !Number.isInteger(compatibility.maxEvidenceAgeMs)
          || compatibility.maxEvidenceAgeMs < 0)) {
        issues.push({ path: ["compatibility", "maxEvidenceAgeMs"], message: "maxEvidenceAgeMs must be a non-negative integer" });
      }
      for (const key of ["unknownEvidence", "degradedEvidence"] as const) {
        if (compatibility[key] !== undefined
          && compatibility[key] !== "allow"
          && compatibility[key] !== "penalize"
          && compatibility[key] !== "exclude") {
          issues.push({ path: ["compatibility", key], message: `${key} must be "allow", "penalize", or "exclude"` });
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

function normalizedCompatibility(
  raw: OcxRoutingProfileConfig,
): NormalizedRoutingProfileCompatibility | undefined {
  if (raw.compatibility === undefined) return undefined;
  const compatibility = raw.compatibility;
  const requiredSuites = (compatibility.requiredSuites ?? []).map(suite => ({
    suiteId: suite.suiteId.trim(),
    evidenceLayer: suite.evidenceLayer,
  }));
  const unknownEvidence = compatibility.unknownEvidence === "allow"
    || compatibility.unknownEvidence === "penalize"
    || compatibility.unknownEvidence === "exclude"
    ? compatibility.unknownEvidence
    : DEFAULT_COMPATIBILITY_UNKNOWN_EVIDENCE;
  const degradedEvidence = compatibility.degradedEvidence === "allow"
    || compatibility.degradedEvidence === "penalize"
    || compatibility.degradedEvidence === "exclude"
    ? compatibility.degradedEvidence
    : DEFAULT_DEGRADED_EVIDENCE;

  const hasControls = requiredSuites.length > 0
    || compatibility.minStatus !== undefined
    || compatibility.maxEvidenceAgeMs !== undefined
    || compatibility.unknownEvidence !== undefined
    || compatibility.degradedEvidence !== undefined;
  if (!hasControls) return undefined;

  return {
    requiredSuites,
    ...(compatibility.minStatus ? { minStatus: compatibility.minStatus } : {}),
    ...(compatibility.maxEvidenceAgeMs !== undefined ? { maxEvidenceAgeMs: compatibility.maxEvidenceAgeMs } : {}),
    unknownEvidence,
    degradedEvidence,
  };
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
  const compatibility = normalizedCompatibility(raw);
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
      ...(raw.limits?.onUnknownCost !== undefined
        ? { onUnknownCost: raw.limits.onUnknownCost }
        : {}),
    },
    unknownEvidence: normalizedUnknownEvidence(raw),
    ...(compatibility ? { compatibility } : {}),
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
  return Object.keys(config.routingProfiles ?? {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
