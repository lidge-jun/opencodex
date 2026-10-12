import { jsonResponse } from "../auth-cors";
import { jevDecisionEndpointUrl } from "../../combos/jev-decision-contract";
import type { ManagementContext } from "./context";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { isPlainRecord } from "./shared";
import { systemOneEndpoint, uniqueDiscoveryCandidates, type DiscoveryModelRow } from "./decision-discovery";

const PROBE_TASK = "Verify the configured decision method with a two-option probe.";
const PROBE_CANDIDATE = {
  key: "probe/decision",
  provider: "probe",
  model: "decision",
  reasoningEfforts: ["low", "high"],
} as const;
const MAX_DECISION_MODEL_CHARS = 512;

function optionalString(body: Record<string, unknown>, key: string): string | null | undefined | false {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

type DecisionRow = import("../../types").OcxProviderConfig;

/** Why a decision-service row cannot answer, shared by discovery and the probe. */
function decisionServiceIssue(
  id: string,
  provider: DecisionRow,
  isSystemOneEndpoint: (url: string) => boolean,
): { url: string; model: string; issue?: "disabled" | "endpoint" | "model" } {
  const url = typeof provider.baseUrl === "string" ? jevDecisionEndpointUrl(provider.baseUrl) : "";
  const model = provider.defaultModel?.trim() || provider.models?.[0]?.trim() || "";
  const issue = provider.disabled === true
    ? "disabled"
    : id === "jev"
      ? undefined
      : !isSystemOneEndpoint(url)
        ? "endpoint"
        : !model ? "model" : undefined;
  return { url, model, ...(issue ? { issue } : {}) };
}

/**
 * Decision-method management surfaces for JEV combos.
 *
 * - POST /api/combos/decision-test runs one bounded decision with a synthetic two-option probe
 *   through the same backend a combo would use, saved or not. It may spend a decision call.
 * - GET /api/combos/decision-discovery lists configured System One rows and catalog models whose
 *   names look like decision services, with the System One endpoint their provider would serve.
 *   Nothing is probed and nothing is written.
 *
 * The probe selects its method only from the body's `decisionProvider` / `decisionModel`; none
 * means TypeSafe. `comboId` names the combo for the recursion rules and never loads its saved
 * method, because the dashboard probes an unsaved TypeSafe draft by sending `comboId` alone.
 * `ocx combo test --combo` resolves the saved method on the client before calling this.
 */
export async function handleDecisionRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/combos/decision-test" && req.method === "POST") {
    let rawBody: unknown;
    try { rawBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(rawBody)) return jsonResponse({ error: "request body must be an object" }, 400);
    const decisionProvider = optionalString(rawBody, "decisionProvider");
    const decisionModel = optionalString(rawBody, "decisionModel");
    const comboId = optionalString(rawBody, "comboId");
    if (decisionProvider === false || decisionModel === false || comboId === false) {
      return jsonResponse({ error: "decisionProvider, decisionModel and comboId must be strings" }, 400);
    }
    if (decisionProvider && decisionModel) {
      return jsonResponse({ error: "choose either decisionProvider or decisionModel, not both" }, 400);
    }
    const timeout = rawBody.decisionTimeoutMs;
    const { JEV_DECISION_TIMEOUT_MAX_MS, JEV_DECISION_TIMEOUT_MIN_MS } = await import("../../combos/types");
    if (timeout !== undefined && timeout !== null && (typeof timeout !== "number" || !Number.isInteger(timeout)
      || timeout < JEV_DECISION_TIMEOUT_MIN_MS || timeout > JEV_DECISION_TIMEOUT_MAX_MS)) {
      return jsonResponse({
        error: `decisionTimeoutMs must be an integer from ${JEV_DECISION_TIMEOUT_MIN_MS} to ${JEV_DECISION_TIMEOUT_MAX_MS}`,
      }, 400);
    }
    if (decisionProvider && decisionProvider !== "jev") {
      const row = Object.hasOwn(config.providers, decisionProvider) ? config.providers[decisionProvider] : undefined;
      if (row?.adapter !== "jev-decision") {
        return jsonResponse({ error: `decisionProvider "${decisionProvider}" is not a configured decision service` }, 400);
      }
      // Match the combo PUT: a disabled or model-less row is refused by name, not probed into a
      // generic fail-open gate.
      const { isSystemOneEndpoint } = await import("../../combos/types");
      const { issue } = decisionServiceIssue(decisionProvider, row, isSystemOneEndpoint);
      if (issue) {
        return jsonResponse({ error: `decisionProvider "${decisionProvider}" is not usable (${issue})`, issue }, 400);
      }
    }
    if (decisionModel) {
      if (decisionModel.length > MAX_DECISION_MODEL_CHARS) {
        return jsonResponse({ error: "decisionModel is too long" }, 400);
      }
      const { decisionModelRouteError } = await import("./decision-model-validation");
      const routeError = decisionModelRouteError(config, comboId || undefined, decisionModel);
      if (routeError) return jsonResponse({ error: routeError }, 400);
    }
    const { resolveJevComboDecision } = await import("../../combos/jev-dispatch");
    let invokeModel: import("../../combos/jev-model-backend").JevModelInvoke | undefined;
    if (decisionModel) {
      const [{ createJevModelInvoker }, { handleResponses }] = await Promise.all([
        import("../responses/jev-model-invoke"),
        import("../responses/core"),
      ]);
      invokeModel = createJevModelInvoker({
        req: new Request("http://localhost/api/combos/decision-test"),
        config,
        options: {},
        handleResponses,
      });
    }
    const fallback = { targetKey: PROBE_CANDIDATE.key, effort: null };
    const decision = await resolveJevComboDecision({
      body: { input: PROBE_TASK },
      candidates: [{ ...PROBE_CANDIDATE, reasoningEfforts: [...PROBE_CANDIDATE.reasoningEfforts] }],
      fallback,
      config,
      ...(decisionProvider ? { decisionProvider } : {}),
      ...(decisionModel && invokeModel ? { decisionModel, invokeModel } : {}),
      ...(typeof timeout === "number" ? { timeoutMs: timeout } : {}),
      signal: req.signal,
    });
    return jsonResponse({
      ok: decision.gate === "apply",
      backend: decision.backend,
      gate: decision.gate,
      latencyMs: decision.latencyMs,
      ...(decision.gate === "apply" && decision.effort ? { effort: decision.effort } : {}),
    });
  }

  if (url.pathname === "/api/combos/decision-discovery" && req.method === "GET") {
    const query = (url.searchParams.get("q") ?? "").slice(0, 128);
    const { isSystemOneEndpoint } = await import("../../combos/types");
    const configured = Object.entries(config.providers)
      .filter(([, provider]) => provider.adapter === "jev-decision")
      .map(([id, provider]) => {
        const { url, model, issue } = decisionServiceIssue(id, provider, isSystemOneEndpoint);
        return { id, url, ...(model ? { model } : {}), usable: issue === undefined, ...(issue ? { issue } : {}) };
      });
    const { listManagementModelRows } = await import("./model-rows");
    const rows = (await listManagementModelRows(config)) as unknown as DiscoveryModelRow[];
    const discovered = uniqueDiscoveryCandidates(rows, query)
      .flatMap(row => {
        const provider = config.providers[row.provider!];
        if (!provider || provider.disabled === true || provider.adapter === "jev-decision") return [];
        const endpoint = systemOneEndpoint(provider.baseUrl);
        return endpoint ? [{ provider: row.provider!, model: row.id, endpoint }] : [];
      })
      .slice(0, 50);
    return jsonResponse({ configured, discovered });
  }

  return null;
}
