import { createBoundedFetch } from "./bounded-fetch";

/** Wire shape of GET/PUT /api/telemetry. */
export type TelemetryDecision = "accepted" | "declined";
export type TelemetryStatusReason =
  | "env-ocx-telemetry"
  | "env-do-not-track"
  | "declined"
  | "accepted"
  | "default-on"
  | "awaiting-notice";
export type TelemetryEnvOverride = "OCX_TELEMETRY" | "DO_NOT_TRACK" | null;

export interface TelemetryStatusSnapshot {
  effective: boolean;
  reason: TelemetryStatusReason;
  decision: TelemetryDecision | null;
  decidedAt: string | null;
  noticeShownAt: string | null;
  envOverride: TelemetryEnvOverride;
  installChannel: string;
  lastSentDay: string | null;
  lastSentAt: string | null;
  preview: Record<string, unknown>;
  previewEligible?: boolean;
}

export const TELEMETRY_TIMEOUT_MS = 15_000;
export const TELEMETRY_STATUS_CHANGED_EVENT = "ocx:telemetry-status-changed";

const VALID_REASONS: ReadonlySet<string> = new Set([
  "env-ocx-telemetry",
  "env-do-not-track",
  "declined",
  "accepted",
  "default-on",
  "awaiting-notice",
]);

export function parseTelemetryStatus(value: unknown): TelemetryStatusSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.effective !== "boolean") return null;
  const decision: TelemetryDecision | null =
    raw.decision === "accepted" || raw.decision === "declined" ? raw.decision : null;
  const reason: TelemetryStatusReason =
    typeof raw.reason === "string" && VALID_REASONS.has(raw.reason)
      ? (raw.reason as TelemetryStatusReason)
      : decision === "accepted"
        ? "accepted"
        : decision === "declined"
          ? "declined"
          : raw.effective
            ? "default-on"
            : "awaiting-notice";
  const envOverride: TelemetryEnvOverride =
    raw.envOverride === "OCX_TELEMETRY" || raw.envOverride === "DO_NOT_TRACK"
      ? raw.envOverride
      : reason === "env-ocx-telemetry"
        ? "OCX_TELEMETRY"
        : reason === "env-do-not-track"
          ? "DO_NOT_TRACK"
          : null;
  const preview =
    raw.preview && typeof raw.preview === "object" && !Array.isArray(raw.preview)
      ? (raw.preview as Record<string, unknown>)
      : {};
  const previewEligible =
    typeof raw.previewEligible === "boolean" ? raw.previewEligible : undefined;
  return {
    effective: raw.effective,
    reason,
    decision,
    decidedAt: typeof raw.decidedAt === "string" ? raw.decidedAt : null,
    noticeShownAt: typeof raw.noticeShownAt === "string" ? raw.noticeShownAt : null,
    envOverride,
    installChannel: typeof raw.installChannel === "string" ? raw.installChannel : "unknown",
    lastSentDay: typeof raw.lastSentDay === "string" ? raw.lastSentDay : null,
    lastSentAt: typeof raw.lastSentAt === "string" ? raw.lastSentAt : null,
    preview,
    ...(previewEligible !== undefined ? { previewEligible } : {}),
  };
}

/**
 * True when the first-run or post-update consent dialog should be presented:
 * undecided install, no environment opt-out override, and reason is awaiting-notice or default-on.
 */
export function shouldShowTelemetryConsentPrompt(status: TelemetryStatusSnapshot): boolean {
  if (status.decision !== null) return false;
  if (status.envOverride !== null) return false;
  return status.reason === "awaiting-notice" || status.reason === "default-on";
}

export function formatTelemetryPreviewJson(status: TelemetryStatusSnapshot | null): string {
  return JSON.stringify(status?.preview ?? {}, null, 2);
}

function notifyTelemetryStatusChanged(snapshot: TelemetryStatusSnapshot): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  try {
    const CustomEventCtor =
      (window as Window & { CustomEvent?: typeof CustomEvent }).CustomEvent ?? CustomEvent;
    window.dispatchEvent(new CustomEventCtor(TELEMETRY_STATUS_CHANGED_EVENT, { detail: snapshot }));
  } catch {
    // Best-effort cross-component notification.
  }
}

