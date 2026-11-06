import { useCallback, useEffect } from "react";
import { denyUsageSession, usageSessionSnapshot, USAGE_SOURCE_INVENTORY_CHANGED, sourceInventoryEventMatches } from "../../api";
import { useDataSurface } from "../../data-surface";
import { readUsageResponseJson } from "../../usage-summary-resource";
import { matchesSource, noStore, sourceQuery, type SourceFilter } from "./usage-source";
import { isUsageReport } from "./usage-validation";
import type { Range, UsageResponse } from "./usage-model";

export class UsageWindowMismatchError extends Error {}
export class UsageAccessDeniedError extends Error {}

type Session = ReturnType<typeof usageSessionSnapshot>;
export function useUsageReport(apiBase: string, range: Range, filter: SourceFilter | null, session: Session, since?: number, until?: number) {
  const filterKey = JSON.stringify(filter);
  const key = `ocx.usage.resource:${JSON.stringify([apiBase, range, filter, since, until, session.generation])}`;
  const volatile = filter?.device.kind === "unconfigured";
  const load = useCallback(async (signal: AbortSignal): Promise<UsageResponse> => {
    const requested = JSON.parse(filterKey) as SourceFilter | null;
    if (!requested) throw new UsageWindowMismatchError();
    const query = sourceQuery(requested);
    query.set("range", range); query.set("surface", "all");
    if (since !== undefined && until !== undefined) { query.set("since", String(since)); query.set("until", String(until)); }
    const response = await fetch(`${apiBase}/api/usage?${query}`, { signal, ...(volatile ? { cache: "no-store" as const } : {}) });
    if (signal.aborted || usageSessionSnapshot().generation !== session.generation) throw new UsageWindowMismatchError();
    if (response.status === 401) { denyUsageSession(session.generation); throw new UsageWindowMismatchError(); }
    if (response.status === 403) throw new UsageAccessDeniedError();
    const next = await readUsageResponseJson<unknown>(response);
    if (signal.aborted || usageSessionSnapshot().generation !== session.generation || !isUsageReport(next)
      || !matchesSource(next.sourceFilter, requested) || next.range !== range || next.surface !== "all" || (volatile && !noStore(response))
      || (since !== undefined && (next.customWindow !== true || next.since !== since || next.until !== until))) throw new UsageWindowMismatchError();
    return next;
  }, [apiBase, filterKey, range, session.generation, since, until, volatile]);
  const resource = useDataSurface<UsageResponse>(key, [key], load, { isEmpty: () => false, enabled: !session.blocked });
  const refresh = resource.refresh;
  const refreshing = resource.state.refreshing;
  useEffect(() => {
    if (!volatile || session.blocked || refreshing) return;
    const timer = setTimeout(() => refresh({ forceLoading: true }), 15_000);
    return () => clearTimeout(timer);
  }, [volatile, session.blocked, refreshing, resource.state.kind, refresh]);
  useEffect(() => {
    if (!volatile || session.blocked) return;
    const reload = () => refresh({ forceLoading: true });
    const changed = (event: Event) => { if (sourceInventoryEventMatches(event, apiBase)) reload(); };
    window.addEventListener("focus", reload); window.addEventListener(USAGE_SOURCE_INVENTORY_CHANGED, changed);
    return () => { window.removeEventListener("focus", reload); window.removeEventListener(USAGE_SOURCE_INVENTORY_CHANGED, changed); };
  }, [volatile, session.blocked, apiBase, refresh]);
  const invalid = resource.state.error instanceof UsageWindowMismatchError || resource.state.error instanceof UsageAccessDeniedError;
  const rejected = session.blocked || (invalid && !resource.state.refreshing);
  const hide = rejected || invalid || (volatile && (resource.state.refreshing || resource.state.showError));
  const data = hide ? undefined : resource.state.data;
  const state = rejected ? { ...resource.state, data: undefined, kind: "failed-cold" as const, showSkeleton: false, showError: true }
    : (volatile || invalid) && hide ? { ...resource.state, data: undefined, kind: resource.state.showError && !resource.state.refreshing ? "failed-cold" as const : "cold" as const, showSkeleton: resource.state.refreshing } : resource.state;
  return { ...resource, data, state };
}
