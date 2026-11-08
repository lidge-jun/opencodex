import { scanUsageLedgerCooperatively } from "../../usage/ledger-scanner";
import { currentUsageLogRevision, usageLogIdentityKey, usageLogRevisionKey } from "../../usage/log";
import { createSourceFacetAccumulator } from "../../usage/source-facets";
import { snapshotConfiguredKeyIds, type UsageSourceFilter } from "../../usage/source-filter";
import { rangeWindow } from "../../usage/summary";

const MAX_FLIGHTS = 4;
const flights = new Map<string, Promise<SourceFacets>>();

export class SourceFacetsBusyError extends Error {}
type SourceFacets = ReturnType<ReturnType<typeof createSourceFacetAccumulator>["snapshot"]> & {
  sourceFilter: UsageSourceFilter;
  window: { since: number; until: number; timeZone: string };
  usageIncomplete: boolean;
};

/** Single-flight identical requests; never retain arbitrary historical key IDs. */
export async function getUsageSourceFacets(filter: UsageSourceFilter, configuredIds: readonly string[]): Promise<SourceFacets> {
  const ids = snapshotConfiguredKeyIds(configuredIds);
  const captured: UsageSourceFilter = { client: filter.client, device: { ...filter.device } };
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const revision = currentUsageLogRevision();
  const key = JSON.stringify([captured, ids, timeZone, usageLogIdentityKey(revision), usageLogRevisionKey(revision)]);
  const existing = flights.get(key);
  if (existing) return existing;
  if (flights.size >= MAX_FLIGHTS) throw new SourceFacetsBusyError("usage facets busy");
  const flight = (async () => {
    const until = Date.now();
    const since = rangeWindow("30d", until).since!;
    const accumulator = createSourceFacetAccumulator(captured, ids, { since, until });
    const scan = await scanUsageLedgerCooperatively({ onEntry: row => accumulator.add(row) });
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== timeZone) throw new Error("time zone changed");
    return { ...accumulator.snapshot(), sourceFilter: captured, window: { since, until, timeZone },
      usageIncomplete: scan.oversizedRows > 0 || scan.invalidRows > 0 };
  })();
  flights.set(key, flight);
  try { return await flight; } finally { if (flights.get(key) === flight) flights.delete(key); }
}
