import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AppServerStateOutcome } from "../codex-app-server-state";

/** Keep keyboard focus on the same action when its stale banner replaces the header. */
export function useModelsReloadFocus() {
  const [state, setState] = useState<AppServerStateOutcome["state"]>(null);
  const headRef = useRef<HTMLButtonElement>(null);
  const bannerRef = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ from: HTMLButtonElement; to: "head" | "banner" } | null>(null);

  const setAppServerState = useCallback((next: AppServerStateOutcome["state"]) => {
    const from = next === "stale" ? headRef.current : bannerRef.current;
    pending.current = from && from.ownerDocument.activeElement === from
      ? { from, to: next === "stale" ? "banner" : "head" } : null;
    setState(next);
  }, []);

  useLayoutEffect(() => {
    const transfer = pending.current;
    pending.current = null;
    if (!transfer) return;
    const active = transfer.from.ownerDocument.activeElement;
    // Do not override a deliberate focus move to another control before commit.
    if (active !== transfer.from && active !== transfer.from.ownerDocument.body) return;
    const target = transfer.to === "head" ? headRef.current : bannerRef.current;
    if (target && !target.disabled) target.focus();
  }, [state]);

  return [state, setAppServerState, headRef, bannerRef] as const;
}
