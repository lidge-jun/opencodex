import { readJsonIfOk } from "../../fetch-json";

export const FILE_INTEGRATION_CLIENTS = [
  "opencode",
  "pi",
  "hermes",
  "openclaw",
  "kimi",
  "gajae",
] as const;

export type FileIntegrationClientId = (typeof FILE_INTEGRATION_CLIENTS)[number];
export type IntegrationClientId = FileIntegrationClientId;
export type IntegrationState = "absent" | "current" | "stale" | "conflict" | "unsafe";
export type IntegrationReason =
  | "unparseable"
  | "not-regular-file"
  | "foreign-edit"
  | "unowned-key"
  | "blocked-container";

export type IntegrationRefusalReason =
  | "not_installed"
  | "conflict"
  | "unsafe"
  | "non_loopback"
  | "drift_requires_confirm"
  | "snapshot_expired"
  | "write_failed";

export interface IntegrationStatus {
  clientId: FileIntegrationClientId;
  state: IntegrationState;
  installed: boolean;
  configPath: string;
  appliedAt?: string;
  lastOpId?: string;
  reason?: IntegrationReason;
  snapshotCount: number;
  retentionDegraded: boolean;
}

export interface IntegrationStateListEnvelope {
  clients: IntegrationStatus[];
}

export interface IntegrationJournalRow {
  opId: string;
  clientId: IntegrationClientId;
  kind: "apply" | "disable" | "refresh" | "restore";
  at: string;
  configPath: string;
  snapshot: "none" | "stored" | "expired";
  undoable: boolean;
}

export interface IntegrationJournalEnvelope {
  operations: IntegrationJournalRow[];
}

export interface IntegrationMutationResult {
  ok: true;
  clientId: FileIntegrationClientId;
  changed: boolean;
  state: IntegrationState;
  opId?: string;
  message: string;
}

export type IntegrationToggleResult = IntegrationMutationResult;
export type IntegrationRestoreResult = IntegrationMutationResult;
/** Kept as the shared name consumed by the page surfaces. */
export type IntegrationMutationEnvelope = IntegrationMutationResult;

export type IntegrationRefusalCode =
  | "integration_unsafe"
  | "integration_conflict"
  | "integration_drift_confirmation_required"
  | "integration_snapshot_expired"
  | "integration_mutation_failed";

export interface IntegrationRefusalEnvelope {
  error: string;
  code: IntegrationRefusalCode;
  clientId: FileIntegrationClientId;
  state: IntegrationState;
  reason: IntegrationRefusalReason;
  message: string;
  snapshotPath?: string;
  residual?: boolean;
}

export interface IntegrationErrorEnvelope {
  error?: string;
  code?: string;
  clientId?: FileIntegrationClientId;
  state?: string;
  reason?: string;
  message?: string;
  opId?: string;
  snapshotPath?: string;
  residual?: boolean;
  validClients?: readonly FileIntegrationClientId[];
  hint?: string;
}

export type IntegrationErrorBody = IntegrationErrorEnvelope | IntegrationRefusalEnvelope;

const REFUSAL_REASONS: ReadonlySet<string> = new Set<IntegrationRefusalReason>([
  "not_installed",
  "conflict",
  "unsafe",
  "non_loopback",
  "drift_requires_confirm",
  "snapshot_expired",
  "write_failed",
]);
const REFUSAL_CODES: ReadonlySet<string> = new Set<IntegrationRefusalCode>([
  "integration_unsafe",
  "integration_conflict",
  "integration_drift_confirmation_required",
  "integration_snapshot_expired",
  "integration_mutation_failed",
]);
const INTEGRATION_STATES: ReadonlySet<string> = new Set<IntegrationState>([
  "absent",
  "current",
  "stale",
  "conflict",
  "unsafe",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Writer refusals are identified by their canonical reason, never by state. */
export function isIntegrationRefusalEnvelope(body: unknown): body is IntegrationRefusalEnvelope {
  if (!isRecord(body) || !REFUSAL_REASONS.has(String(body.reason))) return false;
  return typeof body.error === "string"
    && REFUSAL_CODES.has(String(body.code))
    && FILE_INTEGRATION_CLIENTS.includes(body.clientId as FileIntegrationClientId)
    && INTEGRATION_STATES.has(String(body.state))
    && typeof body.message === "string";
}

export class IntegrationApiError extends Error {
  readonly refusal: IntegrationRefusalEnvelope | null;
  readonly status: number;
  readonly body: IntegrationErrorBody;

  // Parameter properties are erasable-syntax violations under the GUI's
  // stricter tsconfig, which the root typecheck does not enforce; the build
  // does. Assign them in the body instead.
  constructor(status: number, body: IntegrationErrorBody) {
    const refusal = isIntegrationRefusalEnvelope(body) ? body : null;
    super(refusal?.message ?? body.error ?? body.message ?? String(status));
    this.name = "IntegrationApiError";
    this.status = status;
    this.body = body;
    this.refusal = refusal;
  }
}

async function readErrorBody(response: Response): Promise<IntegrationErrorEnvelope> {
  try {
    const body = await response.json() as unknown;
    return isRecord(body) ? body as IntegrationErrorEnvelope : {};
  } catch {
    return {};
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new IntegrationApiError(response.status, await readErrorBody(response));
  }
  const body = await readJsonIfOk<T>(response);
  if (body == null) {
    throw new IntegrationApiError(response.status, {});
  }
  return body;
}

export async function loadIntegrationStates(apiBase: string, signal?: AbortSignal) {
  return readResponse<IntegrationStateListEnvelope>(
    await fetch(`${apiBase}/api/client-integrations`, { signal }),
  );
}

export async function loadIntegrationState(
  apiBase: string,
  client: FileIntegrationClientId,
  signal?: AbortSignal,
) {
  return readResponse<IntegrationStatus>(
    await fetch(`${apiBase}/api/client-integrations/${encodeURIComponent(client)}`, { signal }),
  );
}

export async function loadIntegrationJournal(
  apiBase: string,
  client?: FileIntegrationClientId,
  signal?: AbortSignal,
) {
  const query = client ? `?client=${encodeURIComponent(client)}` : "";
  return readResponse<IntegrationJournalEnvelope>(
    await fetch(`${apiBase}/api/client-integrations/journal${query}`, { signal }),
  );
}

export async function toggleIntegration(
  apiBase: string,
  client: FileIntegrationClientId,
  enabled: boolean,
  signal?: AbortSignal,
) {
  return readResponse<IntegrationToggleResult>(
    await fetch(`${apiBase}/api/client-integrations/${encodeURIComponent(client)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
      signal,
    }),
  );
}

export async function restoreIntegration(
  apiBase: string,
  opId: string,
  confirmDrift = false,
  signal?: AbortSignal,
) {
  return readResponse<IntegrationRestoreResult>(
    await fetch(`${apiBase}/api/client-integrations/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opId, confirmDrift }),
      signal,
    }),
  );
}
