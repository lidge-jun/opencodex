/**
 * Routing-profile management API (RI-04).
 *
 * - `GET  /api/routing-profiles` - normalized profiles with revisions
 * - `POST /api/routing-profiles/dry-run` - deterministic dry-run evaluation
 *   (never dispatches an upstream request)
 */

import { listRoutingProfileIds, getRoutingProfile, policyPublicModelId } from "../../routing/profile";
import { evaluatePolicyProfile, type PolicyCandidateEvidence, type PolicyRequestEvidence } from "../../routing/evaluator";
import { candidateCapabilityEvidence } from "../../routing/capability";
import { policyCandidateHealthEvidence } from "../../routing/health";
import { quotaEvidenceForCandidate } from "../../routing/quota";
import { providerCodexAccountMode } from "../../providers/registry";
import { getEffectiveActiveCodexAccountId } from "../../codex/routing";
import { getAccountSet } from "../../oauth/store";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { isPlainRecord } from "./shared";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

function profileDto(config: Parameters<typeof getRoutingProfile>[0], id: string): Record<string, unknown> | null {
  const profile = getRoutingProfile(config, id);
  if (!profile) return null;
  return {
    id,
    model: policyPublicModelId(id, profile),
    revision: profile.revision,
    candidates: profile.candidates,
    require: profile.require,
    optimize: profile.optimize,
    limits: profile.limits,
    unknownEvidence: profile.unknownEvidence,
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

export async function handleRoutingProfileRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/routing-profiles" && req.method === "GET") {
    const profiles = listRoutingProfileIds(config).map(id => profileDto(config, id)).filter(
      (profile): profile is Record<string, unknown> => profile !== null,
    );
    return jsonResponse({ profiles }, 200, req, config);
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
    const candidateEvidence = body.candidates === undefined
      // Match execution: fill the same candidate evidence the router would
      // assemble, so dry-run reports the same eligibility as real routing
      // instead of treating every capability as unknown.
      ? resolvedProfile.candidates.map(candidate => ({
          provider: candidate.provider,
          model: candidate.model,
          capability: candidateCapabilityEvidence(config, candidate.provider, candidate.model),
          health: policyCandidateHealthEvidence(config, candidate),
          quota: quotaEvidenceForCandidate({
            provider: candidate.provider,
            model: candidate.model,
            ...(candidate.provider === OPENAI_CODEX_PROVIDER_ID
              && providerCodexAccountMode(
                OPENAI_CODEX_PROVIDER_ID,
                config.providers[OPENAI_CODEX_PROVIDER_ID],
              ) === "pool"
              ? (() => {
                  const codexAccountId = getEffectiveActiveCodexAccountId(config);
                  return {
                    codexAccountId,
                    codexAccountPlan: codexAccountId
                      ? config.codexAccounts?.find(account => account.id === codexAccountId)?.plan
                      : undefined,
                  };
                })()
              : {}),
            accountRef: candidate.provider === "anthropic"
              ? getAccountSet("anthropic")?.activeAccountId
              : undefined,
          }),
        }))
      : parseCandidateEvidence(body.candidates);
    if (candidateEvidence === null) {
      return jsonResponse({ error: { code: "invalid_candidates", message: "candidates must be an array of evidence objects" } }, 400, req, config);
    }
    const result = evaluatePolicyProfile(config, profile, evidence, candidateEvidence);
    return jsonResponse(result, 200, req, config);
  }

  return null;
}
