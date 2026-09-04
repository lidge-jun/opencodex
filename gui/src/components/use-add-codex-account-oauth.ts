import { useCallback, useEffect, useRef } from "react";
import type { Dispatch } from "react";
import type {
  AddCodexAccountStep,
  AddCodexAccountUiAction,
  ManualCodeState,
} from "./add-codex-account-reducer";
import type { TFn } from "../i18n/shared";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { openBrowserRequestField } from "../oauth-open-browser-pref";
import { startVisibilityPoll } from "../visibility-poll";

/**
 * How long the modal waits before giving up. The browser flow is bounded by
 * the proxy's own callback server; the device grant lives 15 minutes and the
 * user is expected to walk away, so it gets the grant's lifetime plus a small
 * settlement margin for the token exchange and credential write that follow
 * the final poll.
 */
const LOGIN_TIMEOUT_BROWSER_MS = 300_000;
const LOGIN_TIMEOUT_DEVICE_MS = 960_000;
import {
  codexAccountMutationCompletion,
  type CodexAccountMutationCompletion,
} from "../codex-account-mutation";

export function useAddCodexAccountOAuth({
  apiBase,
  reauthAccountId,
  ui,
  dispatch,
  t,
}: {
  apiBase: string;
  reauthAccountId?: string;
  ui: {
    step: AddCodexAccountStep;
    manualCodeState: ManualCodeState;
    manualCode: string;
    authUrl: string;
    flowId: string | null;
  };
  dispatch: Dispatch<AddCodexAccountUiAction>;
  t: TFn;
}) {
  const aliveRef = useRef(true);
  const pollErrorStreakRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const pollRef = useRef<(() => void) | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const flowRef = useRef<string | null>(null);
  const manualCodeStateRef = useRef(ui.manualCodeState);
  const loginAbortRef = useRef<AbortController | null>(null);
  const startedReauthRef = useRef<string | null>(null);
  const onAddedRef = useRef<(completion: CodexAccountMutationCompletion) => void>(() => {});
  const onCloseRef = useRef<() => void>(() => {});

  const manualCodeBusy = ui.manualCodeState === "submitting";
  const manualCodeWaiting = ui.manualCodeState === "waiting";

  useEffect(() => {
    manualCodeStateRef.current = ui.manualCodeState;
  }, [ui.manualCodeState]);
  useEffect(() => {
    flowRef.current = ui.flowId;
  }, [ui.flowId]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { pollRef.current(); pollRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    pollInFlightRef.current = false;
  }, []);

  const clearManualCode = useCallback(() => {
    dispatch({ type: "clear-manual-code" });
    pollErrorStreakRef.current = 0;
  }, [dispatch]);

  const cancelLogin = useCallback(async () => {
    clearManualCode();
    const flowId = flowRef.current;
    flowRef.current = null;
    dispatch({ type: "set-flow-id", flowId: null });
    // Clear the whole hint, not just the URL: leaving deviceCode behind would
    // display an expired code next to the timeout error.
    dispatch({ type: "set-login-hint", authUrl: "" });
    stopPolling();
    loginAbortRef.current?.abort();
    loginAbortRef.current = null;
    if (!flowId) return;
    await fetch(`${apiBase}/api/codex-auth/login/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId }),
    }).catch(() => {});
  }, [apiBase, clearManualCode, dispatch, stopPolling]);

  // Replay-safe under StrictMode: remount must revive aliveRef and clear the
  // reauth latch so the remounted effect can start OAuth again.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      clearManualCode();
      aliveRef.current = false;
      startedReauthRef.current = null;
      loginAbortRef.current?.abort();
      loginAbortRef.current = null;
      const flowId = flowRef.current;
      flowRef.current = null;
      dispatch({ type: "set-flow-id", flowId: null });
      stopPolling();
      if (flowId) {
        void fetch(`${apiBase}/api/codex-auth/login/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId }),
        }).catch(() => {});
      }
    };
  }, [apiBase, clearManualCode, dispatch, stopPolling]);

  const bindCallbacks = useCallback((
    onAdded: (completion: CodexAccountMutationCompletion) => void,
    onClose: () => void,
  ) => {
    onAddedRef.current = onAdded;
    onCloseRef.current = onClose;
  }, []);

  const closeModal = useCallback(() => {
    if (ui.step === "oauth-waiting") void cancelLogin();
    onCloseRef.current();
  }, [ui.step, cancelLogin]);

  const startOAuth = useCallback(async (requestedId?: string, options?: { device?: boolean }) => {
    clearManualCode();
    flowRef.current = null;
    dispatch({ type: "set-flow-id", flowId: null });
    const controller = new AbortController();
    loginAbortRef.current?.abort();
    loginAbortRef.current = controller;
    dispatch({ type: "reset-oauth-start" });
    pollErrorStreakRef.current = 0;
    try {
      const accountId = reauthAccountId ?? requestedId?.trim() ?? "";
      // An explicit choice from the modal, not an inference. "Don't open a
      // browser on the proxy machine" was tempting to reuse, but it means
      // "use a different browser", not "change authentication protocol" —
      // reading it as a device-flow request would retarget a preference some
      // users set for an unrelated reason (#3366).
      const wantsDeviceFlow = options?.device === true;
      const requestLogin = () => fetch(`${apiBase}/api/codex-auth/login`, {
        signal: controller.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...openBrowserRequestField(),
          ...(wantsDeviceFlow ? { device: true } : {}),
          ...(reauthAccountId
            ? { id: reauthAccountId, reauth: true }
            : (accountId ? { id: accountId } : {})),
        }),
      });
      type LoginResponse = {
        url?: string;
        flowId?: string;
        error?: string;
        status?: string;
        deviceCode?: string;
        instructions?: string;
      };
      let resp = await requestLogin();
      if (!aliveRef.current) return;
      if (resp.status === 409) {
        await fetch(`${apiBase}/api/codex-auth/login/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!aliveRef.current || controller.signal.aborted) return;
        resp = await requestLogin();
        if (resp.status === 409) {
          dispatch({ type: "set-error", error: t("codexAuth.oauthAlreadyInProgress") });
          return;
        }
      }
      // Preserve structured `{ error }` bodies on non-2xx instead of collapsing to networkError.
      const data = await readJsonOrThrow<LoginResponse>(resp, t("modal.networkError"));
      if (!aliveRef.current || !data) return;
      if (data.url) {
        flowRef.current = data.flowId ?? null;
        dispatch({ type: "set-flow-id", flowId: data.flowId ?? null });
        // Carry the device code and prose through: LoginHint already renders a
        // copyable code, but the Codex modal used to pass only the URL, so a
        // device login showed a page with no code to type (#3366).
        dispatch({
          type: "set-login-hint",
          authUrl: data.url,
          deviceCode: data.deviceCode,
          instructions: data.instructions,
        });
        dispatch({ type: "set-step", step: "oauth-waiting" });
        stopPolling();
        const fid = data.flowId ?? "";
        const reauthQuery = reauthAccountId ? "&reauth=1" : "";
        const statusUrl = fid
          ? `${apiBase}/api/codex-auth/login-status?flowId=${encodeURIComponent(fid)}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ""}${reauthQuery}`
          : `${apiBase}/api/codex-auth/login-status`;
        const pollSession = new AbortController();
        pollAbortRef.current = pollSession;
        // A hidden tab cannot complete OAuth; the visible make-up tick checks the
        // login status the moment the user returns to the modal.
        pollRef.current = startVisibilityPoll(async () => {
          if (pollInFlightRef.current || pollSession.signal.aborted) return;
          pollInFlightRef.current = true;
          // Bound each tick and abort it when stopPolling/cleanup cancels the session.
          const tickSignal = AbortSignal.any([
            pollSession.signal,
            AbortSignal.timeout(10_000),
          ]);
          try {
            const stRes = await fetch(statusUrl, { signal: tickSignal });
            const st = await readJsonIfOk<{
              status: string;
              error?: string;
              catalogRefreshPending?: unknown;
            }>(stRes);
            if (!aliveRef.current || pollSession.signal.aborted) return;
            if (!st) {
              pollErrorStreakRef.current += 1;
              if (pollErrorStreakRef.current >= 3) {
                dispatch({ type: "set-status-notice", statusNotice: t("codexAuth.oauthStatusRetrying"), statusTone: "warn" });
              }
              return;
            }
            pollErrorStreakRef.current = 0;
            if (manualCodeStateRef.current === "waiting") {
              dispatch({ type: "set-status-notice", statusNotice: t("codexAuth.oauthCodeSubmitted"), statusTone: "ok" });
            } else {
              dispatch({ type: "set-status-notice", statusNotice: "", statusTone: "ok" });
            }
            if (st.status === "done") {
              stopPolling();
              clearManualCode();
              flowRef.current = null;
              dispatch({ type: "set-flow-id", flowId: null });
              if (!aliveRef.current) return;
              onAddedRef.current(codexAccountMutationCompletion(st));
              onCloseRef.current();
            } else if (st.status === "error" || st.status === "expired") {
              stopPolling();
              clearManualCode();
              flowRef.current = null;
              dispatch({ type: "set-flow-id", flowId: null });
              if (aliveRef.current) {
                if (!reauthAccountId) dispatch({ type: "set-step", step: "pick" });
                dispatch({ type: "set-error", error: st.error ?? t("codexAuth.loginFailed") });
              }
            }
          } catch (e) {
            if (!aliveRef.current || pollSession.signal.aborted) return;
            if (e instanceof Error && e.name === "AbortError") return;
            pollErrorStreakRef.current += 1;
            if (pollErrorStreakRef.current >= 3) {
              dispatch({ type: "set-status-notice", statusNotice: t("codexAuth.oauthStatusRetrying"), statusTone: "warn" });
            }
          } finally {
            pollInFlightRef.current = false;
          }
        }, 2000);
        timeoutRef.current = setTimeout(() => {
          if (pollRef.current) {
            clearManualCode();
            void cancelLogin();
            if (aliveRef.current) {
              if (!reauthAccountId) dispatch({ type: "set-step", step: "pick" });
              dispatch({ type: "set-error", error: t("modal.loginTimeout") });
            }
          }
          // A device login is deliberately slow: the operator leaves this
          // machine to enter the code elsewhere. Cancelling at five minutes
          // would abort a grant that is still valid for ten more.
        }, wantsDeviceFlow ? LOGIN_TIMEOUT_DEVICE_MS : LOGIN_TIMEOUT_BROWSER_MS);
      }
      if (data.error && !data.url) dispatch({ type: "set-error", error: data.error });
    } catch (e) {
      if (aliveRef.current && !(e instanceof Error && e.name === "AbortError")) {
        dispatch({ type: "set-error", error: e instanceof Error ? e.message : String(e) });
      }
    }
  }, [apiBase, cancelLogin, clearManualCode, dispatch, reauthAccountId, stopPolling, t]);

  useEffect(() => {
    if (!reauthAccountId) {
      startedReauthRef.current = null;
      return;
    }
    if (startedReauthRef.current === reauthAccountId) return;
    startedReauthRef.current = reauthAccountId;
    void startOAuth();
  }, [reauthAccountId, startOAuth]);

  const submitManualCode = useCallback(async () => {
    const flowId = flowRef.current;
    const input = ui.manualCode.trim();
    if (!flowId || !input || manualCodeBusy || manualCodeWaiting) return;
    dispatch({ type: "set-manual-code-state", manualCodeState: "submitting" });
    dispatch({ type: "set-status-notice", statusNotice: "", statusTone: "ok" });
    try {
      const resp = await fetch(`${apiBase}/api/codex-auth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId, input }),
      });
      if (!aliveRef.current) return;
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string };
        dispatch({ type: "set-error", error: t("prov.pasteFail", { error: data.error ?? resp.statusText }) });
        dispatch({ type: "set-manual-code-state", manualCodeState: "idle" });
        return;
      }
      dispatch({ type: "oauth-code-submitted" });
      dispatch({ type: "set-status-notice", statusNotice: t("codexAuth.oauthCodeSubmitted"), statusTone: "ok" });
      pollErrorStreakRef.current = 0;
    } catch {
      if (aliveRef.current) {
        dispatch({ type: "set-error", error: t("modal.networkError") });
        dispatch({ type: "set-manual-code-state", manualCodeState: "idle" });
      }
    }
  }, [apiBase, dispatch, manualCodeBusy, manualCodeWaiting, t, ui.manualCode]);

  return {
    manualCodeBusy,
    manualCodeWaiting,
    bindCallbacks,
    closeModal,
    startOAuth,
    submitManualCode,
  };
}
