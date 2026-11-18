import { mutatePersistedConfig } from "../config";
import { readConfigDiagnostics } from "../config/diagnostics";
import { adoptPersistedTelemetry } from "../config/live-reconcile";
import { getConfigDir, withConfigDirHardeningSettled } from "../config/paths";
import { jsonResponse } from "../server/auth-cors";
import { hasHumanDashboardSession } from "../server/management/consent-session";
import type { ManagementContext } from "../server/management/context";
import type { OcxConfig, OcxTelemetryConfig, OcxTelemetryDecision } from "../types";
import { aggregateTelemetryForDay, type DailyTelemetryAggregate } from "./aggregate";
import { resolveTelemetryStatus, type TelemetryConsentStatus } from "./consent";
import type { TelemetryInstallChannel, TelemetryPayloadV1 } from "./contract";
import {
  TELEMETRY_PREVIEW_HASH_PLACEHOLDER,
  computeInstallDayHash,
  deleteTelemetryInstallId,
  readTelemetryInstallId,
} from "./install-id";
import { buildTelemetryPayloadV1, resolveInstallChannel } from "./payload";
import {
  clearPendingTelemetryDecision,
  latestCompletedUtcDay,
  nudgeTelemetryScheduler,
  readTelemetryState,
  readTelemetryStateFile,
  recordPendingTelemetryDecision,
  resolveNextEligibleTelemetryDay,
  withPendingTelemetryDecision,
} from "./scheduler";

export interface TelemetryStatusSnapshot extends TelemetryConsentStatus {
  installChannel: TelemetryInstallChannel;
  lastSentDay: string | null;
  lastSentAt: string | null;
  previewEligible: boolean;
  preview: TelemetryPayloadV1;
  /** Present when telemetry-state.json exists but cannot be read: every send is refused until it can. */
  stateUnreadable?: true;
}

/** How long the dashboard's preview may reuse a completed day's aggregate (the panel polls). */
export const TELEMETRY_PREVIEW_CACHE_MS = 10 * 60 * 1000;
let previewAggregateCache: { configDir: string; day: string; at: number; aggregate: DailyTelemetryAggregate } | null = null;

export function resetTelemetryPreviewCacheForTests(): void {
  previewAggregateCache = null;
}

async function previewAggregate(day: string, configDir: string, now: number, cache: boolean): Promise<DailyTelemetryAggregate> {
  const hit = previewAggregateCache;
  if (cache && hit && hit.configDir === configDir && hit.day === day && now - hit.at >= 0 && now - hit.at < TELEMETRY_PREVIEW_CACHE_MS) {
    return hit.aggregate;
  }
  // A completed day's aggregate scans usage.jsonl from the start; the dashboard polls this route.
  const aggregate = await aggregateTelemetryForDay(day);
  if (cache) previewAggregateCache = { configDir, day, at: now, aggregate };
  return aggregate;
}

export async function buildTelemetryStatusSnapshot(
  config: Pick<OcxConfig, "telemetry"> | null | undefined,
  options: { now?: number; env?: Record<string, string | undefined>; configDir?: string; cachePreview?: boolean } = {},
): Promise<TelemetryStatusSnapshot> {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const configDir = options.configDir ?? getConfigDir();
  const status = resolveTelemetryStatus(withPendingTelemetryDecision(config, configDir), env);
  const installChannel = resolveInstallChannel({ env });
  const stateFile = readTelemetryStateFile(configDir);
  const state = stateFile.state;
  // An unreadable state file blocks every send (state-unreadable), so nothing is eligible to preview.
  const { day: nextEligibleDay } = stateFile.unreadable
    ? { day: null }
    : resolveNextEligibleTelemetryDay(status, state, now);
  const previewEligible = nextEligibleDay !== null;
  const day = nextEligibleDay ?? latestCompletedUtcDay(now);
  const aggregate = await previewAggregate(day, configDir, now, options.cachePreview === true);
  const identity = readTelemetryInstallId(configDir);
  const installDayHash = identity
    ? computeInstallDayHash(identity.installId, day)
    : TELEMETRY_PREVIEW_HASH_PLACEHOLDER;
  const newInstall = state.everReported !== true && identity?.firstReportSent !== true;
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
    previewEligible,
    preview,
    ...(stateFile.unreadable ? { stateUnreadable: true as const } : {}),
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
  // Consent is read from disk, like the scheduler: a CLI decision while the proxy runs must show here.
  const snapshot = await buildTelemetryStatusSnapshot(readConfigDiagnostics({ passive: true }).config, { cachePreview: true });
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
  if (outcome.status === "unavailable" && outcome.reason === "missing") {
    // A fresh install's first-run popup can answer before any config.json exists; hold the
    // decision so creating a config here does not make `ocx init` skip setup.
    committed = { decision, decidedAt: nowIso, noticeShownAt: nowIso };
    recordPendingTelemetryDecision(committed);
  } else if (outcome.status === "unavailable") {
    return jsonResponse(
      { error: `Configuration is ${outcome.reason}`, code: "config_unavailable" },
      503,
      ctx.req,
      ctx.config,
    );
  } else {
    clearPendingTelemetryDecision();
  }
  // A decision held before config.json exists stays out of the running config: a later write that
  // creates config.json from it must not carry a decision another process may since have replaced.
  adoptPersistedTelemetry(ctx.config, outcome.status === "unavailable" ? undefined : committed);
  if (decision === "declined") {
    deleteTelemetryInstallId();
  }
  nudgeTelemetryScheduler();
  const snapshot = await buildTelemetryStatusSnapshot(ctx.config);
  return jsonResponse({ ok: true, ...snapshot }, 200, ctx.req, ctx.config);
}
