import { readJsonIfOk } from "../../fetch-json";

export const FILE_INTEGRATION_CLIENTS = [
  "opencode",
  "pi",
  "omp",
  "hermes",
  "openclaw",
  "kimi",
  "gajae",
  "dsh",
  "mcode",
  "zcode",
  "prime",
] as const;

export type FileIntegrationClientId = (typeof FILE_INTEGRATION_CLIENTS)[number];
export type IntegrationClientId = FileIntegrationClientId;
export type IntegrationState = "absent" | "current" | "stale" | "conflict" | "unsafe";
export type IntegrationReason =
  | "unparseable"
  | "not-regular-file"
  | "foreign-edit"
  | "unowned-key"
  | "blocked-container"
  | "unresolvable-path";

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

/*
 * Overview-only readers for the five surfaces that are not file clients.
 *
 * These deliberately do NOT throw and do NOT go through `readResponse`. A file
 * client's failure carries a refusal envelope with a snapshot path and a
 * recovery message the user needs; these five are read-only status probes, and
 * the only thing the overview can say about a failed one is "unknown". Turning
 * that into a thrown error would take down the whole grid for one slow route.
 *
 * Each returns only the fields the overview maps. `/api/claude-code` answers
 * ~36 KB including every context window and alias; reading two of its fields
 * and discarding the rest keeps this surface off a shape it does not own.
 */

async function readOptional<T>(request: Promise<Response>): Promise<T | null> {
  try {
    const response = await request;
    if (!response.ok) return null;
    return await readJsonIfOk<T>(response) ?? null;
  } catch {
    return null;
  }
}

export async function loadCodexRoutingStatus(apiBase: string, signal?: AbortSignal) {
  const body = await readOptional<{
    desiredEnabled?: unknown;
    installed?: unknown;
    observedKind?: unknown;
    routingInjected?: unknown;
    status?: unknown;
    recommendedCommand?: unknown;
  }>(fetch(`${apiBase}/api/startup-health`, { signal }));
  if (!body) return null;
  return {
    routingInjected: body.routingInjected === true,
    status: typeof body.status === "string" ? body.status : undefined,
    recommendedCommand: typeof body.recommendedCommand === "string" ? body.recommendedCommand : null,
  };
}

/**
 * Throws on a failed or malformed read rather than returning null.
 *
 * `readOptional` is right for surfaces that treat "no answer" and "empty" the
 * same. This one cannot: the overview says "Checking…" while a read is in
 * flight and "Key status unavailable" once it has settled badly, and a
 * successfully-returned null collapses both into `ready-empty` with no polling
 * to ever correct it — so the row would claim the user has no keys because a
 * request failed. Throwing is what produces `failed-cold` / `failed-with-stale`,
 * which is the signal the row reads. Aborts never reach a state: an aborted
 * generation is discarded before either data or failure is published.
 */
export async function loadApiKeyCount(apiBase: string, signal?: AbortSignal): Promise<number> {
  const response = await fetch(`${apiBase}/api/keys`, { signal });
  // These two strings are diagnostics for the failure path, never rendered:
  // the row shows the localized `integrations.detail.keyUnavailable` instead.
  // eslint-disable-next-line local-i18n/no-hardcoded-ui-strings -- rejection reason, not UI text
  if (!response.ok) throw new Error(`/api/keys responded ${response.status}`);
  const body = await readJsonIfOk<{ keys?: unknown }>(response);
  if (!body || !Array.isArray(body.keys)) throw new Error("/api/keys returned an unexpected body");
  return body.keys.length;
}

export async function loadClaudeCodeStatus(apiBase: string, signal?: AbortSignal) {
  const body = await readOptional<{ enabled?: unknown; authMode?: unknown }>(
    fetch(`${apiBase}/api/claude-code`, { signal }),
  );
  if (!body) return null;
  return {
    enabled: body.enabled === true,
    authMode: typeof body.authMode === "string" ? body.authMode : undefined,
  };
}

export async function loadClaudeDesktopStatus(apiBase: string, signal?: AbortSignal) {
  const body = await readOptional<{
    applied?: unknown;
    stale?: unknown;
    drift?: unknown;
    driftReason?: unknown;
    activeProfile?: unknown;
    appliedAt?: unknown;
    desiredEnabled?: unknown;
    installed?: unknown;
    observedKind?: unknown;
  }>(fetch(`${apiBase}/api/claude-desktop/status`, { signal }));
  if (!body || typeof body.desiredEnabled !== "boolean" || typeof body.installed !== "boolean" || typeof body.observedKind !== "string") return null;
  return {
    desiredEnabled: body.desiredEnabled,
    installed: body.installed,
    observedKind: body.observedKind,
    applied: body.applied === true,
    stale: body.stale === true,
    drift: body.drift === true,
    driftReason: typeof body.driftReason === "string" ? body.driftReason : null,
    // Tri-state on purpose: `null` means undeterminable, which must not be
    // read as "Desktop is serving someone else's profile".
    activeProfile: typeof body.activeProfile === "boolean" ? body.activeProfile : null,
    appliedAt: typeof body.appliedAt === "string" ? body.appliedAt : null,
  };
}

export async function loadGrokFenceStatus(apiBase: string, signal?: AbortSignal) {
  const body = await readOptional<{ present?: unknown; models?: unknown }>(
    fetch(`${apiBase}/api/grok`, { signal }),
  );
  if (!body) return null;
  return {
    present: body.present === true,
    models: Array.isArray(body.models) ? body.models : [],
  };
}
