import { AI_INTEGRATIONS_ENV_PREFIX } from "./constants";
import type { GatewayErrorCategory } from "./errors";

const REDACTED = "[REDACTED]";

export function containsAiIntegrationsSecret(value: string): boolean {
  return value.includes(AI_INTEGRATIONS_ENV_PREFIX);
}

export function redactGatewaySecrets(
  value: string,
  knownSecrets: readonly string[] = [],
): string {
  let result = value
    .replace(/AI_INTEGRATIONS_[A-Z0-9_]+=[^\s]+/g, `${AI_INTEGRATIONS_ENV_PREFIX}…=${REDACTED}`)
    .replace(
      /"AI_INTEGRATIONS_[A-Z0-9_]+"\s*:\s*"[^"]*"/g,
      `"${AI_INTEGRATIONS_ENV_PREFIX}…":"${REDACTED}"`,
    )
    .replace(/AI_INTEGRATIONS_[A-Z0-9_]+:\s*[^\s,}]+/g, `${AI_INTEGRATIONS_ENV_PREFIX}…: ${REDACTED}`)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/AI_INTEGRATIONS_[A-Z0-9_]+/g, `${AI_INTEGRATIONS_ENV_PREFIX}…`);

  for (const secret of knownSecrets) {
    if (secret.length > 0) {
      result = result.split(secret).join(REDACTED);
    }
  }
  return result;
}

export interface SafeLogInput {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  category?: GatewayErrorCategory;
}

export interface SafeLogRecord {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  category?: GatewayErrorCategory;
}

export function safeLogRecord(input: SafeLogInput): SafeLogRecord {
  return {
    requestId: input.requestId,
    method: input.method,
    path: input.path,
    status: input.status,
    durationMs: input.durationMs,
    ...(input.category ? { category: input.category } : {}),
  };
}

export function formatSafeLogLine(record: SafeLogRecord): string {
  const parts = [
    `requestId=${record.requestId}`,
    `method=${record.method}`,
    `path=${record.path}`,
    `status=${record.status}`,
    `durationMs=${record.durationMs}`,
  ];
  if (record.category) {
    parts.push(`category=${record.category}`);
  }
  return redactGatewaySecrets(parts.join(" "));
}
