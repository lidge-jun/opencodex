import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Main-card device reauth (#3898 L3): drives the dedicated native-main
 * namespace /api/codex-auth/main/reauth-device. Deliberately NOT the pool
 * AddCodexAccountModal/openReauth path — /api/codex-auth/login rejects
 * __main__ and would write the wrong credential store.
 *
 * DTO hygiene: the hook only ever reads flowId, status, verificationUrl,
 * deviceCode, and the closed failure-code set; token fields are never
 * accepted even if a payload carried them. The verification URL is
 * allowlisted to the known device page. Polling owns its flowId: late
 * responses from a replaced flow are ignored, and nothing persists to
 * browser storage.
 */

const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const POLL_INTERVAL_MS = 2_000;
const POLL_TICK_TIMEOUT_MS = 10_000;

export type MainDeviceReauthFailureCode =
  | "identity_mismatch"
  | "credential_changed"
  | "native_main_unavailable"
  | "device_authorization_failed"
  | "publication_failed"
  | "reconciliation_failed"
  | "flow_in_progress"
  | "request_failed";

export type MainDeviceReauthState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "pending"; flowId: string; verificationUrl: string; deviceCode: string; cancelFailed?: boolean }
  | { phase: "committing"; flowId: string; verificationUrl: string; deviceCode: string; cancelFailed?: boolean }
  | { phase: "succeeded" }
  | { phase: "cancelled" }
  | { phase: "failed"; code: MainDeviceReauthFailureCode };

type CancellableState = Extract<MainDeviceReauthState, { phase: "pending" | "committing" }>;

type FlowDto = {
  flowId?: unknown;
  status?: unknown;
  verificationUrl?: unknown;
  deviceCode?: unknown;
  code?: unknown;
  error?: unknown;
};

const FAILURE_CODES = new Set<MainDeviceReauthFailureCode>([
  "identity_mismatch",
  "credential_changed",
  "native_main_unavailable",
  "device_authorization_failed",
  "publication_failed",
  "reconciliation_failed",
  "flow_in_progress",
]);

function failureCode(value: unknown): MainDeviceReauthFailureCode {
  return typeof value === "string" && FAILURE_CODES.has(value as MainDeviceReauthFailureCode)
    ? value as MainDeviceReauthFailureCode
    : "request_failed";
}

function allowedVerificationUrl(value: unknown): string {
  return typeof value === "string" && value.startsWith(DEVICE_VERIFICATION_URL) ? value : "";
}

function humanCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z0-9-]{1,16}$/i.test(value) ? value : "";
}

