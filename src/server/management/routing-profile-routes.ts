/**
 * Routing-profile management API (RI-04).
 *
 * - `GET    /api/routing-profiles` - normalized profiles with revisions
 * - `PUT    /api/routing-profiles` - create or replace one validated profile
 * - `DELETE /api/routing-profiles?id=<id>` - remove one profile
 * - `POST   /api/routing-profiles/dry-run` - deterministic dry-run evaluation
 *   (never dispatches an upstream request)
 */

import {
  getRoutingProfile,
  listRoutingProfileIds,
  normalizeRoutingProfile,
  policyPublicModelId,
  routingProfileIssues,
} from "../../routing/profile";
import { evaluatePolicyProfile, type PolicyCandidateEvidence, type PolicyRequestEvidence } from "../../routing/evaluator";
import { assemblePolicyCandidateEvidence } from "../../routing/compatibility/assemble";
import { activateLab, labActivationRequired } from "../../lib/lab-activation";
import { quotaEvidenceForCandidate } from "../../routing/quota";
import { routedProviderConfig } from "../../router";
import { deleteConfigTopLevelKey, saveConfigPreservingClaudeCode, getConfigDir } from "../../config";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { isPlainRecord } from "./shared";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import type { OcxConfig, OcxRoutingProfileConfig } from "../../types";
import { shadowCallTargetError } from "./shadow-call-validation";

function profileDto(config: Parameters<typeof getRoutingProfile>[0], id: string): Record<string, unknown> | null {
  const profile = getRoutingProfile(config, id);
  if (!profile) return null;
  return {
    id,
    alias: profile.alias,
    model: policyPublicModelId(id, profile),
    revision: profile.revision,
    candidates: profile.candidates,
    require: profile.require,
    optimize: profile.optimize,
    limits: profile.limits,
    unknownEvidence: profile.unknownEvidence,
    ...(profile.compatibility ? { compatibility: profile.compatibility } : {}),
  };
}

function parseEvidence(raw: unknown): { evidence: PolicyRequestEvidence; ok: boolean } {
  // Absent evidence is empty evidence, mirroring the absent-candidates case.
  if (raw === undefined) return { evidence: {}, ok: true };
  if (!isPlainRecord(raw)) return { evidence: {}, ok: false };
  const record = raw as Record<string, unknown>;
  const evidence: PolicyRequestEvidence = {};
  if (typeof record.contextWindow === "number" && Number.isFinite(record.contextWindow) && record.contextWindow >= 0) {
    evidence.contextWindow = record.contextWindow;
  }
  for (const key of ["toolsRequired", "imageInputRequired", "structuredOutputRequired", "encryptedCodexTask"] as const) {
    if (typeof record[key] === "boolean") evidence[key] = record[key];
  }
  if (typeof record.reasoningEffort === "string") evidence.reasoningEffort = record.reasoningEffort;
  if (typeof record.serviceTier === "string") evidence.serviceTier = record.serviceTier;
  return { evidence, ok: true };
}

function parseCandidateEvidence(raw: unknown): PolicyCandidateEvidence[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PolicyCandidateEvidence[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) return null;
    const provider = item.provider;
    const model = item.model;
    if (typeof provider !== "string" || typeof model !== "string") return null;
    out.push({
      provider,
      model,
      ...(typeof item.accountRef === "string" ? { accountRef: item.accountRef } : {}),
      ...(typeof item.codexAccountId === "string" ? { codexAccountId: item.codexAccountId } : {}),
      // Dry-run evidence is caller-supplied and echoed back in the result as
      // given; the trace's candidate rows carry only score/exclusions, which
      // the trace builder bounds. Structural casts keep the API permissive.
      ...(isPlainRecord(item.capability) ? { capability: item.capability as unknown as PolicyCandidateEvidence["capability"] } : {}),
      ...(isPlainRecord(item.health) ? { health: item.health as unknown as PolicyCandidateEvidence["health"] } : {}),
      ...(isPlainRecord(item.quota) ? { quota: item.quota as unknown as PolicyCandidateEvidence["quota"] } : {}),
      ...(isPlainRecord(item.cost) ? { cost: item.cost as unknown as PolicyCandidateEvidence["cost"] } : {}),
      // Derive account-scoped quota evidence from the documented refs when the
      // caller does not supply an explicit quota object, so a dry-run following
      // the documented shape reports the same cached account quota as routing.
      ...(item.quota === undefined && typeof item.codexAccountId === "string"
        ? { quota: quotaEvidenceForCandidate({ provider, model, codexAccountId: item.codexAccountId }) }
        : {}),
      ...(item.quota === undefined && typeof item.accountRef === "string" && typeof item.codexAccountId !== "string"
        ? { quota: quotaEvidenceForCandidate({ provider, model, accountRef: item.accountRef }) }
        : {}),
    });
  }
  return out;
}

