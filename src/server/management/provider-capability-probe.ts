/**
 * `POST /api/providers/probe-capabilities`: cheaply test what one model on one configured provider
 * accepts, by reusing the single-request completion diagnostic with a body variant (an image part,
 * or a reasoning effort). Probes run sequentially and never retry. Results carry codes and HTTP
 * statuses only, never upstream bodies. With `apply: true`, conclusive results are written back as
 * per-model declarations and labeled in `modelCapabilityProbes`.
 *
 * "Accepted" means the upstream did not refuse the request, not that it honored the field: a
 * gateway that silently ignores `reasoning_effort` reads as accepting every effort.
 */
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { PROVIDER_REGISTRY } from "../../providers/registry";
import { assessUrlDestination } from "../../lib/destination-policy";
import { canonicalizeReasoningEfforts, isDeclaredReasoningEffort } from "../../reasoning-effort";
import { isValidModelDiscoveryModelId } from "../../providers/model-discovery-limits";
import {
  mergeModelCapabilities, modelCapabilitiesConfigError, modelCapabilityProbesConfigError, pruneModelCapabilityProbes,
} from "../../config/provider-validation";
import { saveConfigPreservingClaudeCode } from "../../config";
import { ConfigWritePublishedError } from "../../config/persist-unlocked";
import { clearModelCache } from "../../codex/model-cache";
import { commitProviderPatch } from "./provider-patch-transaction";
import { effectiveModelReasoningEfforts } from "./model-rows";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { managementBodyTooLargeResponse, readManagementJsonBody } from "./body";
import {
  providerCompletionTestApplicability, runProviderCompletionTest,
  type ProviderCompletionTestDependencies, type ProviderCompletionTestResult,
} from "./provider-completion-test";

export const CAPABILITY_PROBE_MAX_EFFORTS = 6;
const DEFAULT_EFFORTS = ["low", "medium", "high"];
const BODY_KEYS = new Set(["name", "model", "checks", "efforts", "confirmMetered", "apply"]);
const LOCAL_DESTINATIONS = new Set(["localhost", "loopback", "private"]);
/** After one of these, every later probe would fail the same way; the rest are marked inconclusive. */
const STOP_STATUSES = new Set([401, 403, 429]);
const STOP_CODES = new Set(["credential_missing", "credential_changed", "destination_refused", "aborted"]);

type Check = "image" | "reasoning";
type ProbeError = { code: string; status?: number };
type Outcome = { status: "accepted" | "rejected" | "inconclusive"; error?: ProbeError; stop: boolean };
export type ProviderCapabilityProbeResult = {
  applicable: true; sent: true; metered: boolean; provider: string; model: string;
  /** Plain prompt sent first; unless accepted, every variant is inconclusive (a 400 is not about the variant). */
  baseline: { status: Outcome["status"]; error?: ProbeError };
  image?: { status: Outcome["status"]; error?: ProbeError };
  reasoning?: { accepted: string[]; rejected: string[]; inconclusive: string[] };
  applied?: { inputModalities?: string[]; reasoningEfforts?: string[] };
};

const invalid = (error = "invalid capability probe request") => jsonResponse({ error }, 400);

/** API-key auth to a non-local destination is billed per request; everything else is not. */
export function providerProbeIsMetered(name: string, row: OcxProviderConfig): boolean {
  const authKind = PROVIDER_REGISTRY.find(entry => entry.id === name)?.authKind;
  if ((row.authMode ?? authKind ?? "key") !== "key") return false;
  const kind = typeof row.baseUrl === "string" ? assessUrlDestination(row.baseUrl)?.kind : undefined;
  return kind === undefined || !LOCAL_DESTINATIONS.has(kind);
}

function defaultEfforts(config: OcxConfig, name: string, model: string): string[] {
  let known: string[] = [];
  try { known = canonicalizeReasoningEfforts((effectiveModelReasoningEfforts(config, name, model) ?? []).filter(isDeclaredReasoningEffort)); }
  catch { known = []; }
  if (known.length > CAPABILITY_PROBE_MAX_EFFORTS) known = known.filter(effort => effort !== "none" && effort !== "minimal");
  return known.length > 0 ? known.slice(0, CAPABILITY_PROBE_MAX_EFFORTS) : [...DEFAULT_EFFORTS];
}

