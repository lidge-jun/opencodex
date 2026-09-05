import { useCallback, useEffect, useRef, useState } from "react";
import type { ProvidersConfigRefreshResult } from "./use-providers-fetch";

interface NoticeContext { provider: string; providers: readonly string[]; apiBase: string; initialRegistration: boolean; catalogRefreshPending: boolean }
interface Notice { context: NoticeContext; loading: boolean; failed: boolean }

/** Render-local registration feedback; the existing workspace owns model discovery. */
export function useProviderModelsNotice(apiBase: string, refreshConfig: () => Promise<ProvidersConfigRefreshResult>) {
  const [state, setState] = useState<{ apiBase: string; notice: Notice | null }>({ apiBase, notice: null });
  if (state.apiBase !== apiBase) setState({ apiBase, notice: null });
  const active = useRef<NoticeContext | null>(null);
  useEffect(() => () => { active.current = null; }, [apiBase]);
  const open = useCallback((provider: string | readonly string[], initialRegistration: boolean, catalogRefreshPending = false) => {
    const providers = typeof provider === "string" ? [provider] : provider;
    const context = { provider: providers.join(", "), providers, apiBase, initialRegistration: initialRegistration && providers.length === 1, catalogRefreshPending };
    active.current = context;
    setState({ apiBase, notice: { context, loading: true, failed: false } });
  }, [apiBase]);
  const close = useCallback(() => { active.current = null; setState(current => ({ ...current, notice: null })); }, []);
  const modelsSettled = useCallback((ok: boolean) => {
    const context = active.current;
    if (!context || context.apiBase !== apiBase) return;
    void refreshConfig().then(async result => {
      // One newer config request may supersede this one; retry once, never poll.
      if (result === "superseded" && active.current === context) result = await refreshConfig();
      if (active.current === context) setState(current => current.apiBase === context.apiBase
        ? { ...current, notice: { context, loading: false, failed: !ok || result !== "applied" } } : current);
    }).catch(() => {
      if (active.current === context) setState(current => current.apiBase === context.apiBase
        ? { ...current, notice: { context, loading: false, failed: true } } : current);
    });
  }, [apiBase, refreshConfig]);
  return { notice: state.apiBase === apiBase ? state.notice : null, open, close, modelsSettled };
}