function assembleCandidateEvidence(
  config: OcxConfig,
  profile: NonNullable<ReturnType<typeof getRoutingProfile>>,
  now: number,
): PolicyCandidateEvidence[] {
  return assemblePolicyCandidateEvidence(config, profile, now, {
    routedProviderConfig,
  });
}

function storedProfile(
  id: string,
  raw: OcxRoutingProfileConfig,
): OcxRoutingProfileConfig {
  const normalized = normalizeRoutingProfile(id, raw);
  const {
    id: _id,
    revision: _revision,
    alias,
    ...profile
  } = normalized;
  return alias === null ? profile : { ...profile, alias };
}

/**
 * Rewrite config references from one public model id to another (alias change
 * on update). Mirrors the /api/combos migration: model-valued config that
 * still names the old alias must follow it, or requests fall through to
 * ordinary routing and send the obsolete alias upstream.
 */
/**
 * Detect a modelMap key collision that the alias migration would silently
 * resolve by dropping one mapping: the map already contains the new public
 * model as a key with a different target than the old-alias key's target.
 */
function modelMapMigrationCollision(
  config: OcxConfig,
  oldPublicModel: string,
  newPublicModel: string,
): string | null {
  const map = config.claudeCode?.modelMap;
  if (!map) return null;
  if (oldPublicModel === newPublicModel) return null;
  const oldTarget = map[oldPublicModel];
  if (oldTarget === undefined) return null;
  const newTarget = map[newPublicModel];
  if (newTarget === undefined) return null;
  if (oldTarget === newTarget) return null;
  return `modelMap already maps \"${newPublicModel}\" to \"${newTarget}\"; renaming \"${oldPublicModel}\" (→ \"${newTarget}\") would drop one mapping. Resolve the conflict and retry.`;
}

/**
 * Rewrite config references from one public model id to another (alias change
 * on update). Mirrors the /api/combos migration: model-valued config that
 * still names the old alias must follow it, or requests fall through to
 * ordinary routing and send the obsolete alias upstream.
 */
