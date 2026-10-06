import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { SESSION_UNAVAILABLE_EVENT } from "./api";

export type DisclosureResetReason = "lifecycle" | "session" | "pairing";

/** Displayed secrets belong to one visible, active shared-session lifetime.
 * Responses and clipboard callbacks from an earlier lifetime cannot restore them. */
export function useKeyDisclosure(
  apiBase: string,
  active: boolean,
  clear: (reason: DisclosureResetReason) => void,
) {
  const generation = useRef(0);
  const mounted = useRef(false);
  const invalidate = useCallback((reason: DisclosureResetReason = "pairing") => {
    generation.current++;
    clear(reason);
  }, [clear]);
  const expire = useCallback(() => {
    mounted.current = false;
    generation.current++;
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    invalidate("lifecycle");
    return expire;
  }, [apiBase, active, invalidate, expire]);

  useEffect(() => {
    const unavailable = (event: Event) => {
      if ((event as CustomEvent<{ plane?: string }>).detail?.plane === "shared") invalidate("session");
    };
    const hidden = () => { if (document.visibilityState === "hidden") invalidate("lifecycle"); };
    window.addEventListener(SESSION_UNAVAILABLE_EVENT, unavailable);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener(SESSION_UNAVAILABLE_EVENT, unavailable);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [invalidate]);

  const current = useCallback((expected: number) =>
    mounted.current && active && document.visibilityState !== "hidden" && generation.current === expected, [active]);
  return { generation, invalidate, current };
}
