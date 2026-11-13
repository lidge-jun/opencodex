/**
 * Bytes a Remote Link carried, per link, since this process started counting (#3023 measurement).
 *
 * The counters are plain integer additions on the JavaScript thread: no lock, no log line, no
 * timer and no disk, and no request ever scans the book. A book holds at most `MAX_LINKS` links
 * and never more. A new link takes the place of the link idle longest; when every tracked link has a
 * request in flight there is no place, so that request is not measured and counts only in the
 * book-level `untrackedRequests`. Telemetry never refuses or slows a request.
 *
 * Every time a link's counters start from zero (its first request, or its first after the book forgot
 * it) it gets a new `generation` from one monotonic counter per book; a link the book does not hold
 * reads zeros under the generation of the last forgetting. A process restart starts a new book, whose
 * `epoch` is a fresh random value, so the generations of two process lifetimes never compare equal
 * under it. A consumer subtracts two reads only when both their epoch and their generation match.
 * `since` is the wall-clock time of that start, for people; it can repeat or go backward with the
 * clock, so it is never the comparison key.
 *
 * Two books exist. A Child's link transport (`src/client/link-relay-transport.ts`) counts each
 * request-body chunk or buffered body once its socket write completed and each response-body chunk
 * as it is read off the socket, and ends a request only once both its response and its upload have
 * settled; it is complete only when both finished. A write still pending when a request ends is not
 * counted, even if part of it reached the Home, and that request counts as incomplete, so while
 * `incomplete` > 0 `toHomeBytes` is a lower bound of what crossed, and otherwise every request that
 * ended had its body counted in full. A write still in progress counts only once it completes, so a
 * read taken mid-write lags (it can show `incomplete` 0 while the Home already holds a prefix) and a
 * delta between two reads measures completed writes. A write completes once the operating system
 * accepts it, and how much it accepts at once is the OS's choice: Linux and macOS accept what fits
 * their send buffer, while Windows can take a whole large nonblocking send into its buffer (it took
 * 48 MiB bodies at once on CI), so a body can count in full, and its upload as finished, as soon as
 * it is written, even when the Home reads only part of it. A Home's hub-link listener (`src/server/index/link-relay-sessions.ts`) counts the
 * response-body bytes it streams back and, for requests, each declared Content-Length (it cannot
 * wrap Bun's native request without losing its identity); a request body without one is counted in
 * `toHomeUncounted` instead. Neither counts HTTP headers, the relay-auth challenge, SSH or TCP
 * framing, or what any relay between the machines adds.
 */
export const MAX_LINKS = 256;

export interface LinkTrafficCounters {
  /** When this link's counters last started from zero (ISO). For people; compare on `generation`. */
  since: string;
  /** Random per book: a new value after every process restart. Compare two reads only when it matches. */
  epoch: string;
  /** Changes every time this link's counters start from zero within one epoch; compare two reads only when epoch and generation match. */
  generation: number;
  /** Relayed requests on this link. */
  requests: number;
  /**
   * Of those, requests that ended before their response body did (abort, cancel, error, refusal),
   * and on a Child also requests whose request-body upload did not finish.
   */
  incomplete: number;
  /**
   * Request-body bytes toward the Home. Child: bytes whose socket write completed, a lower bound
   * while `incomplete` > 0. Home: the declared Content-Length of each request.
   */
  toHomeBytes: number;
  /** Response-body bytes from the Home. */
  fromHomeBytes: number;
  /** How toHomeBytes was measured: socket writes completed (Child) or declared Content-Length (Home). */
  toHomeSource: "relayed" | "content-length";
  /** Requests whose body bytes toHomeBytes could not include (a Home request without Content-Length). */
  toHomeUncounted: number;
  /** Book-level, the same on every row: requests on any link that were not measured because the book was full. */
  untrackedRequests: number;
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
  /** This link's counters; zeros for a link the book does not hold. */
  snapshot(linkId: string): LinkTrafficCounters;
  /** How many links the book holds now; never more than MAX_LINKS. */
  linkCount(): number;
}

interface Entry {
  since: string;
  generation: number;
  inFlight: number;
  requests: number; incomplete: number; toHomeBytes: number; fromHomeBytes: number; toHomeUncounted: number;
}

function addable(bytes: number): number {
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
}

const UNMEASURED: LinkTrafficFlow = { toHome() {}, fromHome() {}, uncounted() {}, end() {} };

function randomEpoch(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function createLinkTrafficBook(
  toHomeSource: LinkTrafficCounters["toHomeSource"],
  deps: { now?: () => number } = {},
): LinkTrafficBook {
  const now = deps.now ?? Date.now;
  const epoch = randomEpoch();
  const started = new Date(now()).toISOString();
  let sequence = 0;
  let forgotten = { since: started, generation: 0 };
  let untrackedRequests = 0;
  const entries = new Map<string, Entry>();
  // Links with no request in flight, least recently active first: the next to forget is always the
  // first key, so making room is O(1) and never scans the book.
  const idle = new Map<string, Entry>();
  const room = (): boolean => {
    if (entries.size < MAX_LINKS) return true;
    const oldest = idle.keys().next();
    if (oldest.done) return false;
    entries.delete(oldest.value);
    idle.delete(oldest.value);
    forgotten = { since: new Date(now()).toISOString(), generation: ++sequence };
    return true;
  };
  return {
    begin(linkId) {
      let entry = entries.get(linkId);
      if (!entry) {
        if (!room()) { untrackedRequests += 1; return UNMEASURED; }
        entry = { since: new Date(now()).toISOString(), generation: ++sequence, inFlight: 0,
          requests: 0, incomplete: 0, toHomeBytes: 0, fromHomeBytes: 0, toHomeUncounted: 0 };
        entries.set(linkId, entry);
      }
      const counted = entry;
      counted.requests += 1;
      counted.inFlight += 1;
      idle.delete(linkId);
      let ended = false;
      return {
        toHome(bytes) { counted.toHomeBytes += addable(bytes); },
        fromHome(bytes) { counted.fromHomeBytes += addable(bytes); },
        uncounted() { counted.toHomeUncounted += 1; },
        end(complete) {
          if (ended) return;
          ended = true;
          if (!complete) counted.incomplete += 1;
          counted.inFlight -= 1;
          if (counted.inFlight === 0) idle.set(linkId, counted);
        },
      };
    },
    snapshot(linkId) {
      const entry = entries.get(linkId);
      return {
        since: entry?.since ?? forgotten.since,
        epoch,
        generation: entry?.generation ?? forgotten.generation,
        requests: entry?.requests ?? 0,
        incomplete: entry?.incomplete ?? 0,
        toHomeBytes: entry?.toHomeBytes ?? 0,
        fromHomeBytes: entry?.fromHomeBytes ?? 0,
        toHomeSource,
        toHomeUncounted: entry?.toHomeUncounted ?? 0,
        untrackedRequests,
      };
    },
    linkCount: () => entries.size,
  };
}

/** The Child relay's book for this process. A Home's listener owns its own. */
export const childLinkTraffic: LinkTrafficBook = createLinkTrafficBook("relayed");
