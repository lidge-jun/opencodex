/**
 * Upstream call ids created through the native voice call-create path (`handleLive`).
 *
 * A sideband join names only a call id, and two kinds of call reach the same join routes. A call
 * this process created was negotiated under the account the Pool selected, and its join must stay
 * on that account (openai/codex #35830; thread affinity carries it). A call the client created
 * itself — ChatGPT voice handing a call to a Codex thread, or Codex Desktop when its renderer owns
 * the call — belongs to the caller's own ChatGPT login and arrives as a V3 `existingCall` join with
 * no create on this proxy. Membership here is what tells the two apart.
 *
 * Ids only: no account, credential, model, or caller is stored. Process-local and bounded, so a
 * restart, the TTL, or eviction past capacity turns a created call into an unknown one; a later
 * rejoin is then authenticated as the caller (see `resolveLiveRelay`).
 */
export const NATIVE_LIVE_CALL_TTL_MS = 6 * 60 * 60_000;
export const MAX_NATIVE_LIVE_CALLS = 1024;
const MAX_LOCATION_LENGTH = 4096;
const MAX_CALL_ID_LENGTH = 128;
const RTC_CALL_ID_RE = /^rtc_[A-Za-z0-9_-]+$/;
const UUID_CALL_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isRealtimeCallIdSegment(segment: string): boolean {
  if (segment.length > MAX_CALL_ID_LENGTH) return false;
  return RTC_CALL_ID_RE.test(segment) || UUID_CALL_ID_RE.test(segment);
}

/**
 * The call id a client reads from a call-create Location, extracted the way openai/codex does
 * (`decode_call_id_from_location`, codex-api realtime_call.rs): drop the query, scan the path
 * segments from the end, and take the first `rtc_…` or hyphenated-UUID segment. The backend
 * answers `/v1/realtime/calls/calls/rtc_…`, the API `/v1/live/rtc_…`; both yield the id the client
 * then joins with.
 */
export function liveCallIdFromLocation(location: string | null | undefined): string | null {
  if (!location || location.length > MAX_LOCATION_LENGTH) return null;
  const path = location.split("?")[0] ?? "";
  for (const segment of path.split("/").reverse()) {
    if (isRealtimeCallIdSegment(segment)) return segment;
  }
  return null;
}

export class NativeLiveCalls {
  /** Insertion order is creation order, so the first key is always the oldest entry. */
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = NATIVE_LIVE_CALL_TTL_MS,
    private readonly capacity: number = MAX_NATIVE_LIVE_CALLS,
  ) {}

  /** Record the call a successful create's Location names; returns the id, or null when none. */
  record(location: string | null | undefined): string | null {
    const id = liveCallIdFromLocation(location);
    if (!id) return null;
    this.prune();
    this.entries.delete(id);
    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(id, this.now() + this.ttlMs);
    return id;
  }

  has(id: string): boolean {
    const expiresAt = this.entries.get(id);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.entries.delete(id);
      return false;
    }
    return true;
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, expiresAt] of this.entries) if (expiresAt <= now) this.entries.delete(id);
  }
}

/** The process-wide registry `handleLive` writes and native sideband joins read. */
export const nativeLiveCalls = new NativeLiveCalls();