/**
 * Completed means accepted; 400/422 means the upstream refused the variant. For the reasoning
 * check `no_content` is also accepted: with a 32-token cap a reasoning model can spend the whole
 * budget thinking and finish without a text delta, after the request itself was admitted.
 */
function classify(result: ProviderCompletionTestResult, check: Check): Outcome {
  if (!result.applicable) return { status: "inconclusive", error: { code: result.reason }, stop: true };
  if (result.ok || (check === "reasoning" && result.error?.code === "no_content")) return { status: "accepted", stop: false };
  const code = result.error?.code ?? "network";
  const status = result.error?.status;
  const error: ProbeError = { code, ...(status !== undefined ? { status } : {}) };
  if (code === "http_status" && (status === 400 || status === 422)) return { status: "rejected", error, stop: false };
  return { status: "inconclusive", error, stop: STOP_CODES.has(code) || (status !== undefined && STOP_STATUSES.has(status)) };
}

function parseBody(body: unknown, config: OcxConfig) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !BODY_KEYS.has(key))) return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.name !== "string" || typeof raw.model !== "string") return null;
  const model = raw.model.trim();
  if (!model || model.length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(raw.model)) return null;
  for (const flag of ["confirmMetered", "apply"] as const) if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") return null;
  let checks: Check[] = ["image", "reasoning"];
  if (raw.checks !== undefined) {
    if (!Array.isArray(raw.checks) || raw.checks.length === 0 || raw.checks.some(check => check !== "image" && check !== "reasoning")) return null;
    checks = (["image", "reasoning"] as const).filter(check => (raw.checks as unknown[]).includes(check));
  }
  let efforts: string[] | undefined;
  if (raw.efforts !== undefined) {
    if (!checks.includes("reasoning") || !Array.isArray(raw.efforts) || raw.efforts.length === 0
      || raw.efforts.some(effort => typeof effort !== "string" || !isDeclaredReasoningEffort(effort))) return null;
    efforts = canonicalizeReasoningEfforts(raw.efforts as string[]);
    if (efforts.length > CAPABILITY_PROBE_MAX_EFFORTS) return null;
  }
  const apply = raw.apply === true;
  // Applied results become per-model config keys, which have a stricter shape than a request model.
  if (apply && (!isValidModelDiscoveryModelId(model) || ["__proto__", "prototype", "constructor"].includes(model))) return null;
  const name = raw.name;
  return { name, model, checks, efforts, apply, confirmMetered: raw.confirmMetered === true, known: Object.hasOwn(config.providers, name) && !!config.providers[name] };
}

function writeBack(
  config: OcxConfig, name: string, model: string, applied: NonNullable<ProviderCapabilityProbeResult["applied"]>, probedAt: string,
): void {
  const live = config.providers[name];
  if (!live) throw new Error("provider removed during probe");
  const next: OcxProviderConfig = { ...live };
  const previous = live.modelCapabilityProbes && Object.hasOwn(live.modelCapabilityProbes, model) ? live.modelCapabilityProbes[model] : undefined;
  const label = { probedAt, ...(previous?.inputModalities ? { inputModalities: true as const } : {}),
    ...(previous?.reasoningEfforts ? { reasoningEfforts: true as const } : {}) };
  if (applied.inputModalities) {
    next.modelCapabilities = mergeModelCapabilities(next.modelCapabilities, { [model]: { inputModalities: applied.inputModalities } });
    label.inputModalities = true;
  }
  if (applied.reasoningEfforts) {
    next.modelReasoningEfforts = { ...(next.modelReasoningEfforts ?? {}), [model]: [...applied.reasoningEfforts] };
    // Same rule as PUT /api/model-settings: a stored default the new ladder cannot select is cleared.
    const storedDefault = next.modelDefaultReasoningEfforts?.[model];
    if (typeof storedDefault === "string" && !applied.reasoningEfforts.includes(storedDefault)) {
      const { [model]: _dropped, ...rest } = next.modelDefaultReasoningEfforts!;
      if (Object.keys(rest).length > 0) next.modelDefaultReasoningEfforts = rest;
      else delete next.modelDefaultReasoningEfforts;
    }
    label.reasoningEfforts = true;
  }
  next.modelCapabilityProbes = { ...(next.modelCapabilityProbes ?? {}), [model]: label };
  pruneModelCapabilityProbes(next);
  if (modelCapabilitiesConfigError(next.modelCapabilities) || modelCapabilityProbesConfigError(next.modelCapabilityProbes)) {
    throw new Error("probe results exceed the per-model declaration limits");
  }
  config.providers[name] = next;
}