function migrateProfileModelReferences(
  config: OcxConfig,
  oldPublicModel: string,
  newPublicModel: string,
): boolean {
  if (oldPublicModel === newPublicModel) return false;
  const migrateReference = (model: string): string => (
    model === oldPublicModel ? newPublicModel : model
  );
  let shouldSyncClaudeAgentDefs = false;
  const migrateAgentReference = (model: string): string => {
    const migrated = migrateReference(model);
    if (migrated !== model) shouldSyncClaudeAgentDefs = true;
    return migrated;
  };
  const migrateReferences = (models: string[]): string[] => [
    ...new Set(models.map(migrateReference)),
  ];
  if (config.disabledModels) {
    config.disabledModels = migrateReferences(config.disabledModels);
  }
  if (config.subagentModels) {
    config.subagentModels = [...new Set(config.subagentModels.map(migrateAgentReference))];
  }
  if (config.subagentModelFallback) {
    config.subagentModelFallback = [...new Set(config.subagentModelFallback.map(migrateAgentReference))];
  }
  if (config.injectionModel && config.injectionModel === oldPublicModel) {
    config.injectionModel = newPublicModel;
  }
  if (config.shadowCallIntercept?.model && config.shadowCallIntercept.model === oldPublicModel) {
    config.shadowCallIntercept = { ...config.shadowCallIntercept, model: newPublicModel };
  }
  if (config.claudeCode) {
    const claudeCode = { ...config.claudeCode };
    for (const field of ["model", "smallFastModel"] as const) {
      if (claudeCode[field]) claudeCode[field] = migrateAgentReference(claudeCode[field]);
    }
    if (claudeCode.tierModels) {
      claudeCode.tierModels = Object.fromEntries(
        Object.entries(claudeCode.tierModels).map(([tier, model]) => [tier, migrateAgentReference(model)]),
      );
    }
    if (claudeCode.modelMap) {
      // Keys are the inbound ids matched for reroute (src/claude/inbound.ts);
      // an old-alias key must follow the rename or that request stops intercepting.
      claudeCode.modelMap = Object.fromEntries(
        Object.entries(claudeCode.modelMap).map(([source, model]) => [
          migrateAgentReference(source),
          migrateAgentReference(model),
        ]),
      );
    }
    config.claudeCode = claudeCode;
  }
  return shouldSyncClaudeAgentDefs;
}
export async function handleRoutingProfileRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, convergeCodexCatalog, syncClaudeAgentDefsBestEffort } = ctx;

  if (url.pathname === "/api/routing-profiles" && req.method === "GET") {
    const profiles = listRoutingProfileIds(config).map(id => profileDto(config, id)).filter(
      (profile): profile is Record<string, unknown> => profile !== null,
    );
    return jsonResponse({ profiles }, 200, req, config);
  }

  if (url.pathname === "/api/routing-profiles" && req.method === "PUT") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
    }
    if (!isPlainRecord(rawBody)) {
      return jsonResponse({ error: "request body must be an object" }, 400, req, config);
    }
    const body = rawBody as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      return jsonResponse({ error: { code: "missing_profile_id", message: "id is required" } }, 400, req, config);
    }
    const mode = body.mode === "create" || body.mode === "update" ? body.mode : null;
    if (!mode) {
      return jsonResponse({ error: { code: "invalid_profile_mode", message: "mode must be create or update" } }, 400, req, config);
    }
    const exists = Object.hasOwn(config.routingProfiles ?? {}, id);
    if (mode === "create" && exists) {
      return jsonResponse({ error: { code: "profile_exists", message: `routing profile already exists: ${id}` } }, 409, req, config);
    }
    if (mode === "update" && !exists) {
      return jsonResponse({ error: { code: "unknown_profile", message: `unknown routing profile: ${id}` } }, 404, req, config);
    }
    if (mode === "update") {
      const expectedRevision = typeof body.expectedRevision === "string" && body.expectedRevision.trim()
        ? body.expectedRevision.trim()
        : undefined;
      if (expectedRevision) {
        const current = getRoutingProfile(config, id);
        if (current && current.revision !== expectedRevision) {
          return jsonResponse({
            error: {
              code: "profile_revision_conflict",
              message: `routing profile ${id} changed since it was loaded; reload and retry`,
              currentRevision: current.revision,
            },
          }, 409, req, config);
        }
      }
    }
    const issues = routingProfileIssues(id, body.profile, config, { excludeProfileId: id });
    if (issues.length > 0) {
      return jsonResponse({
        error: {
          code: "invalid_profile",
          message: issues[0]!.message,
          issues,
        },
      }, 400, req, config);
    }

    const previousProfile = mode === "update" ? getRoutingProfile(config, id) : undefined;
    let aliasMigration: { oldPublicModel: string; newPublicModel: string } | undefined;
    if (mode === "update" && previousProfile) {
      const oldPublicModel = policyPublicModelId(id, previousProfile);
      const newProfile = normalizeRoutingProfile(id, body.profile as OcxRoutingProfileConfig);
      const newPublicModel = policyPublicModelId(id, newProfile);
      aliasMigration = { oldPublicModel, newPublicModel };
      const collision = modelMapMigrationCollision(config, oldPublicModel, newPublicModel);
      if (collision) {
        return jsonResponse({
          error: { code: "alias_reference_conflict", message: collision },
        }, 409, req, config);
      }
    }
    const nextProfiles = { ...(config.routingProfiles ?? {}) };
    nextProfiles[id] = storedProfile(id, body.profile as OcxRoutingProfileConfig);
    const currentShadowTarget = config.shadowCallIntercept?.model;
    if (aliasMigration && currentShadowTarget === aliasMigration.oldPublicModel) {
      const targetError = shadowCallTargetError(
        { ...config, routingProfiles: nextProfiles },
        aliasMigration.newPublicModel,
      );
      if (targetError) {
        return jsonResponse({
          error: { code: "invalid_shadow_call_target", message: targetError },
        }, 400, req, config);
      }
    }
    config.routingProfiles = nextProfiles;
    // Creating the first profile on a process started profile-less must install the
    // compatibility provider now; activation is synchronous and idempotent per configDir.
    if (labActivationRequired(config, getConfigDir())) activateLab(config, getConfigDir());
    // An alias change on update renames the public model id; rewrite config
    // references (disabledModels, subagentModels, injectionModel,
    // shadowCallIntercept, claudeCode) so they follow the new alias.
    let shouldSyncClaudeAgentDefs = false;
    if (previousProfile) {
      const oldPublicModel = policyPublicModelId(id, previousProfile);
      const newPublicModel = policyPublicModelId(id, getRoutingProfile(config, id)!);
      shouldSyncClaudeAgentDefs = migrateProfileModelReferences(config, oldPublicModel, newPublicModel);
    }
    const save = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;
    save(config);
    reconcileLiveStateStores();
    const catalogRefresh = await convergeCodexCatalog();
    if (shouldSyncClaudeAgentDefs) await syncClaudeAgentDefsBestEffort();
    const profile = profileDto(config, id)!;
    return jsonResponse({
      success: true,
      id,
      model: profile.model,
      profile,
      catalogRefresh,
    }, 200, req, config);
  }

  if (url.pathname === "/api/routing-profiles" && req.method === "DELETE") {
    const id = url.searchParams.get("id")?.trim();
    if (!id) {
      return jsonResponse({ error: "id query param is required" }, 400, req, config);
    }
    if (!Object.hasOwn(config.routingProfiles ?? {}, id)) {
      return jsonResponse({ error: "unknown routing profile" }, 404, req, config);
    }

    const nextProfiles = { ...(config.routingProfiles ?? {}) };
    delete nextProfiles[id];
    if (Object.keys(nextProfiles).length > 0) config.routingProfiles = nextProfiles;
    else deleteConfigTopLevelKey(config, "routingProfiles");
    const saveConfigPreservingClaudeCodeSafe = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;
    saveConfigPreservingClaudeCodeSafe(config);
    reconcileLiveStateStores();
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ success: true, id, catalogRefresh }, 200, req, config);
  }

  if (url.pathname === "/api/routing-profiles/dry-run" && req.method === "POST") {
    let rawBody: unknown;
    try { rawBody = await readManagementJsonBody(req); } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
    }
    if (!isPlainRecord(rawBody)) {
      return jsonResponse({ error: "request body must be an object" }, 400, req, config);
    }
    const body = rawBody as Record<string, unknown>;
    const profile = typeof body.profile === "string" ? body.profile.trim() : "";
    if (!profile) {
      return jsonResponse({ error: { code: "missing_profile", message: "profile is required" } }, 400, req, config);
    }
    const resolvedProfile = getRoutingProfile(config, profile);
    if (!resolvedProfile) {
      return jsonResponse({ error: { code: "unknown_profile", message: `unknown routing profile: ${profile}` } }, 404, req, config);
    }
    const { evidence, ok } = parseEvidence(body.evidence);
    if (!ok) {
      return jsonResponse({ error: { code: "invalid_evidence", message: "evidence must be an object" } }, 400, req, config);
    }
    // One clock read for both assembly and evaluation keeps freshness, health,
    // and trace timestamps mutually consistent with the production router.
    const now = Date.now();
    // R3-1: dry-run assembles candidate evidence independently of the startup gate, so an
    // operator preview on a process started without profiles would silently omit
    // compatibility evidence and disagree with production. Activate first.
    if (labActivationRequired(config, getConfigDir())) activateLab(config, getConfigDir());
    const candidateEvidence = body.candidates === undefined
      ? assembleCandidateEvidence(config, resolvedProfile, now)
      : parseCandidateEvidence(body.candidates);
    if (candidateEvidence === null) {
      return jsonResponse({ error: { code: "invalid_candidates", message: "candidates must be an array of evidence objects" } }, 400, req, config);
    }
    const result = evaluatePolicyProfile(config, profile, evidence, candidateEvidence, now);
    return jsonResponse(result, 200, req, config);
  }

  return null;
}
