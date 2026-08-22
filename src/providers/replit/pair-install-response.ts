import {
  REPLIT_ANTHROPIC_PROVIDER_ID,
  REPLIT_OPENAI_PROVIDER_ID,
  REPLIT_PROVIDER_PAIR_IDS,
} from "./constants";

export interface ReplitPairInstallProbeSuccess {
  ok: true;
  healthz: { status: number; latencyMs: number };
  models: { status: number; modelCount: number; latencyMs: number };
}

export interface ReplitPairInstallSuccessResponse {
  success: true;
  providers: [typeof REPLIT_OPENAI_PROVIDER_ID, typeof REPLIT_ANTHROPIC_PROVIDER_ID];
  probe: ReplitPairInstallProbeSuccess;
  defaultProvider?: typeof REPLIT_OPENAI_PROVIDER_ID;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function parseProbe(value: unknown): ReplitPairInstallProbeSuccess | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok !== true) return null;
  if (!record.healthz || typeof record.healthz !== "object" || Array.isArray(record.healthz)) return null;
  if (!record.models || typeof record.models !== "object" || Array.isArray(record.models)) return null;
  const healthz = record.healthz as Record<string, unknown>;
  const models = record.models as Record<string, unknown>;
  if (!isHttpStatus(healthz.status) || !isFiniteNonNegativeNumber(healthz.latencyMs)) return null;
  if (!isHttpStatus(models.status) || !isFiniteNonNegativeNumber(models.latencyMs)) return null;
  if (typeof models.modelCount !== "number" || !Number.isInteger(models.modelCount) || models.modelCount < 0) {
    return null;
  }
  return {
    ok: true,
    healthz: { status: healthz.status, latencyMs: healthz.latencyMs },
    models: { status: models.status, modelCount: models.modelCount, latencyMs: models.latencyMs },
  };
}

export function parseReplitPairInstallSuccess(body: unknown): ReplitPairInstallSuccessResponse | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record.success !== true) return null;
  if (!Array.isArray(record.providers) || record.providers.length !== REPLIT_PROVIDER_PAIR_IDS.length) return null;
  for (let index = 0; index < REPLIT_PROVIDER_PAIR_IDS.length; index++) {
    if (record.providers[index] !== REPLIT_PROVIDER_PAIR_IDS[index]) return null;
  }
  const probe = parseProbe(record.probe);
  if (!probe) return null;
  if (
    record.defaultProvider !== undefined
    && record.defaultProvider !== REPLIT_OPENAI_PROVIDER_ID
  ) {
    return null;
  }
  return {
    success: true,
    providers: [REPLIT_OPENAI_PROVIDER_ID, REPLIT_ANTHROPIC_PROVIDER_ID],
    probe,
    ...(record.defaultProvider === REPLIT_OPENAI_PROVIDER_ID
      ? { defaultProvider: REPLIT_OPENAI_PROVIDER_ID }
      : {}),
  };
}
