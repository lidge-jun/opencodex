// Only one container may write the snapshot. A rollout stops the old instance before starting the
// new one, but a container that dies without SIGTERM never releases, so the next waits for staleness.
export const LEASE_STALE_MS = 120_000;

export type Lease = { bootId: string; heartbeatAt: number };

export type LeaseDecision =
  | { granted: true; lease: Lease }
  | { granted: false; retryAfterSeconds: number };

export function decideLease(current: Lease | undefined, bootId: string, now: number): LeaseDecision {
  if (!current || current.bootId === bootId || now - current.heartbeatAt >= LEASE_STALE_MS) {
    return { granted: true, lease: { bootId, heartbeatAt: now } };
  }
  const remaining = LEASE_STALE_MS - (now - current.heartbeatAt);
  return { granted: false, retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)) };
}

export function isHolder(current: Lease | undefined, bootId: string): boolean {
  return current?.bootId === bootId;
}

export const BOOT_ID_PATTERN = /^[0-9a-f]{32}$/;

export interface LeaseStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const LEASE_KEY = "ocx:lease";
const SNAPSHOT_KEY = "ocx:snapshot";

/** The Durable Object's state. Awaiting DO storage keeps the input gate closed, so these read-modify-writes need no CAS. */
export class LeaseState {
  constructor(private readonly storage: LeaseStorage, private readonly now: () => number = Date.now) {}

  async acquireLease(bootId: string): Promise<{ granted: boolean; retryAfterSeconds?: number }> {
    const decision = decideLease(await this.storage.get<Lease>(LEASE_KEY), bootId, this.now());
    if (!decision.granted) return { granted: false, retryAfterSeconds: decision.retryAfterSeconds };
    await this.storage.put(LEASE_KEY, decision.lease);
    return { granted: true };
  }

  /** Extends only a lease the caller still holds, so a late heartbeat can never re-take a released or reassigned lease. */
  async renewLease(bootId: string): Promise<boolean> {
    if (!(await this.holdsLease(bootId))) return false;
    await this.storage.put(LEASE_KEY, { bootId, heartbeatAt: this.now() });
    return true;
  }

  async holdsLease(bootId: string): Promise<boolean> {
    return isHolder(await this.storage.get<Lease>(LEASE_KEY), bootId);
  }

  async releaseLease(bootId: string): Promise<void> {
    if (await this.holdsLease(bootId)) await this.storage.delete(LEASE_KEY);
  }

  currentSnapshot(): Promise<string | undefined> {
    return this.storage.get<string>(SNAPSHOT_KEY);
  }

  /** Returns the key the new snapshot replaced, or null when the caller lost the lease. */
  async commitSnapshot(bootId: string, key: string): Promise<{ replaced: string | undefined } | null> {
    if (!(await this.holdsLease(bootId))) return null;
    const replaced = await this.storage.get<string>(SNAPSHOT_KEY);
    await this.storage.put(SNAPSHOT_KEY, key);
    return { replaced: replaced === key ? undefined : replaced };
  }
}
