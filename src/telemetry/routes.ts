import { mutatePersistedConfig } from "../config";
import { adoptPersistedTelemetry } from "../config/live-reconcile";
import { getConfigDir, withConfigDirHardeningSettled } from "../config/paths";
import { jsonResponse } from "../server/auth-cors";
import { hasHumanDashboardSession } from "../server/management/consent-session";
import type { ManagementContext } from "../server/management/context";
import type { OcxConfig, OcxTelemetryConfig, OcxTelemetryDecision } from "../types";
import { aggregateTelemetryForDay } from "./aggregate";
import { resolveTelemetryStatus, type TelemetryConsentStatus } from "./consent";
import type { TelemetryInstallChannel, TelemetryPayloadV1 } from "./contract";
import {
  TELEMETRY_PREVIEW_HASH_PLACEHOLDER,
  computeInstallDayHash,
  deleteTelemetryInstallId,
  readTelemetryInstallId,
} from "./install-id";
import { buildTelemetryPayloadV1, resolveInstallChannel } from "./payload";
import { latestCompletedUtcDay, nudgeTelemetryScheduler, readTelemetryState } from "./scheduler";

export interface TelemetryStatusSnapshot extends TelemetryConsentStatus {
  installChannel: TelemetryInstallChannel;
  lastSentDay: string | null;
  lastSentAt: string | null;
  preview: TelemetryPayloadV1;
}

export async function buildTelemetryStatusSnapshot(
  config: Pick<OcxConfig, "telemetry"> | null | undefined,
  options: { now?: number; env?: Record<string, string | undefined>; configDir?: string } = {},
): Promise<TelemetryStatusSnapshot> {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const configDir = options.configDir ?? getConfigDir();
  const status = resolveTelemetryStatus(config, env);
  const installChannel = resolveInstallChannel({ env });
  const state = readTelemetryState(configDir);
  const day = latestCompletedUtcDay(now);
  const aggregate = await aggregateTelemetryForDay(day);
  const identity = readTelemetryInstallId(configDir);
  const installDayHash = identity
    ? computeInstallDayHash(identity.installId, day)
    : TELEMETRY_PREVIEW_HASH_PLACEHOLDER;
  const newInstall = identity
    ? identity.firstReportSent !== true
    : true;
  const preview = buildTelemetryPayloadV1({
    aggregate,
    installDayHash,
    newInstall,
    installChannel,
    now,
  });
  return {
    ...status,
    installChannel,
    lastSentDay: state.lastSentDay,
    lastSentAt: state.lastSentAt,
    preview,
  };
}

function consentRefusedResponse(ctx: ManagementContext): Response {
  return jsonResponse(
    {
      ok: false,
      code: "agent_consent_required",
      error: "Telemetry consent requires a human dashboard session.",
      message:
        "Refused: this request carries no human dashboard session. Telemetry consent must be chosen by the user in the dashboard or an interactive terminal.",
    },
    403,
    ctx.req,
    ctx.config,
  );
}

export async function handleGetTelemetryRoute(ctx: ManagementContext): Promise<Response> {
  const snapshot = await buildTelemetryStatusSnapshot(ctx.config);
  return jsonResponse(snapshot, 200, ctx.req, ctx.config);
}

export async function handlePutTelemetryRoute(ctx: ManagementContext): Promise<Response> {
  if (!hasHumanDashboardSession(ctx)) {
    return consentRefusedResponse(ctx);
  }
  let body: unknown;
  try {
    body = await ctx.req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body", code: "invalid_json" }, 400, ctx.req, ctx.config);
  }
  const rawDecision = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { decision?: unknown }).decision
    : undefined;
  if (rawDecision !== "accepted" && rawDecision !== "declined") {
    return jsonResponse(
      { error: "decision must be \"accepted\" or \"declined\"", code: "invalid_decision" },
      400,
      ctx.req,
      ctx.config,
    );
  }
  const decision: OcxTelemetryDecision = rawDecision;
  const nowIso = new Date().toISOString();
  let committed: OcxTelemetryConfig | undefined;
  const outcome = await withConfigDirHardeningSettled(getConfigDir(), () =>
    mutatePersistedConfig(fresh => {
      const prev = fresh.telemetry;
      const next: OcxTelemetryConfig = {
        decision,
        decidedAt: nowIso,
        noticeShownAt: prev?.noticeShownAt ?? nowIso,
      };
      const changed = JSON.stringify(prev) !== JSON.stringify(next);
      fresh.telemetry = next;
      committed = structuredClone(next);
      return { changed, value: next };
    }),
  );
  if (outcome.status === "unavailable") {
    return jsonResponse(
      { error: `Configuration is ${outcome.reason}`, code: "config_unavailable" },
      503,
      ctx.req,
      ctx.config,
    );
  }
  adoptPersistedTelemetry(ctx.config, committed);
  if (decision === "declined") {
    deleteTelemetryInstallId();
  }
  nudgeTelemetryScheduler();
  const snapshot = await buildTelemetryStatusSnapshot(ctx.config);
  return jsonResponse({ ok: true, ...snapshot }, 200, ctx.req, ctx.config);
}

export async function handlePostTelemetryNoticeRoute(ctx: ManagementContext): Promise<Response> {
  if (!hasHumanDashboardSession(ctx)) {
    return consentRefusedResponse(ctx);
  }
  const nowIso = new Date().toISOString();
  let committed: OcxTelemetryConfig | undefined;
  const outcome = await withConfigDirHardeningSettled(getConfigDir(), () =>
    mutatePersistedConfig(fresh => {
      const prev = fresh.telemetry;
      if (prev?.noticeShownAt && !Number.isNaN(Date.parse(prev.noticeShownAt))) {
        committed = structuredClone(prev);
        return { changed: false, value: prev };
      }
      const next: OcxTelemetryConfig = {
        ...(prev?.decision ? { decision: prev.decision } : {}),
        ...(prev?.decidedAt ? { decidedAt: prev.decidedAt } : {}),
        noticeShownAt: nowIso,
      };
      fresh.telemetry = next;
      committed = structuredClone(next);
      return { changed: true, value: next };
    }),
  );
  if (outcome.status === "unavailable") {
    return jsonResponse(
      { error: `Configuration is ${outcome.reason}`, code: "config_unavailable" },
      503,
      ctx.req,
      ctx.config,
    );
  }
  adoptPersistedTelemetry(ctx.config, committed);
  nudgeTelemetryScheduler();
  const snapshot = await buildTelemetryStatusSnapshot(ctx.config);
  return jsonResponse({ ok: true, ...snapshot }, 200, ctx.req, ctx.config);
}