const inFlight = new Set<string>();
export async function handleProviderCapabilityProbeRoute(
  ctx: Pick<ManagementContext, "req" | "config" | "deps" | "convergeCodexCatalog">,
  probeDeps: ProviderCompletionTestDependencies = {},
): Promise<Response> {
  const { req, config, deps } = ctx;
  let body: unknown;
  try { body = await readManagementJsonBody(req); } catch (error) {
    return managementBodyTooLargeResponse(error, req, config) ?? invalid();
  }
  const parsed = parseBody(body, config);
  if (!parsed) return invalid();
  if (!parsed.known) return jsonResponse({ error: "unknown provider" }, 404);
  const { name, model, checks, apply } = parsed;
  const blocked = providerCompletionTestApplicability(config, name, model);
  if (blocked) return jsonResponse({ ...blocked, sent: false, provider: name, model });
  const efforts = checks.includes("reasoning") ? parsed.efforts ?? defaultEfforts(config, name, model) : [];
  const plannedRequests = 1 + (checks.includes("image") ? 1 : 0) + efforts.length;
  const metered = providerProbeIsMetered(name, config.providers[name]!);
  if (metered && !parsed.confirmMetered) {
    return jsonResponse({ applicable: true, sent: false, requiresConfirmation: true, metered: true, plannedRequests });
  }
  if (inFlight.has(name)) return jsonResponse({ error: "capability probe already running for this provider" }, 409);
  inFlight.add(name);
  try {
    let stopped = false;
    const probe = async (check: Check, variant?: { image?: true; reasoningEffort?: string }) => {
      const outcome = classify(await runProviderCompletionTest({ config, name, model, signal: req.signal, ...(variant ? { variant } : {}) }, probeDeps), check);
      stopped = outcome.stop;
      return outcome;
    };
    const base = await probe("image");
    const result: ProviderCapabilityProbeResult = { applicable: true, sent: true, metered, provider: name, model,
      baseline: { status: base.status, ...(base.error ? { error: base.error } : {}) } };
    if (base.status !== "accepted") stopped = true;
    if (checks.includes("image")) {
      const { status, error } = stopped ? { status: "inconclusive" as const, error: undefined } : await probe("image", { image: true });
      result.image = { status, ...(error ? { error } : {}) };
    }
    if (checks.includes("reasoning")) {
      const reasoning = { accepted: [] as string[], rejected: [] as string[], inconclusive: [] as string[] };
      for (const effort of efforts) {
        if (stopped) { reasoning.inconclusive.push(effort); continue; }
        reasoning[(await probe("reasoning", { reasoningEffort: effort })).status].push(effort);
      }
      result.reasoning = reasoning;
    }
    if (!apply) return jsonResponse(result);

    const applied: NonNullable<ProviderCapabilityProbeResult["applied"]> = {};
    if (result.image?.status === "accepted") applied.inputModalities = ["text", "image"];
    else if (result.image?.status === "rejected") applied.inputModalities = ["text"];
    const reasoning = result.reasoning;
    if (reasoning && reasoning.inconclusive.length === 0 && reasoning.accepted.length + reasoning.rejected.length > 0) {
      applied.reasoningEfforts = canonicalizeReasoningEfforts(reasoning.accepted);
    }
    result.applied = applied;
    if (!applied.inputModalities && !applied.reasoningEfforts) return jsonResponse(result);
    let published = true;
    try {
      const probedAt = new Date().toISOString();
      commitProviderPatch(config, () => writeBack(config, name, model, applied, probedAt),
        deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode);
    } catch (error) {
      if (!(error instanceof ConfigWritePublishedError)) {
        delete result.applied;
        return jsonResponse({ ...result, error: "capability probe results could not be saved" }, 500);
      }
      published = false;
    }
    // Same order as PUT /api/model-settings: drop the cached rows the gather baked, then converge.
    clearModelCache(name);
    if (published) { try { await ctx.convergeCodexCatalog(); } catch { /* the saved config stays authoritative */ } }
    return jsonResponse(result);
  } finally {
    inFlight.delete(name);
  }
}
