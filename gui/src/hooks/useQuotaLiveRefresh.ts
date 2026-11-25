import { useEffect, useLayoutEffect, useRef } from "react";
import { useQuotaLiveRefreshPref } from "../quota-live-refresh-pref";
import { startVisibilityPoll } from "../visibility-poll";

/**
 * Run `tick` on the viewer's "Live quota updates" cadence (quota-live-refresh-pref.ts).
 *
 * Off holds no timer at all, so a surface keeps exactly the refresh behavior it had before.
 * The visibility poll owns the hidden rule: no timer while the dashboard is hidden, one make-up
 * tick when it is shown again. The tick itself must be a non-forced re-read and must decide
 * whether it may run now (a read or mutation already in flight); this hook only schedules it.
 */
export function useQuotaLiveRefresh(tick: () => void): void {
  const { enabled, intervalSeconds } = useQuotaLiveRefreshPref();
  const tickRef = useRef(tick);
  useLayoutEffect(() => { tickRef.current = tick; });
  useEffect(() => {
    if (!enabled) return;
    return startVisibilityPoll(() => tickRef.current(), intervalSeconds * 1000);
  }, [enabled, intervalSeconds]);
}