/**
 * True when another modal `<dialog>` in `document` is currently open.
 * Used by telemetry dialogs so two modal overlays never stack.
 */
export function hasOtherOpenModalDialog(ownSelector?: string): boolean {
  if (typeof document === "undefined") return false;
  const dialogs = document.querySelectorAll("dialog");
  for (const dialog of dialogs) {
    if (ownSelector && dialog.matches(ownSelector)) continue;
    const isOpen =
      dialog.open ||
      dialog.hasAttribute("open") ||
      (dialog.classList.contains("modal-overlay") && dialog.style.display !== "none");
    if (isOpen) return true;
  }
  return false;
}

export function subscribeModalDialogChanges(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const target = document.body ?? document.documentElement;
  const ObserverCtor =
    (typeof window !== "undefined"
      ? (window as Window & { MutationObserver?: typeof MutationObserver }).MutationObserver
      : undefined) ??
    (typeof MutationObserver !== "undefined" ? MutationObserver : undefined);
  const observer =
    ObserverCtor && target
      ? new ObserverCtor(() => {
          onChange();
        })
      : null;
  observer?.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["open", "style", "class"],
  });
  document.addEventListener("close", onChange, true);
  document.addEventListener("cancel", onChange, true);
  return () => {
    observer?.disconnect();
    document.removeEventListener("close", onChange, true);
    document.removeEventListener("cancel", onChange, true);
  };
}

export async function fetchTelemetryStatus(
  apiBase: string,
  callerSignal?: AbortSignal,
): Promise<TelemetryStatusSnapshot> {
  const bounded = createBoundedFetch(TELEMETRY_TIMEOUT_MS);
  const onCallerAbort = () => bounded.controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    bounded.clear();
    throw callerSignal.reason ?? new DOMException("Aborted", "AbortError");
  }
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    const res = await fetch(apiBase + "/api/telemetry", { signal: bounded.signal });
    if (!res.ok) throw new Error("HTTP " + String(res.status));
    const parsed = parseTelemetryStatus(await res.json());
    if (!parsed) throw new Error("invalid telemetry status payload");
    return parsed;
  } finally {
    callerSignal?.removeEventListener("abort", onCallerAbort);
    bounded.clear();
  }
}

export async function putTelemetryDecision(
  apiBase: string,
  decision: TelemetryDecision,
  _previous?: TelemetryStatusSnapshot | null,
): Promise<TelemetryStatusSnapshot | null> {
  const bounded = createBoundedFetch(TELEMETRY_TIMEOUT_MS);
  try {
    const res = await fetch(apiBase + "/api/telemetry", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
      signal: bounded.signal,
    });
    if (!res.ok) {
      const failure: unknown = await res.json().catch(() => null);
      const code =
        failure && typeof failure === "object" && typeof (failure as { code?: unknown }).code === "string"
          ? (failure as { code: string }).code
          : null;
      throw new TelemetrySaveError(res.status, code);
    }
    const body: unknown = await res.json().catch(() => null);
    const parsed = parseTelemetryStatus(body);
    // The decision is saved; a reply that cannot be read is re-read from the server, never guessed.
    // If that re-read fails too, the save still stands: return null and let the next poll refresh.
    const snapshot = parsed ?? (await fetchTelemetryStatus(apiBase).catch(() => null));
    if (snapshot) notifyTelemetryStatusChanged(snapshot);
    return snapshot;
  } finally {
    bounded.clear();
  }
}

/** A refused or failed `PUT /api/telemetry`, with the server's error code when it sent one. */
export class TelemetrySaveError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(code ? `HTTP ${String(status)} ${code}` : `HTTP ${String(status)}`);
    this.name = "TelemetrySaveError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The server records consent only from a human dashboard session; a session restored from a
 * remembered device is refused with `agent_consent_required` and cannot succeed by retrying.
 */
export function isTelemetryConsentSessionRefused(error: unknown): boolean {
  return error instanceof TelemetrySaveError && error.code === "agent_consent_required";
}

/** The full privacy policy; the same URL as `TELEMETRY_POLICY_URL` in `src/telemetry/disclosure.ts`. */
export const TELEMETRY_POLICY_URL = "https://opencodex.me/reference/code-signing/#privacy";
