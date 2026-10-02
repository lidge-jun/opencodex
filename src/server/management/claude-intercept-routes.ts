import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";
import { claudeInterceptEnabled, getClaudeInterceptState, type ClaudeInterceptOutcome } from "../../claude/intercept/runtime";

/** Local management authority only; data-plane credentials never grant this capability. */
export function interceptStartRefusal(ctx: ManagementContext): Response | null {
  return ctx.trustedLoopbackIngress && (ctx.principal === "gui-session" || ctx.principal === "admin-token")
    ? null : jsonResponse({ ok: false, code: "intercept_start_forbidden", error: "Local management authority is required." }, 403);
}

export async function ensureManagementClaudeIntercept(ctx: ManagementContext): Promise<ClaudeInterceptOutcome> {
  if (ctx.config.runtimeRole === "client") return { ok: false, reason: "client_role" };
  if (!claudeInterceptEnabled(ctx.config)) return { ok: false, reason: "disabled" };
  if (ctx.deps.ensureClaudeIntercept) return ctx.deps.ensureClaudeIntercept();
  const injected = ctx.deps.getClaudeInterceptState?.();
  if (injected) return { ok: true, state: injected };
  const listener = ctx.deps.linkListener?.();
  if (listener?.ensureClaudeIntercept) return listener.ensureClaudeIntercept();
  const state = (ctx.deps.getClaudeInterceptState ?? getClaudeInterceptState)();
  return state ? { ok: true, state } : { ok: false, reason: "failed" };
}

export function interceptStatus(ctx: ManagementContext): { interceptReason: string | null; pickerReason: string | null; pickerFailurePort?: number; interceptFailurePort?: number } {
  const outcome = ctx.deps.linkListener?.()?.claudeInterceptOutcome?.();
  const state = (ctx.deps.getClaudeInterceptState ?? getClaudeInterceptState)();
  return { ...(outcome && !outcome.ok ? { interceptFailurePort: outcome.port } : {}), interceptReason: outcome && !outcome.ok ? outcome.reason : null, pickerReason: state?.pickerReason ?? null, pickerFailurePort: state?.pickerFailurePort };
}

export async function handleClaudeInterceptRoutes(ctx: ManagementContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/api/claude-intercept/start" || ctx.req.method !== "POST") return null;
  const refusal = interceptStartRefusal(ctx);
  if (refusal) return refusal;
  const outcome = await ensureManagementClaudeIntercept(ctx);
  return jsonResponse(outcome, outcome.ok ? 200 : 409);
}
