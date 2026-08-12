import { readJsonIfOk } from "../../fetch-json";

/**
 * Kept in step with the server, which has accepted `codex` since the Codex
 * toggle shipped (`src/server/management/native-integration-routes.ts`).
 *
 * The GUI type lagged behind the call site that already passed `"codex"`, and
 * nothing caught it locally because GUI typecheck runs from its own tsconfig —
 * `bun x tsc --noEmit` at the repository root does not read this file. CI did.
 */
export type NativeIntegrationClientId = "claude" | "grok" | "codex" | "claude-desktop";
export type NativeIntegrationState = "absent" | "current" | "unsafe";
export type NativeRefusalReason =
  | "not_installed"
  | "orphaned_marker"
  | "home_mismatch"
  | "config_busy"
  | "write_failed"
  | "metadata_unreadable"
  | "cleanup_incomplete"
  | "desired_state_changed";

export interface NativeStatus {
  clientId: NativeIntegrationClientId;
  state: NativeIntegrationState;
  installed: boolean;
  configPath: string;
  desiredEnabled: boolean;
  disableBlocked: { reason: NativeRefusalReason; message: string } | null;
}

export interface NativeStatusListEnvelope {
  clients: NativeStatus[];
}

export interface NativeToggleEnvelope {
  ok: true;
  clientId: NativeIntegrationClientId;
  changed: boolean;
  state: NativeIntegrationState;
  message: string;
  desiredEnabled: boolean;
  reason?: string;
}

export interface NativeRefusalEnvelope {
  error: string;
  code: "native_integration_refused" | "native_integration_failed";
  clientId: NativeIntegrationClientId;
  reason: NativeRefusalReason;
  message: string;
  desiredEnabled?: boolean;
  residualPaths?: string[];
}

export interface NativeErrorEnvelope {
  error?: string;
  code?: string;
  clientId?: NativeIntegrationClientId;
  reason?: string;
  message?: string;
}

export type NativeErrorBody = NativeErrorEnvelope | NativeRefusalEnvelope;

// Widening the type alone would leave this guard rejecting a `codex` response at
// runtime, so the set moves with it.
const NATIVE_CLIENTS: ReadonlySet<string> = new Set<NativeIntegrationClientId>(["claude", "grok", "codex", "claude-desktop"]);
const NATIVE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "native_integration_refused",
  "native_integration_failed",
]);
const NATIVE_REFUSAL_REASONS: ReadonlySet<string> = new Set<NativeRefusalReason>([
  "not_installed",
  "orphaned_marker",
  "home_mismatch",
  "config_busy",
  "write_failed",
  "metadata_unreadable",
  "cleanup_incomplete",
  "desired_state_changed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Native refusals omit the file-writer state and use their own client/code vocabulary. */
export function isNativeRefusalEnvelope(body: unknown): body is NativeRefusalEnvelope {
  if (!isRecord(body)) return false;
  return typeof body.error === "string"
    && NATIVE_REFUSAL_CODES.has(String(body.code))
    && NATIVE_CLIENTS.has(String(body.clientId))
    && NATIVE_REFUSAL_REASONS.has(String(body.reason))
    && typeof body.message === "string";
}

export class NativeApiError extends Error {
  readonly refusal: NativeRefusalEnvelope | null;
  readonly status: number;
  readonly body: NativeErrorBody;

  constructor(status: number, body: NativeErrorBody) {
    const refusal = isNativeRefusalEnvelope(body) ? body : null;
    super(refusal?.message ?? body.error ?? body.message ?? String(status));
    this.name = "NativeApiError";
    this.status = status;
    this.body = body;
    this.refusal = refusal;
  }
}

async function readOptional<T>(request: Promise<Response>): Promise<T | null> {
  try {
    const response = await request;
    if (!response.ok) return null;
    return await readJsonIfOk<T>(response) ?? null;
  } catch {
    return null;
  }
}

async function readErrorBody(response: Response): Promise<NativeErrorEnvelope> {
  try {
    const body = await response.json() as unknown;
    return isRecord(body) ? body as NativeErrorEnvelope : {};
  } catch {
    return {};
  }
}

async function readToggleResponse(response: Response): Promise<NativeToggleEnvelope> {
  if (!response.ok) {
    throw new NativeApiError(response.status, await readErrorBody(response));
  }
  const body = await readJsonIfOk<NativeToggleEnvelope>(response);
  if (body == null) throw new NativeApiError(response.status, {});
  return body;
}

/** Status probes are optional overview evidence: one failed read must not take down the grid. */
export function loadNativeIntegrations(apiBase: string, signal?: AbortSignal) {
  return readOptional<NativeStatusListEnvelope>(
    fetch(`${apiBase}/api/native-integrations`, { signal }),
  );
}

export async function toggleNativeIntegration(
  apiBase: string,
  client: NativeIntegrationClientId,
  enabled: boolean,
  signal?: AbortSignal,
) {
  return readToggleResponse(
    await fetch(`${apiBase}/api/native-integrations/${encodeURIComponent(client)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
      signal,
    }),
  );
}