export function useMainDeviceReauth(apiBase: string, onCompleted: () => void) {
  const [state, setState] = useState<MainDeviceReauthState>({ phase: "idle" });
  const flowRef = useRef<string | null>(null);
  const cancellationRequestedFlowRef = useRef<string | null>(null);
  const lastCancellableStateRef = useRef<CancellableState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const unmountedRef = useRef(false);

  const stopPolling = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const cancel = useCallback(async () => {
    const flowId = flowRef.current;
    if (!flowId) {
      stopPolling();
      setState({ phase: "idle" });
      return;
    }
    cancellationRequestedFlowRef.current = flowId;
    try {
      // Error JSON identifies an expired flow; status is checked before applying its DTO.
      // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check
      const res = await fetch(`${apiBase}/api/codex-auth/main/reauth-device?flowId=${encodeURIComponent(flowId)}`, { method: "DELETE" });
      const dto = await res.json().catch(() => ({})) as FlowDto;
      if (unmountedRef.current || flowRef.current !== flowId) return;
      if (res.status === 404 && dto.code === "unknown_flow") {
        // The service may have expired its terminal receipt after a lost DELETE response.
        // Release the stale ID without claiming cancellation or successful authentication.
        stopPolling();
        flowRef.current = null;
        setState({ phase: "failed", code: "request_failed" });
        return;
      }
      if (!res.ok) throw new Error();
      if (dto.status !== "cancelled" && dto.status !== "succeeded" && dto.status !== "failed") {
        throw new Error();
      }
      stopPolling();
      flowRef.current = null;
      setState(dto.status === "failed"
        ? { phase: "failed", code: failureCode(dto.code) }
        : { phase: dto.status });
      if (dto.status === "succeeded") onCompleted();
    } catch {
      if (unmountedRef.current || flowRef.current !== flowId) return;
      // Retain ownership and polling so retries and device-login completion remain observable.
      setState(current => {
        if (unmountedRef.current || flowRef.current !== flowId) return current;
        // A concurrent polling HTTP error can hide the still-owned flow behind
        // failed. Restore its last device details and phase so Cancel stays usable.
        const active = current.phase === "pending" || current.phase === "committing"
          ? current
          : lastCancellableStateRef.current;
        return active?.flowId === flowId ? { ...active, cancelFailed: true } : current;
      });
    }
  }, [apiBase, onCompleted, stopPolling]);

  const start = useCallback(async () => {
    stopPolling();
    flowRef.current = null;
    cancellationRequestedFlowRef.current = null;
    lastCancellableStateRef.current = null;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const isCurrent = () => !ctrl.signal.aborted && !unmountedRef.current && abortRef.current === ctrl;
    setState({ phase: "starting" });
    let startedFlowId: string;
    try {
      // Empty body by contract: the route rejects any request keys with 400.
      // Error JSON supplies the normalized failure code; !res.ok never starts a flow.
      // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check
      const res = await fetch(`${apiBase}/api/codex-auth/main/reauth-device`, { method: "POST", signal: ctrl.signal });
      const dto = await res.json().catch(() => ({})) as FlowDto;
      if (!isCurrent()) return;
      if (!res.ok) {
        setState({ phase: "failed", code: failureCode(dto.code) });
        return;
      }
      if (typeof dto.flowId !== "string" || !dto.flowId) {
        setState({ phase: "failed", code: "request_failed" });
        return;
      }
      startedFlowId = dto.flowId;
    } catch {
      if (isCurrent()) setState({ phase: "failed", code: "request_failed" });
      return;
    }
    // Polling and queued updaters capture the accepted identity, not the mutable parse slot.
    const flowId = startedFlowId;
    flowRef.current = flowId;
    let lastUrl = "";
    let lastCode = "";
    // Poll immediately: the start response predates the usercode reply, so the
    // URL and human code only arrive through status reads.
    while (isCurrent()) {
      if (flowRef.current !== flowId) return;
      try {
        // Non-2xx JSON is consumed for its failure code, never as a successful status.
        // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check
        const res = await fetch(
          `${apiBase}/api/codex-auth/main/reauth-device?flowId=${encodeURIComponent(flowId)}`,
          { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(POLL_TICK_TIMEOUT_MS)]) },
        );
        const dto = await res.json().catch(() => ({})) as FlowDto;
        if (!isCurrent() || flowRef.current !== flowId) return;
        if (!res.ok) {
          // Ownership continues from the Cancel click, including while DELETE
          // is unresolved. Never offer a replacement POST during that window,
          // and keep the existing poll cadence so a later terminal status remains observable.
          const cancellationRequested = cancellationRequestedFlowRef.current === flowId;
          setState(current => {
            if (!isCurrent() || flowRef.current !== flowId) return current;
            return (current.phase === "pending" || current.phase === "committing")
              && current.flowId === flowId && (cancellationRequested || current.cancelFailed)
              ? current
              : { phase: "failed", code: failureCode(dto.code) };
          });
          if (!cancellationRequested) return;
        } else {
          lastUrl = allowedVerificationUrl(dto.verificationUrl) || lastUrl;
          lastCode = humanCode(dto.deviceCode) || lastCode;
          if (dto.status === "pending" || dto.status === "committing") {
            const pendingState: CancellableState = {
              phase: dto.status,
              flowId,
              verificationUrl: lastUrl,
              deviceCode: lastCode,
            };
            lastCancellableStateRef.current = pendingState;
            setState(current => (current.phase === "pending" || current.phase === "committing")
              && current.flowId === flowId && current.cancelFailed
              ? { ...pendingState, cancelFailed: true }
              : pendingState);
          } else if (dto.status === "succeeded") {
            flowRef.current = null;
            setState({ phase: "succeeded" });
            onCompleted();
            return;
          } else if (dto.status === "cancelled") {
            flowRef.current = null;
            setState({ phase: "cancelled" });
            return;
          } else if (dto.status === "failed") {
            flowRef.current = null;
            setState({ phase: "failed", code: failureCode(dto.code) });
            return;
          }
        }
      } catch {
        if (!isCurrent() || flowRef.current !== flowId) return;
        // A tick failure is transient: the service flow keeps its own deadline.
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }, [apiBase, onCompleted, stopPolling]);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      stopPolling();
      const flowId = flowRef.current;
      flowRef.current = null;
      if (flowId) {
        void fetch(`${apiBase}/api/codex-auth/main/reauth-device?flowId=${encodeURIComponent(flowId)}`, { method: "DELETE" })
          .catch(() => {});
      }
    };
  }, [apiBase, stopPolling]);

  return { state, start, cancel };
}
