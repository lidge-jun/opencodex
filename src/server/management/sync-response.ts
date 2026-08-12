/**
 * The single HTTP projection of ConvergeOutcome.
 *
 * Three phase documents once mapped /api/sync independently and one silently
 * dropped Retry-After. Keeping the exhaustive switch here makes a new domain
 * outcome a compile error until its management contract is chosen explicitly.
 */
import type { ConvergeOutcome } from "../../codex/convergence-types";
import { jsonResponse } from "../auth-cors";

export function toSyncResponse(outcome: ConvergeOutcome): Response {
  switch (outcome.kind) {
    case "catalog-only":
      return jsonResponse({
        ok: true,
        changed: outcome.changed,
        observed: outcome.observed,
        catalogRefresh: outcome.catalogRefresh,
        history: outcome.history,
      });
    case "converged":
      return jsonResponse({
        ok: true,
        changed: outcome.changed,
        observed: outcome.observed,
        catalogRefresh: outcome.catalogRefresh,
        history: outcome.history,
      });
    case "skipped":
      return jsonResponse({
        ok: true,
        changed: false,
        observed: outcome.observed,
        catalogRefresh: outcome.catalogRefresh,
        history: outcome.history,
      });
    case "refused":
      return jsonResponse({
        ok: false,
        authority: outcome.authority,
        message: outcome.message,
        observed: outcome.observed,
      }, 409);
    case "busy": {
      const response = jsonResponse({
        ok: false,
        surface: outcome.surface,
        retryAfterMs: outcome.retryAfterMs,
      }, 503);
      response.headers.set("Retry-After", String(Math.ceil(outcome.retryAfterMs / 1_000)));
      return response;
    }
    case "deferred":
      return jsonResponse({
        ok: true,
        changed: outcome.changed,
        unresolved: outcome.unresolved,
        observed: outcome.observed,
        catalogRefresh: outcome.catalogRefresh,
        history: outcome.history,
      });
    case "failed":
      return jsonResponse({ error: outcome.message, surface: outcome.surface }, 500);
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
