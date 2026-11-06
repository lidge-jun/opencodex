import { useEffect, useRef, useState } from "react";
import { USAGE_SOURCE_INVENTORY_CHANGED, sourceInventoryEventMatches } from "../../api";
import { readSessionListCache, writeSessionListCache } from "../../session-list-cache";
import { readUsageResponseJson } from "../../usage-summary-resource";
import { matchesSource, noStore, sourceQuery, type SourceFilter } from "./usage-source";
import type { Range, UsageResponse } from "./usage-model";

const held = new Map<string, UsageResponse>();

export class UsageWindowMismatchError extends Error {}

export function useUsageReport(apiBase: string, range: Range, filter: SourceFilter | null, since?: number, until?: number) {
  const filterKey = JSON.stringify(filter);
  const key = `ocx.usage.v2:${JSON.stringify([apiBase, range, filter, since, until])}`;
  const volatile = filter?.device.kind === "unconfigured";
  const cacheable = !!filter && !volatile && since === undefined;
  const candidate = cacheable ? held.get(key) ?? readSessionListCache<UsageResponse>(key) ?? undefined : undefined;
  const cached = candidate && filter && matchesSource(candidate.sourceFilter, filter) ? candidate : undefined;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: UsageResponse; error?: unknown; loading: boolean }>({ key: "", loading: true });
  const serial = useRef(0);


  useEffect(() => {
    const serialRef = serial;
    const requested = JSON.parse(filterKey) as SourceFilter | null;
    const initial = cacheable ? held.get(key) ?? readSessionListCache<UsageResponse>(key) ?? undefined : undefined;
    const seed = initial && requested && matchesSource(initial.sourceFilter, requested) ? initial : undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const run = async () => {
      const id = ++serialRef.current;
      controller?.abort();
      controller = new AbortController();
      setResult({ key, data: seed, loading: true });
      try {
        if (!requested) throw new UsageWindowMismatchError();
        const query = sourceQuery(requested);
        query.set("range", range);
        query.set("surface", "all");
        if (since !== undefined && until !== undefined) {
          query.set("since", String(since));
          query.set("until", String(until));
        }
        const response = await fetch(`${apiBase}/api/usage?${query}`, { signal: controller.signal, ...(volatile ? { cache: "no-store" as const } : {}) });
        const next = await readUsageResponseJson<UsageResponse>(response);
        if (!matchesSource(next.sourceFilter, requested) || next.range !== range || next.surface !== "all" || (volatile && !noStore(response))
          || (since !== undefined && (next.customWindow !== true || next.since !== since || next.until !== until))) {
          throw new UsageWindowMismatchError();
        }
        if (disposed || id !== serialRef.current) return;
        if (cacheable) { held.set(key, next); writeSessionListCache(key, next); }
        setResult({ key, data: next, loading: false });
      } catch (error) {
        if (disposed || id !== serialRef.current) return;
        setResult({ key, data: error instanceof UsageWindowMismatchError ? undefined : seed, error, loading: false });
      } finally {
        if (!disposed && id === serialRef.current && volatile) timer = setTimeout(run, 15_000);
      }
    };
    void run();
    const focus = () => { if (timer) clearTimeout(timer); void run(); };
    const inventoryChanged = (event: Event) => { if (sourceInventoryEventMatches(event, apiBase)) focus(); };
    if (volatile) {
      window.addEventListener("focus", focus);
      window.addEventListener(USAGE_SOURCE_INVENTORY_CHANGED, inventoryChanged);
    }
    return () => { disposed = true; ++serialRef.current; controller?.abort(); if (timer) clearTimeout(timer); window.removeEventListener("focus", focus); window.removeEventListener(USAGE_SOURCE_INVENTORY_CHANGED, inventoryChanged); };
  }, [apiBase, range, filterKey, key, since, until, volatile, attempt, cacheable]);
  const current = result.key === key ? result : { key, data: cached, loading: true };
  return {
    data: current.data,
    state: { data: current.data, error: current.error, showSkeleton: current.loading && !current.data,
      kind: current.error ? (current.data ? "failed-with-stale" : "failed-cold") : current.loading ? "cold" : "ready-populated", showError: !!current.error },
    refresh: () => setAttempt(value => value + 1),
  };
}
