import { useCallback, useEffect, useRef, useState } from "react";
import { afterOAuthCancellation } from "../oauth-cancellation-barrier";
import { finalizeKiroDeviceFlow, observeKiroDeviceFinal, type KiroFinalOutcome } from "../kiro-device-login-finalizer";
import { parseKiroDeviceView, type KiroDeviceMethod, type KiroDeviceView } from "../kiro-device-login-helpers";

type Phase = "idle" | "starting" | "pending" | "done" | "expired" | "failed" | "cancelled" | "ended";
export type KiroLoginState = { phase: Phase; view?: KiroDeviceView; error?: "start" | "network" | "invalid" };
type Session = { closed: boolean; view?: KiroDeviceView; inFlight?: Promise<Response | null>;
  waitController?: AbortController; terminal?: KiroFinalOutcome };
const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); resolve(); };
  signal.addEventListener("abort", stop, { once: true });
});
const CLOSED = Symbol("closed");
/** The awaited value, or CLOSED when the session closed while it was pending (a late reply belongs to the finalizer). */
const unlessClosed = <T,>(session: Session, value: Promise<T>): Promise<T | typeof CLOSED> =>
  value.then(result => (session.closed ? CLOSED : result));

export function useKiroDeviceLogin(apiBase: string, onSettled?: (provider: string, outcome: KiroFinalOutcome) => void,
  pollDelay: (ms: number, signal: AbortSignal) => Promise<void> = wait) {
  const [state, setState] = useState<KiroLoginState>({ phase: "idle" });
  const sessionRef = useRef<Session | null>(null);
  const mountedRef = useRef(true);
  const settledRef = useRef(onSettled);
  useEffect(() => { settledRef.current = onSettled; }, [onSettled]);

  const cancelServer = useCallback(async (view: KiroDeviceView): Promise<Response | null> => {
    try {
      return await fetch(`${apiBase}/api/oauth/login/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "kiro", flowId: view.flowId }), keepalive: true,
      });
    } catch { return null; }
  }, [apiBase]);

  const handoff = useCallback((session: Session) => {
    const view = session.view;
    if (view && !session.terminal) void finalizeKiroDeviceFlow(apiBase, view.flowId, view.expiresAt, session.inFlight);
  }, [apiBase]);

  const close = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || session.closed) return;
    session.closed = true;
    sessionRef.current = null;
    session.waitController?.abort();
    if (mountedRef.current) setState({ phase: "cancelled" });
    if (!session.view || session.terminal) return;
    // cancelServer dispatches fetch before its first await. Status reconciliation
    // must start only after that POST has been sent, without waiting for its reply.
    const cancellation = cancelServer(session.view);
    handoff(session);
    const response = await cancellation;
    const reply = response?.ok ? parseKiroDeviceView(await response.json().catch(() => null)) : null;
    if (reply) observeKiroDeviceFinal(apiBase, session.view.flowId, reply, "cancel");
  }, [apiBase, cancelServer, handoff]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; void close(); };
  }, [close]);

  const start = useCallback(async (method: KiroDeviceMethod) => {
    if (sessionRef.current) return;
    const session: Session = { closed: false };
    sessionRef.current = session;
    setState({ phase: "starting" });
    let response: Response | undefined;
    try {
      response = await afterOAuthCancellation(apiBase, "kiro", () => fetch(`${apiBase}/api/oauth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "kiro", method }),
      }));
    } catch {
      if (!session.closed && mountedRef.current) setState({ phase: "failed", error: "network" });
      if (sessionRef.current === session) sessionRef.current = null;
      return;
    }
    const view = response.ok ? parseKiroDeviceView(await response.json().catch(() => null)) : null;
    if (!view || view.method !== method) {
      if (!session.closed && mountedRef.current) setState({ phase: "failed", error: response.ok ? "invalid" : "start" });
      if (sessionRef.current === session) sessionRef.current = null;
      return;
    }
    session.view = view;
    if (session.closed) {
      const cancellation = cancelServer(view);
      handoff(session);
      const cancelled = await cancellation;
      const reply = cancelled?.ok ? parseKiroDeviceView(await cancelled.json().catch(() => null)) : null;
      if (reply) observeKiroDeviceFinal(apiBase, view.flowId, reply, "cancel");
      return;
    }
    if (view.state !== "pending") {
      if (view.state === "done") settledRef.current?.("kiro", "added");
      else if (view.state === "failed") settledRef.current?.("kiro", "failed");
      if (mountedRef.current) setState({ phase: view.state, view });
      session.terminal = view.state === "done" ? "added" : view.state === "failed" ? "failed" : "ended";
      sessionRef.current = null;
      return;
    }
    setState({ phase: "pending", view });
    while (!session.closed && !session.terminal) {
      const waitController = new AbortController();
      session.waitController = waitController;
      await pollDelay(2_000, waitController.signal);
      session.waitController = undefined;
      if (session.closed || session.terminal) break;
      if (session.view?.expiresAt && Date.now() >= session.view.expiresAt) {
        session.terminal = "ended";
        if (mountedRef.current) setState({ phase: "expired", view: session.view });
        break;
      }
      const flowId = view.flowId;
      const request = fetch(`${apiBase}/api/oauth/status?provider=kiro&flowId=${encodeURIComponent(flowId)}`).catch(() => null);
      session.inFlight = request.then(response => response?.clone() ?? null);
      const status = await unlessClosed(session, request);
      if (status === CLOSED) break;
      if (status?.status === 404) {
        session.inFlight = undefined;
        session.terminal = "ended";
        settledRef.current?.("kiro", "ended");
        setState({ phase: "ended", view: session.view });
        break;
      }
      const body = status?.ok ? await unlessClosed(session, status.json().catch(() => null)) : null;
      if (body === CLOSED) break;
      const next = body === null ? null : parseKiroDeviceView(body);
      session.inFlight = undefined;
      if (!next || next.flowId !== flowId) continue;
      session.view = next;
      if (next.state === "pending") { setState({ phase: "pending", view: next }); continue; }
      session.terminal = next.state === "done" ? "added" : next.state === "failed" ? "failed" : "ended";
      if (next.state === "done" || next.state === "failed") settledRef.current?.("kiro", session.terminal);
      setState({ phase: next.state, view: next });
      break;
    }
    if (sessionRef.current === session) sessionRef.current = null;
  }, [apiBase, cancelServer, handoff, pollDelay]);

  const reset = useCallback(() => { if (!sessionRef.current) setState({ phase: "idle" }); }, []);
  return { state, start, close, reset };
}
