export type UnknownEvidenceMode = "allow" | "penalize" | "exclude";

export type CompatibilitySuiteDraft = {
  suiteId: string;
  evidenceLayer: "protocol_conformance" | "live_route_compatibility";
};
export type UnknownCostCapMode = "allow" | "exclude";
export type OptionalBoolean = "" | "true" | "false";

export type RoutingProfileCandidate = {
  provider: string;
  model: string;
};

/**
 * Draft-only candidate carrying a stable client-side identity for list keys.
 * The key never reaches the server: `routingProfilePutBody` strips it.
 */
export type RoutingProfileDraftCandidate = RoutingProfileCandidate & { key: string };

let draftCandidateKey = 0;
function newDraftCandidateKey(): string {
  draftCandidateKey += 1;
  return `candidate-${draftCandidateKey}`;
}

/** Create a draft candidate with a fresh stable key. */
export function newDraftCandidate(
  provider: string,
  model: string,
): RoutingProfileDraftCandidate {
  return { provider, model, key: newDraftCandidateKey() };
}

export type RoutingProfileDto = {
  id: string;
  alias: string | null;
  model: string;
  revision: string;
  candidates: RoutingProfileCandidate[];
  require: {
    minContextWindow?: number;
    minQuotaHeadroom?: number;
    tools?: boolean;
    imageInput?: boolean;
    structuredOutput?: boolean;
    reasoningEffort?: string;
    serviceTier?: string;
    localOnly?: boolean;
    remoteAllowed?: boolean;
    encryptedCodexTasks?: boolean;
  };
  optimize: {
    latency: number;
    health: number;
    cost: number;
    quota: number;
  };
  limits: {
    maxEstimatedCostUsd?: number;
    onUnknownCost?: UnknownCostCapMode;
  };
  unknownEvidence: Record<"capability" | "health" | "quota" | "cost", UnknownEvidenceMode>;
  compatibility?: {
    requiredSuites: CompatibilitySuiteDraft[];
    minStatus?: "PROBED" | "VERIFIED";
    maxEvidenceAgeMs?: number;
    unknownEvidence?: UnknownEvidenceMode;
    degradedEvidence?: UnknownEvidenceMode;
  };
};


export type RoutingProfileDraft = {
  id: string;
  alias: string;
  candidates: RoutingProfileDraftCandidate[];
  require: {
    minContextWindow: string;
    minQuotaHeadroom: string;
    tools: OptionalBoolean;
    imageInput: OptionalBoolean;
    structuredOutput: OptionalBoolean;
    reasoningEffort: string;
    serviceTier: string;
    localOnly: OptionalBoolean;
    remoteAllowed: OptionalBoolean;
    encryptedCodexTasks: OptionalBoolean;
  };
  optimize: {
    latency: string;
    health: string;
    cost: string;
    quota: string;
  };
  limits: {
    maxEstimatedCostUsd: string;
    onUnknownCost: UnknownCostCapMode;
  };
  unknownEvidence: Record<"capability" | "health" | "quota" | "cost", UnknownEvidenceMode>;
  compatibility: {
    enabled: boolean;
    requiredSuites: CompatibilitySuiteDraft[];
    minStatus: "" | "PROBED" | "VERIFIED";
    maxEvidenceAgeMs: string;
    unknownEvidence: UnknownEvidenceMode;
    degradedEvidence: UnknownEvidenceMode;
  };
};

export type ModelOption = {
  provider: string;
  id: string;
};

/** Keep only well-formed suite rows so editor list helpers never call `.some` on garbage. */
export function normalizeCompatibilitySuites(raw: unknown): CompatibilitySuiteDraft[] {
  if (!Array.isArray(raw)) return [];
  const suites: CompatibilitySuiteDraft[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const suiteId = typeof (row as { suiteId?: unknown }).suiteId === "string"
      ? (row as { suiteId: string }).suiteId.trim()
      : "";
    const evidenceLayer = (row as { evidenceLayer?: unknown }).evidenceLayer;
    if (
      !suiteId
      || (evidenceLayer !== "protocol_conformance" && evidenceLayer !== "live_route_compatibility")
    ) {
      continue;
    }
    suites.push({ suiteId, evidenceLayer });
  }
  return suites;
}

