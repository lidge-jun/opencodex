import { linkRouteAllowed } from "./routes";

/** A link with no relayed model turn for this long reads as idle (D5). */
export const DEFAULT_IDLE_AFTER_MS = 600_000;

export interface LinkActivitySnapshot { inFlight: number; lastDataEndAt: number | null; observedSince: number }

export interface LinkActivity {
  /**
   * Start one relayed model request. null = a legacy key admission without a relay session; it counts against every
   * link. The returned end is idempotent and stamps lastDataEndAt.
   */
  begin(linkId: string | null): () => void;
  snapshot(linkId: string, now: number): LinkActivitySnapshot;
}

/** Model traffic only: a POST the data-plane table admits, except token counting. */
export function linkActivityCounts(url: URL, req: Request): boolean {
  return req.method === "POST" && url.pathname !== "/v1/messages/count_tokens" && linkRouteAllowed(url, req);
}

export function isLinkIdle(snapshot: LinkActivitySnapshot, now: number, idleAfterMs = DEFAULT_IDLE_AFTER_MS): boolean {
  return snapshot.inFlight === 0 && now - (snapshot.lastDataEndAt ?? snapshot.observedSince) >= idleAfterMs;
}

interface ActivityEntry { inFlight: number; lastDataEndAt: number | null }

/** In memory, no timers. One small entry per link id that ever relayed; links are bounded by links.json. */
export function createLinkActivity(deps: { now?: () => number } = {}): LinkActivity {
  const now = deps.now ?? Date.now;
  const observedSince = now();
  const perLink = new Map<string, ActivityEntry>();
  const legacy: ActivityEntry = { inFlight: 0, lastDataEndAt: null };
  const entryFor = (linkId: string): ActivityEntry => {
    let entry = perLink.get(linkId);
    if (!entry) { entry = { inFlight: 0, lastDataEndAt: null }; perLink.set(linkId, entry); }
    return entry;
  };
  return {
    begin(linkId) {
      const entry = linkId === null ? legacy : entryFor(linkId);
      entry.inFlight += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        entry.inFlight -= 1;
        entry.lastDataEndAt = now();
      };
    },
    snapshot(linkId) {
      const entry = perLink.get(linkId);
      const ends = [entry?.lastDataEndAt ?? null, legacy.lastDataEndAt].filter((value): value is number => value !== null);
      return { inFlight: (entry?.inFlight ?? 0) + legacy.inFlight, lastDataEndAt: ends.length ? Math.max(...ends) : null, observedSince };
    },
  };
}
