/**
 * Bytes a Remote Link carried, per link, since this process started counting (#3023 measurement).
 *
 * The counters are plain integer additions on the JavaScript thread: no lock, no log line, no
 * timer and no disk. A book holds at most `MAX_LINKS` links and forgets the oldest beyond that;
 * links are bounded by links.json anyway. A process restart starts a new book, and `since` says
 * when the current one began, so a reader computes a rate from two reads of the same `since`.
 *
 * Two books exist. A Child's relay (`src/client/link-relay.ts`) counts every request-body byte it
 * hands to the link transport and every response-body byte it reads back, so its numbers are the
 * bodies that crossed the link, aborted requests included. A Home's hub-link listener
 * (`src/server/index/link-relay-sessions.ts`) counts the response-body bytes it streams back
 * exactly, but cannot wrap Bun's native request without losing its identity, so its request side
 * is each request's declared Content-Length; a request body without one is counted in
 * `toHomeUncounted` instead. Neither counts HTTP headers, the relay-auth challenge, SSH or TCP
 * framing, or what any relay between the machines adds.
 */
export const MAX_LINKS = 256;

export interface LinkTrafficCounters {
  /** When this book began counting (ISO). Every counter below covers the time since then. */
  since: string;
  /** Relayed requests on this link. */
  requests: number;
  /** Of those, requests that ended before their response body did (abort, cancel, error, refusal). */
  incomplete: number;
  /** Request-body bytes toward the Home. */
  toHomeBytes: number;
  /** Response-body bytes from the Home. */
  fromHomeBytes: number;
  /** How toHomeBytes was measured: bytes relayed (Child) or declared Content-Length (Home). */
  toHomeSource: "relayed" | "content-length";
  /** Requests whose body bytes toHomeBytes could not include (a Home request without Content-Length). */
  toHomeUncounted: number;
}

/** One relayed request. Every method is cheap; `end` is idempotent and decides only `incomplete`. */
export interface LinkTrafficFlow {
  toHome(bytes: number): void;
  fromHome(bytes: number): void;
  uncounted(): void;
  /** complete = the response body reached its end (or there was none to read). */
  end(complete: boolean): void;
}

export interface LinkTrafficBook {
  /** Start counting one request on `linkId`. */
  begin(linkId: string): LinkTrafficFlow;
  /** This link's counters; zeros for a link that carried nothing. */
  snapshot(linkId: string): LinkTrafficCounters;
}

interface Entry { requests: number; incomplete: number; toHomeBytes: number; fromHomeBytes: number; toHomeUncounted: number }

function addable(bytes: number): number {
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
}

export function createLinkTrafficBook(
  toHomeSource: LinkTrafficCounters["toHomeSource"],
  deps: { now?: () => number } = {},
): LinkTrafficBook {
  const since = new Date((deps.now ?? Date.now)()).toISOString();
  const entries = new Map<string, Entry>();
  const entryFor = (linkId: string): Entry => {
    let entry = entries.get(linkId);
    if (!entry) {
      entry = { requests: 0, incomplete: 0, toHomeBytes: 0, fromHomeBytes: 0, toHomeUncounted: 0 };
      entries.set(linkId, entry);
      if (entries.size > MAX_LINKS) entries.delete(entries.keys().next().value!);
    }
    return entry;
  };
  return {
    begin(linkId) {
      const entry = entryFor(linkId);
      entry.requests += 1;
      let ended = false;
      return {
        toHome(bytes) { entry.toHomeBytes += addable(bytes); },
        fromHome(bytes) { entry.fromHomeBytes += addable(bytes); },
        uncounted() { entry.toHomeUncounted += 1; },
        end(complete) {
          if (ended) return;
          ended = true;
          if (!complete) entry.incomplete += 1;
        },
      };
    },
    snapshot(linkId) {
      const entry = entries.get(linkId);
      return {
        since,
        requests: entry?.requests ?? 0,
        incomplete: entry?.incomplete ?? 0,
        toHomeBytes: entry?.toHomeBytes ?? 0,
        fromHomeBytes: entry?.fromHomeBytes ?? 0,
        toHomeSource,
        toHomeUncounted: entry?.toHomeUncounted ?? 0,
      };
    },
  };
}

/** The Child relay's book for this process. A Home's listener owns its own. */
export const childLinkTraffic: LinkTrafficBook = createLinkTrafficBook("relayed");