/**
 * Normalize an optional compatibility DTO. Malformed blocks become `undefined`
 * (treated as no compatibility policy) rather than crashing the editor.
 */
export function normalizeCompatibilityDto(
  raw: unknown,
): RoutingProfileDto["compatibility"] | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const compatibility: NonNullable<RoutingProfileDto["compatibility"]> = {
    requiredSuites: normalizeCompatibilitySuites(obj.requiredSuites),
  };
  if (obj.minStatus === "PROBED" || obj.minStatus === "VERIFIED") {
    compatibility.minStatus = obj.minStatus;
  }
  if (typeof obj.maxEvidenceAgeMs === "number" && Number.isFinite(obj.maxEvidenceAgeMs) && obj.maxEvidenceAgeMs >= 0) {
    compatibility.maxEvidenceAgeMs = obj.maxEvidenceAgeMs;
  }
  if (obj.unknownEvidence === "allow" || obj.unknownEvidence === "penalize" || obj.unknownEvidence === "exclude") {
    compatibility.unknownEvidence = obj.unknownEvidence;
  }
  if (obj.degradedEvidence === "allow" || obj.degradedEvidence === "penalize" || obj.degradedEvidence === "exclude") {
    compatibility.degradedEvidence = obj.degradedEvidence;
  }
  return compatibility;
}

const DEFAULT_OPTIMIZE = {
  latency: "0.55",
  health: "0.25",
  cost: "0.1",
  quota: "0.1",
} as const;

const DEFAULT_UNKNOWN_EVIDENCE = {
  capability: "exclude",
  health: "penalize",
  quota: "penalize",
  cost: "penalize",
} as const;

function optionalBoolean(value: boolean | undefined): OptionalBoolean {
  if (value === true) return "true";
  if (value === false) return "false";
  return "";
}

