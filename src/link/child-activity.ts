import { linkRouteAllowed } from "./routes";

/** A link with no relayed model turn for this long reads as idle (D5). */
export const DEFAULT_IDLE_AFTER_MS = 600_000;

const DELIVERY_WINDOW_MS = 120_000;
export const LINK_DELIVERY_SAMPLE_LIMIT = 5;
export const LINK_DELIVERY_DEGRADED_THRESHOLD = 3;

export interface LinkActivitySnapshot {
  inFlight: number;
  lastDataEndAt: number | null;
  observedSince: number;
  httpDelivery?: { generation: string; recentSettled: number; recentInterruptions: number };
}

/** One Remote Link WebSocket in the book: it counts in flight while busy (design T4 section 5). */
export interface LinkSocketActivity {
  busy(value: boolean): void;
  end(): void;
}

export interface LinkActivity {
  /**
   * Start one relayed model request. null = a legacy key admission without a relay session; it counts against every
   * link. The returned end is idempotent and stamps lastDataEndAt.
   */
  begin(linkId: string | null): () => void;
  /** One model HTTP request admitted on an authenticated relay session for this generation. */
  beginHttpDelivery(linkId: string, generation: string): (complete: boolean) => void;
  /** A link WebSocket; busy while a turn runs or client work is pending. Idempotent end. */
  beginSocket(linkId: string): LinkSocketActivity;
  snapshot(linkId: string, now: number): LinkActivitySnapshot;
}

/** Model traffic only: a POST the data-plane table admits, except token counting. */
export function linkActivityCounts(url: URL, req: Request): boolean {
  return req.method === "POST" && url.pathname !== "/v1/messages/count_tokens" && linkRouteAllowed(url, req);
}

export function isLinkIdle(snapshot: LinkActivitySnapshot, now: number, idleAfterMs = DEFAULT_IDLE_AFTER_MS): boolean {
  return snapshot.inFlight === 0 && now - (snapshot.lastDataEndAt ?? snapshot.observedSince) >= idleAfterMs;
}

interface HttpDelivery {
  generation: string;
  settled: Array<{ at: number; complete: boolean }>;
}

interface ActivityEntry { inFlight: number; lastDataEndAt: number | null; httpDelivery?: HttpDelivery }

/** In memory, no timers. One small entry per link id that ever relayed; links are bounded by links.json. */
/** held: durable link WebSocket holds (src/link/ws-activity-holds.ts), counted as in flight. */
export function createLinkActivity(deps: { now?: () => number; held?: (linkId: string) => number } = {}): LinkActivity {
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
    beginHttpDelivery(linkId, generation) {
      const entry = entryFor(linkId);
      if (entry.httpDelivery?.generation !== generation) entry.httpDelivery = { generation, settled: [] };
      const delivery = entry.httpDelivery;
      let ended = false;
      return complete => {
        if (ended || entry.httpDelivery !== delivery) return;
        ended = true;
        delivery.settled.push({ at: now(), complete });
        if (delivery.settled.length > LINK_DELIVERY_SAMPLE_LIMIT) delivery.settled.shift();
      };
    },
    beginSocket(linkId) {
      const entry = entryFor(linkId);
      let counted = false;
      let ended = false;
      const set = (value: boolean): void => {
        if (ended || value === counted) return;
        counted = value;
        entry.inFlight += value ? 1 : -1;
        if (!value) entry.lastDataEndAt = now();
      };
      return {
        busy: set,
        end() { set(false); ended = true; },
      };
    },
    snapshot(linkId, at) {
      const entry = perLink.get(linkId);
      const ends = [entry?.lastDataEndAt ?? null, legacy.lastDataEndAt].filter((value): value is number => value !== null);
      let held = 0;
      try { held = deps.held?.(linkId) ?? 0; } catch { held = 1; }
      const snapshot: LinkActivitySnapshot = {
        inFlight: (entry?.inFlight ?? 0) + legacy.inFlight + held,
        lastDataEndAt: ends.length ? Math.max(...ends) : null,
        observedSince,
      };
      const delivery = entry?.httpDelivery;
      if (delivery) {
        const recent = delivery.settled.filter(sample => at >= sample.at && at - sample.at < DELIVERY_WINDOW_MS);
        snapshot.httpDelivery = {
          generation: delivery.generation, recentSettled: recent.length, recentInterruptions: recent.filter(sample => !sample.complete).length,
        };
      }
      return snapshot;
    },
  };
}
