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
  | { phase: "pending"; flowId: string; verificationUrl: string; deviceCode: string }
  | { phase: "committing"; flowId: string; verificationUrl: string; deviceCode: string }
  | { phase: "succeeded" }
  | { phase: "cancelled" }
  | { phase: "failed"; code: MainDeviceReauthFailureCode };

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
  const abortRef = useRef<AbortController | null>(null);
  const unmountedRef = useRef(false);

  const stopPolling = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const cancel = useCallback(async () => {
    const flowId = flowRef.current;
    stopPolling();
    flowRef.current = null;
    if (!flowId) {
      setState({ phase: "idle" });
      return;
    }
    try {
      await fetch(`${apiBase}/api/codex-auth/main/reauth-device?flowId=${encodeURIComponent(flowId)}`, { method: "DELETE" });
    } catch { /* best-effort: the flow expires on its own */ }
    setState({ phase: "cancelled" });
  }, [apiBase, stopPolling]);

  const start = useCallback(async () => {
    stopPolling();
    flowRef.current = null;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ phase: "starting" });
    let flowId: string;
    try {
      // Empty body by contract: the route rejects any request keys with 400.
      const res = await fetch(`${apiBase}/api/codex-auth/main/reauth-device`, { method: "POST", signal: ctrl.signal });
      if (!res.ok) {
        const failed = await res.json().catch(() => ({})) as FlowDto;
        setState({ phase: "failed", code: failureCode(failed.code) });
        return;
      }
      const dto = await res.json().catch(() => ({})) as FlowDto;
      if (typeof dto.flowId !== "string" || !dto.flowId) {
        setState({ phase: "failed", code: "request_failed" });
        return;
      }
      flowId = dto.flowId;
    } catch {
      if (!ctrl.signal.aborted) setState({ phase: "failed", code: "request_failed" });
      return;
    }
    flowRef.current = flowId;
    let lastUrl = "";
    let lastCode = "";
    // Poll immediately: the start response predates the usercode reply, so the
    // URL and human code only arrive through status reads.
    while (!ctrl.signal.aborted) {
      if (ctrl.signal.aborted || unmountedRef.current || flowRef.current !== flowId) return;
      try {
        const res = await fetch(
          `${apiBase}/api/codex-auth/main/reauth-device?flowId=${encodeURIComponent(flowId)}`,
          { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(POLL_TICK_TIMEOUT_MS)]) },
        );
        if (!res.ok) {
          const failed = await res.json().catch(() => ({})) as FlowDto;
          setState({ phase: "failed", code: failureCode(failed.code) });
          return;
        }
        const dto = await res.json().catch(() => ({})) as FlowDto;
        lastUrl = allowedVerificationUrl(dto.verificationUrl) || lastUrl;
        lastCode = humanCode(dto.deviceCode) || lastCode;
        if (dto.status === "pending" || dto.status === "committing") {
          setState({
            phase: dto.status,
            flowId,
            verificationUrl: lastUrl,
            deviceCode: lastCode,
          });
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
      } catch {
        if (ctrl.signal.aborted || unmountedRef.current) return;
        // A tick failure is transient: the service flow keeps its own deadline.
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }, [apiBase, onCompleted, stopPolling]);

  useEffect(() => {
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