function numberInput(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

export function newRoutingProfileDraft(
  provider = "",
  model = "",
): RoutingProfileDraft {
  return {
    id: "",
    alias: "",
    candidates: [newDraftCandidate(provider, model)],
    require: {
      minContextWindow: "",
      minQuotaHeadroom: "",
      tools: "",
      imageInput: "",
      structuredOutput: "",
      reasoningEffort: "",
      serviceTier: "",
      localOnly: "",
      remoteAllowed: "",
      encryptedCodexTasks: "",
    },
    optimize: { ...DEFAULT_OPTIMIZE },
    limits: { maxEstimatedCostUsd: "", onUnknownCost: "allow" },
    unknownEvidence: { ...DEFAULT_UNKNOWN_EVIDENCE },
    compatibility: {
      enabled: false,
      requiredSuites: [],
      minStatus: "",
      maxEvidenceAgeMs: "",
      unknownEvidence: "exclude",
      degradedEvidence: "penalize",
    },
  };
}

export function routingProfileDraftFromDto(profile: RoutingProfileDto): RoutingProfileDraft {
  const compatibility = normalizeCompatibilityDto(profile.compatibility);
  return {
    id: profile.id,
    alias: profile.alias ?? "",
    candidates: profile.candidates.map(candidate => ({ ...candidate, key: newDraftCandidateKey() })),
    require: {
      minContextWindow: numberInput(profile.require.minContextWindow),
      minQuotaHeadroom: numberInput(profile.require.minQuotaHeadroom),
      tools: optionalBoolean(profile.require.tools),
      imageInput: optionalBoolean(profile.require.imageInput),
      structuredOutput: optionalBoolean(profile.require.structuredOutput),
      reasoningEffort: profile.require.reasoningEffort ?? "",
      serviceTier: profile.require.serviceTier ?? "",
      localOnly: optionalBoolean(profile.require.localOnly),
      remoteAllowed: optionalBoolean(profile.require.remoteAllowed),
      encryptedCodexTasks: optionalBoolean(profile.require.encryptedCodexTasks),
    },
    optimize: {
      latency: String(profile.optimize.latency),
      health: String(profile.optimize.health),
      cost: String(profile.optimize.cost),
      quota: String(profile.optimize.quota),
    },
    limits: {
      maxEstimatedCostUsd: numberInput(profile.limits.maxEstimatedCostUsd),
      onUnknownCost: profile.limits.onUnknownCost === "exclude" ? "exclude" : "allow",
    },
    unknownEvidence: { ...profile.unknownEvidence },
    compatibility: {
      enabled: Boolean(compatibility),
      requiredSuites: compatibility?.requiredSuites ?? [],
      minStatus: compatibility?.minStatus ?? "",
      maxEvidenceAgeMs: numberInput(compatibility?.maxEvidenceAgeMs),
      unknownEvidence: compatibility?.unknownEvidence ?? "exclude",
      degradedEvidence: compatibility?.degradedEvidence ?? "penalize",
    },
  };
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : undefined;
}

function draftBoolean(value: OptionalBoolean): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export type RoutingProfileWriteMode = "create" | "update";

export function routingProfilePutBody(
  draft: RoutingProfileDraft,
  mode: RoutingProfileWriteMode,
  expectedRevision?: string,
): {
  mode: RoutingProfileWriteMode;
  id: string;
  expectedRevision?: string;
  profile: Record<string, unknown>;
} {
  const require = compactRecord({
    minContextWindow: optionalNumber(draft.require.minContextWindow),
    minQuotaHeadroom: optionalNumber(draft.require.minQuotaHeadroom),
    tools: draftBoolean(draft.require.tools),
    imageInput: draftBoolean(draft.require.imageInput),
    structuredOutput: draftBoolean(draft.require.structuredOutput),
    reasoningEffort: draft.require.reasoningEffort.trim() || undefined,
    serviceTier: draft.require.serviceTier.trim() || undefined,
    localOnly: draftBoolean(draft.require.localOnly),
    remoteAllowed: draftBoolean(draft.require.remoteAllowed),
    encryptedCodexTasks: draftBoolean(draft.require.encryptedCodexTasks),
  });
  const maxEstimatedCostUsd = optionalNumber(draft.limits.maxEstimatedCostUsd);
  const compatibility = draft.compatibility.enabled
    ? compactRecord({
      requiredSuites: draft.compatibility.requiredSuites,
      minStatus: draft.compatibility.minStatus || undefined,
      maxEvidenceAgeMs: optionalNumber(draft.compatibility.maxEvidenceAgeMs),
      unknownEvidence: draft.compatibility.unknownEvidence,
      degradedEvidence: draft.compatibility.degradedEvidence,
    })
    : undefined;
  const onUnknownCost = draft.limits.onUnknownCost === "exclude" ? "exclude" as const : undefined;
  const limits = compactRecord({
    maxEstimatedCostUsd,
    onUnknownCost,
  });

  return {
    mode,
    id: draft.id.trim(),
    ...(mode === "update" && expectedRevision ? { expectedRevision } : {}),
    profile: {
      ...(draft.alias.trim() ? { alias: draft.alias.trim() } : {}),
      candidates: draft.candidates.map(candidate => ({
        provider: candidate.provider.trim(),
        model: candidate.model.trim(),
      })),
      ...(Object.keys(require).length > 0 ? { require } : {}),
      optimize: {
        latency: Number(draft.optimize.latency),
        health: Number(draft.optimize.health),
        cost: Number(draft.optimize.cost),
        quota: Number(draft.optimize.quota),
      },
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
      unknownEvidence: { ...draft.unknownEvidence },
      ...(compatibility && Object.keys(compatibility).length > 0 ? { compatibility } : {}),
    },
  };
}

export function routingProfileResponseError(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const error = (data as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return undefined;
}

export function routingProfileResponseSucceeded(data: unknown): boolean {
  return !!data && typeof data === "object" && !Array.isArray(data)
    && (data as { success?: unknown }).success === true;
}

export function modelOptionsForProvider(
  models: ModelOption[],
  provider: string,
): ModelOption[] {
  return models.filter(model => model.provider === provider);
}
