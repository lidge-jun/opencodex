import { useCallback, useEffect, useRef, useState } from "react";
import { isApiTargetCaptureCurrent, targetFetch, type ApiTargetCapture } from "../api";
import { useRenderTargetCapture } from "../use-render-target-capture";

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

export function useMainDeviceReauth(apiBase: string, onCompleted: () => void, targetKey?: string) {
  // The hook's render owns the target for a flow started from this surface.
  const renderCapture = useRenderTargetCapture(apiBase, targetKey);
  const identity = targetKey ?? apiBase;
  const [state, setState] = useState<MainDeviceReauthState>({ phase: "idle" });
  const flowRef = useRef<string | null>(null);
  /** The target the live flow started on; every request for it uses this capture. */
  const flowCaptureRef = useRef<ApiTargetCapture | null>(null);
  const cancellationRequestedFlowRef = useRef<string | null>(null);
  const lastCancellableStateRef = useRef<CancellableState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const unmountedRef = useRef(false);
  const identityRef = useRef(identity);
  // Adjust the visible state at the prop boundary so A's code never paints under B.
  // The effect below still owns retiring A's flow on its own capture.
  const [frameIdentity, setFrameIdentity] = useState(identity);
  if (frameIdentity !== identity) {
    setFrameIdentity(identity);
    setState({ phase: "idle" });
  }

  const stopPolling = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // A logical target change retires the previous target's flow. The card must not keep
  // showing A's code under B, and the abandoned flow is cancelled on A's own capture
  // (a stale capture is refused before fetch) without claiming an outcome here.
  useEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    const flowId = flowRef.current;
    const capture = flowCaptureRef.current;
    flowRef.current = null;
    flowCaptureRef.current = null;
    cancellationRequestedFlowRef.current = null;
    lastCancellableStateRef.current = null;
    stopPolling();
    if (flowId && capture) {
      void targetFetch(capture, `${capture.apiBase}/api/codex-auth/main/reauth-device?flowId=${encodeURIComponent(flowId)}`, { method: "DELETE" })
        .catch(() => {});
    }
  }, [identity, stopPolling]);

  const cancel = useCallback(async () => {
    const flowId = flowRef.current;
    const capture = flowCaptureRef.current;
    if (!flowId || !capture) {
      stopPolling();
      flowRef.current = null;
      flowCaptureRef.current = null;
      setState({ phase: "idle" });
      return;
    }
    cancellationRequestedFlowRef.current = flowId;
    try {
      // Error JSON identifies an expired flow; status is checked before applying its DTO.
      // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check
      const res = await targetFetch(capture, `${capture.apiBase}/api/codex-auth/main/reauth-device?flowId=${encodeURIComponent(flowId)}`, { method: "DELETE" });
      const dto = await res.json().catch(() => ({})) as FlowDto;
      if (unmountedRef.current || flowRef.current !== flowId) return;
      if (!isApiTargetCaptureCurrent(capture)) {
        // The target changed while the DELETE was in flight. Its answer belongs to the
        // abandoned flow; release it here without applying that outcome to the new target.
        stopPolling();
        flowRef.current = null;
        flowCaptureRef.current = null;
        setState({ phase: "failed", code: "request_failed" });
        return;
      }
      if (res.status === 409 && dto.error === "target_changed") {
        // The flow belongs to a target this surface no longer manages. Release the ID
        // without claiming cancellation or success; the server expires it.
        stopPolling();
        flowRef.current = null;
        flowCaptureRef.current = null;
        setState({ phase: "failed", code: "request_failed" });
        return;
      }
      if (res.status === 404 && dto.code === "unknown_flow") {
        // The service may have expired its terminal receipt after a lost DELETE response.
        // Release the stale ID without claiming cancellation or successful authentication.
        stopPolling();
        flowRef.current = null;
        flowCaptureRef.current = null;
        setState({ phase: "failed", code: "request_failed" });
        return;
      }
      if (!res.ok) throw new Error();
      if (dto.status !== "cancelled" && dto.status !== "succeeded" && dto.status !== "failed") {
        throw new Error();
      }
      stopPolling();
      flowRef.current = null;
      flowCaptureRef.current = null;
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
  }, [onCompleted, stopPolling]);

  const start = useCallback(async () => {
    stopPolling();
    flowRef.current = null;
    flowCaptureRef.current = null;
    cancellationRequestedFlowRef.current = null;
    lastCancellableStateRef.current = null;
    // The flow owns the target it starts on; a re-render under another target must
    // not retarget its start, status or cancel requests.
    const capture = { ...renderCapture };
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const isCurrent = () => !ctrl.signal.aborted && !unmountedRef.current && abortRef.current === ctrl
      && isApiTargetCaptureCurrent(capture);
    setState({ phase: "starting" });
    let startedFlowId: string;
    try {
      // Empty body by contract: the route rejects any request keys with 400.
      // Error JSON supplies the normalized failure code; !res.ok never starts a flow.
      // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check
      const res = await targetFetch(capture, `${capture.apiBase}/api/codex-auth/main/reauth-device`, { method: "POST", signal: ctrl.signal });
      const dto = await res.json().catch(() => ({})) as FlowDto;
      if (!res.ok) {
        // A refused stale capture never reached the server. Report the refusal unless a
        // newer start already owns this surface.
        if (!isApiTargetCaptureCurrent(capture)) {
          if (abortRef.current === ctrl && !unmountedRef.current) {
            setState({ phase: "failed", code: "request_failed" });
          }
          return;
        }
        if (!isCurrent()) return;
        setState({ phase: "failed", code: failureCode(dto.code) });
        return;
      }
      if (!isCurrent()) return;
      if (typeof dto.flowId !== "string" || !dto.flowId) {
        setState({ phase: "failed", code: "request_failed" });
        return;
      }
      startedFlowId = dto.flowId;
    } catch {
      if (abortRef.current === ctrl && !unmountedRef.current) {
        setState({ phase: "failed", code: "request_failed" });
      }
      return;
    }
    // Polling and queued updaters capture the accepted identity, not the mutable parse slot.
    const flowId = startedFlowId;
    flowRef.current = flowId;
    flowCaptureRef.current = capture;
    let lastUrl = "";
    let lastCode = "";
    // Poll immediately: the start response predates the usercode reply, so the
    // URL and human code only arrive through status reads.
    while (isCurrent()) {
      if (flowRef.current !== flowId) return;
      try {
        // Non-2xx JSON is consumed for its failure code, never as a successful status.
        // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check
        const res = await targetFetch(
          capture,
          `${capture.apiBase}/api/codex-auth/main/reauth-device?flowId=${encodeURIComponent(flowId)}`,
          { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(POLL_TICK_TIMEOUT_MS)]) },
        );
        const dto = await res.json().catch(() => ({})) as FlowDto;
        if (!isCurrent() || flowRef.current !== flowId) return;
        if (!res.ok) {
          if (res.status === 409 && dto.error === "target_changed") {
            // The surface no longer owns this flow's target. Release without claiming
            // cancellation or success; the server expires the abandoned flow.
            stopPolling();
            flowRef.current = null;
            flowCaptureRef.current = null;
            setState({ phase: "failed", code: "request_failed" });
            return;
          }
          if (res.status === 404 && dto.code === "unknown_flow") {
            stopPolling();
            flowRef.current = null;
            flowCaptureRef.current = null;
            setState({ phase: "failed", code: "request_failed" });
            return;
          }
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
            flowCaptureRef.current = null;
            setState({ phase: "succeeded" });
            onCompleted();
            return;
          } else if (dto.status === "cancelled") {
            flowRef.current = null;
            flowCaptureRef.current = null;
            setState({ phase: "cancelled" });
            return;
          } else if (dto.status === "failed") {
            flowRef.current = null;
            flowCaptureRef.current = null;
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
    // The loop exits on a target change before the next tick. Release the abandoned flow
    // without claiming an outcome; an unmount or a replacement start owns its own state.
    if (!unmountedRef.current && flowRef.current === flowId && !isApiTargetCaptureCurrent(capture)) {
      stopPolling();
      flowRef.current = null;
      flowCaptureRef.current = null;
      setState({ phase: "failed", code: "request_failed" });
    }
  }, [onCompleted, renderCapture, stopPolling]);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      stopPolling();
      const flowId = flowRef.current;
      const capture = flowCaptureRef.current;
      flowRef.current = null;
      flowCaptureRef.current = null;
      if (flowId && capture) {
        void targetFetch(capture, `${capture.apiBase}/api/codex-auth/main/reauth-device?flowId=${encodeURIComponent(flowId)}`, { method: "DELETE" })
          .catch(() => {});
      }
    };
  }, [stopPolling]);

  return { state, start, cancel };
}
