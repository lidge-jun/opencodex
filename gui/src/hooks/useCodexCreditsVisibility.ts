import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createBoundedFetch } from "../bounded-fetch";
import type { TFn } from "../i18n/shared";
import type { NoticeTone } from "../ui";

/** Display preference only. A saved preference survives a failed account reload. */
export function useCodexCreditsVisibility(
  apiBase: string,
  reloadAccounts: (refreshQuota?: boolean) => Promise<boolean>,
  showActionFeedback: (text: string, tone?: NoticeTone) => void,
  t: TFn,
  settingsRead?: {
    revision: number;
    /** Share the parsed initial GET with the page's other settings consumer. */
    onRead: (read: Promise<unknown>, signal: AbortSignal) => void;
  },
) {
  const [state, setState] = useState<{ apiBase: string; visible?: boolean; busy: boolean }>({ apiBase, busy: false });
  const scopeRef = useRef<AbortController | null>(null);
  const mutationRevisionRef = useRef(0);
  const observeSettingsRead = useEffectEvent((read: Promise<unknown>, signal: AbortSignal) => {
    settingsRead?.onRead(read, signal);
  });
  const readRevision = settingsRead?.revision ?? 0;
  const mutationRef = useRef<AbortController | null>(null);
  // Reset at the prop boundary, including A → B → A before any new settings read.
  if (state.apiBase !== apiBase) setState({ apiBase, busy: false });
  const visible = state.apiBase === apiBase ? state.visible : undefined;
  const busy = state.apiBase === apiBase && state.busy;

  useEffect(() => {
    const scope = new AbortController();
    scopeRef.current = scope;
    return () => {
      scope.abort();
      mutationRef.current?.abort();
      mutationRef.current = null;
    };
  }, [apiBase]);

  useEffect(() => {
    const abort = new AbortController();
    const bounded = createBoundedFetch(15_000);
    const startedMutationRevision = mutationRevisionRef.current;
    const read = fetch(`${apiBase}/api/settings`, { signal: bounded.signal })
      .then(response => { if (!response.ok) throw new Error("read"); return response.json() as Promise<unknown>; });
    observeSettingsRead(read, abort.signal);
    read.then(payload => {
      if (abort.signal.aborted || mutationRef.current || mutationRevisionRef.current !== startedMutationRevision) return;
      if (!payload || typeof payload !== "object" || !("showCodexCredits" in payload)
        || typeof payload.showCodexCredits !== "boolean") return;
      setState({ apiBase, visible: payload.showCodexCredits, busy: false });
    })
      // A failed read leaves the switch unrendered instead of guessing its state.
      .catch(() => {})
      .finally(() => bounded.clear());
    return () => {
      abort.abort();
      bounded.controller.abort();
      bounded.clear();
    };
  }, [apiBase, readRevision]);

  const toggle = async () => {
    const scope = scopeRef.current;
    if (visible === undefined || busy || mutationRef.current || !scope || scope.signal.aborted) return;
    const mutation = new AbortController();
    mutationRef.current = mutation;
    // Bounded like the read: a relay that accepts the PUT and never answers must not leave the
    // switch disabled with an unreconciled optimistic value.
    const write = createBoundedFetch(15_000);
    const abortWrite = () => write.controller.abort();
    mutation.signal.addEventListener("abort", abortWrite, { once: true });
    const current = () => scopeRef.current === scope && !scope.signal.aborted;
    const requested = !visible;
    mutationRevisionRef.current += 1;
    setState({ apiBase, visible: requested, busy: true });
    try {
      let confirmed: boolean;
      try {
        const response = await fetch(`${apiBase}/api/settings`, {
          method: "PUT", headers: { "content-type": "application/json" }, signal: write.signal,
          body: JSON.stringify({ showCodexCredits: requested }),
        });
        if (!response.ok) throw new Error("save");
        const payload = await response.json() as { showCodexCredits?: unknown } | null;
        if (typeof payload?.showCodexCredits !== "boolean") throw new Error("shape");
        confirmed = payload.showCodexCredits;
      } catch {
        if (current()) {
          setState({ apiBase, visible, busy: false });
          showActionFeedback(t("codexAuth.creditsToggleFailed"), "err");
        }
        return;
      }
      if (!current()) return;
      setState({ apiBase, visible: confirmed, busy: true });
      showActionFeedback(t(confirmed ? "codexAuth.creditsShown" : "codexAuth.creditsHidden"), "ok");
      try {
        const ok = await reloadAccounts(true);
        if (current() && !ok) showActionFeedback(t("codexAuth.quotaRefreshFailed"), "err");
      } catch {
        if (current()) showActionFeedback(t("codexAuth.quotaRefreshFailed"), "err");
      }
    } finally {
      write.clear();
      mutation.signal.removeEventListener("abort", abortWrite);
      if (current()) {
        mutationRef.current = null;
        setState(previous => ({ ...previous, busy: false }));
      }
    }
  };
  return { visible, busy, toggle };
}
