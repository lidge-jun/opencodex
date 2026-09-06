/** Cursor OAuth account-pool kernel. No configuration or HTTP surface lives here. */
import { getAccountSet } from "../oauth/store";

export const CURSOR_POOL_KEY = "cursor";
export const CURSOR_POOL_TTL_MS = 30 * 60_000;
export const CURSOR_POOL_COOLDOWN_MS = 300_000;
export interface CursorCredential {
  readonly id: string;
  weight: number;
}
export class NoAvailableCursorCredentialError extends Error {
  constructor(message = "No available Cursor credentials") {
    super(message);
  }
}
interface State {
  ref: string;
  owner: string;
  thread: string;
  cooldownUntil: number;
  touched: number;
  rotated: boolean;
}
export interface CursorPoolPick {
  readonly accountRef: string;
  readonly token: string;
  readonly generation: number;
}
export interface CursorPoolSnapshot {
  readonly generation: number;
  readonly owner: string;
  readonly thread: string;
  readonly refs: ReadonlyArray<string>;
  readonly previous: ReadonlyArray<State>;
  readonly previousAffinity?: string;
}
function unexpired(expires: number | undefined, now: number): boolean {
  return expires === undefined || (Number.isFinite(expires) && expires > now);
}

function usable(
  account: CursorPoolAccount,
  now: number,
): boolean {
  if (account.needsReauth === true) return false;
  return Boolean(account.access) && unexpired(account.expires, now);
}

export interface CursorPoolAccount {
  readonly id: string;
  readonly access?: string;
  readonly refresh?: string;
  readonly expires?: number;
  readonly needsReauth?: boolean;
}
export interface CursorPoolKernelOptions {
  readonly resolveAccessToken?: (accountId: string) => string | undefined;
  readonly listAccounts?: () => ReadonlyArray<CursorPoolAccount>;
}

export class CursorPoolKernel {
  private states = new Map<string, State>();
  private affinity = new Map<string, string>();
  private versions = new Map<string, number>();
  private generation = 0;
  private readonly resolveAccessToken?: (
    accountId: string,
  ) => string | undefined;
  private readonly listAccounts?: () => ReadonlyArray<CursorPoolAccount>;
  private readonly refs = new Map<string, string>();
  constructor(
    private readonly capability: symbol = Symbol("cursor-pool"),
    private readonly now: () => number = Date.now,
    options: CursorPoolKernelOptions = {},
  ) {
    this.resolveAccessToken = options.resolveAccessToken;
    this.listAccounts = options.listAccounts;
  }
  get currentGeneration(): number {
    return this.generation;
  }
  private key(owner: string, thread: string): string {
    return `${owner}\0${thread}`;
  }
  private version(key: string): number {
    return this.versions.get(key) ?? 0;
  }
  private advanceVersion(key: string): number {
    const next = ++this.generation;
    this.versions.set(key, next);
    return next;
  }
  private hasLiveStateFor(owner: string, thread: string): boolean {
    for (const s of this.states.values()) {
      if (s.owner === owner && s.thread === thread) return true;
    }
    return false;
  }
  private sweep(now = this.now()): void {
    for (const [key, s] of this.states)
      if (s.touched + CURSOR_POOL_TTL_MS <= now) {
        this.states.delete(key);
        const ownerThread = this.key(s.owner, s.thread);
        if (!this.hasLiveStateFor(s.owner, s.thread)) {
          this.affinity.delete(ownerThread);
          this.versions.delete(ownerThread);
        }
      }
  }
  private rawAccounts(): ReadonlyArray<CursorPoolAccount> {
    return (
      this.listAccounts?.() ??
      (getAccountSet(CURSOR_POOL_KEY)?.accounts ?? []).map((a) => ({
        id: a.id,
        ...a.credential,
        needsReauth: a.needsReauth,
      }))
    );
  }
  private accounts(
    source: ReadonlyArray<CursorPoolAccount>,
    now: number,
  ): Array<{ ref: string; id: string; token: string }> {
    return source
      .filter((a) => usable(a, now))
      .map((a) => {
        let ref = this.refs.get(a.id);
        if (!ref) {
          ref = `cp_${crypto.randomUUID().replaceAll("-", "")}`;
          this.refs.set(a.id, ref);
        }
        const token =
          this.resolveAccessToken?.(a.id) ??
          (a.access && unexpired(a.expires, now)
            ? a.access
            : undefined);
        return { ref, id: a.id, token: token ?? "" };
      })
      .filter((a) => Boolean(a.token));
  }
  activate(
    owner: string,
    thread: string,
    capability: symbol,
    expectedGeneration?: number,
  ): CursorPoolSnapshot | null {
    const ownerThread = this.key(owner, thread);
    if (
      capability !== this.capability ||
      !owner ||
      !thread ||
      (expectedGeneration !== undefined &&
        expectedGeneration !== this.version(ownerThread))
    )
      return null;
    const { snapshot } = this.activateInternal(owner, thread);
    return snapshot;
  }
  private activateInternal(
    owner: string,
    thread: string,
  ): {
    snapshot: CursorPoolSnapshot | null;
    resolvedAccounts: Array<{ ref: string; id: string; token: string }>;
  } {
    const ownerThread = this.key(owner, thread);
    this.sweep();
    const now = this.now();
    const raw = this.rawAccounts();
    const accounts = this.accounts(raw, now);
    if (accounts.length < 2) return { snapshot: null, resolvedAccounts: [] };
    const previous = accounts.flatMap((a) => {
      const prior = this.states.get(`${owner}\0${thread}\0${a.ref}`);
      return prior ? [{ ...prior }] : [];
    });
    const previousAffinity = this.affinity.get(ownerThread);
    const knownSource = new Set(raw.map((a) => a.id));
    for (const [id, ref] of this.refs)
      if (!knownSource.has(id)) this.refs.delete(id);
    for (const a of accounts) {
      const key = `${owner}\0${thread}\0${a.ref}`;
      const p = this.states.get(key);
      const expired = p && p.cooldownUntil <= now;
      this.states.set(key, {
        ref: a.ref,
        owner,
        thread,
        cooldownUntil: p?.cooldownUntil ?? 0,
        rotated: expired ? false : (p?.rotated ?? false),
        touched: now,
      });
    }
    const generation = this.advanceVersion(ownerThread);
    return {
      snapshot: {
        generation,
        owner,
        thread,
        refs: accounts.map((a) => a.ref),
        previous,
        previousAffinity,
      },
      resolvedAccounts: accounts,
    };
  }
  pick(
    owner: string,
    thread: string,
    capability: symbol,
  ): CursorPoolPick | null {
    if (capability !== this.capability || !owner || !thread) return null;
    const { snapshot: snap, resolvedAccounts } = this.activateInternal(
      owner,
      thread,
    );
    if (!snap) return null;
    const now = this.now(),
      key = this.key(owner, thread),
      bound = this.affinity.get(key);
    const candidates = snap.refs
      .map((r) => this.states.get(`${owner}\0${thread}\0${r}`)!)
      .filter((s) => s && s.cooldownUntil <= now);
    const state =
      (bound && candidates.find((s) => s.ref === bound)) || candidates[0];
    if (!state) return null;
    this.affinity.set(key, state.ref);
    state.touched = now;
    const a = resolvedAccounts.find((x) => x.ref === state.ref);
    return a
      ? { accountRef: state.ref, token: a.token, generation: snap.generation }
      : null;
  }
  note429(
    accountRef: string,
    owner: string,
    thread: string,
    capability: symbol,
    now = this.now(),
  ): boolean {
    if (capability !== this.capability) return false;
    const s = this.states.get(`${owner}\0${thread}\0${accountRef}`);
    if (!s) return false;
    if (s.rotated && s.cooldownUntil > now) return false;
    s.cooldownUntil = Math.max(s.cooldownUntil, now + CURSOR_POOL_COOLDOWN_MS);
    s.rotated = true;
    s.touched = now;
    return true;
  }
  rollback(snapshot: CursorPoolSnapshot, capability: symbol): boolean {
    const key = this.key(snapshot.owner, snapshot.thread);
    if (
      capability !== this.capability ||
      snapshot.generation !== this.version(key)
    )
      return false;
    for (const [k, s] of this.states)
      if (s.owner === snapshot.owner && s.thread === snapshot.thread)
        this.states.delete(k);
    for (const prior of snapshot.previous)
      this.states.set(`${prior.owner}\0${prior.thread}\0${prior.ref}`, { ...prior });
    if (snapshot.previousAffinity) this.affinity.set(key, snapshot.previousAffinity);
    else this.affinity.delete(key);
    this.advanceVersion(key);
    return true;
  }
  remove(accountRef: string, capability: symbol): void {
    if (capability !== this.capability) return;
    const changed = new Set<string>();
    for (const [k, s] of this.states)
      if (s.ref === accountRef) {
        this.states.delete(k);
        changed.add(this.key(s.owner, s.thread));
      }
    for (const [k, v] of this.affinity)
      if (v === accountRef) this.affinity.delete(k);
    for (const [id, ref] of this.refs)
      if (ref === accountRef) this.refs.delete(id);
    for (const key of changed) this.advanceVersion(key);
  }
  clear(capability: symbol): void {
    if (capability === this.capability) {
      this.versions.clear();
      this.states.clear();
      this.affinity.clear();
      this.refs.clear();
    }
  }
}
export function createCursorPoolCapability(): symbol {
  return Symbol(`cursor-pool:${crypto.randomUUID()}`);
}

/** Legacy weighted router; generic 429 rotation is owned elsewhere. */
export class CursorCredentialRouter {
  private states: Array<{
    credential: CursorCredential;
    currentWeight: number;
    disabledUntil: number;
  }> = [];
  constructor(
    credentials: ReadonlyArray<CursorCredential>,
    private readonly cooldownMs = CURSOR_POOL_COOLDOWN_MS,
  ) {
    this.replace(credentials);
  }
  replace(credentials: ReadonlyArray<CursorCredential>): void {
    this.states = credentials.map((c) => ({
      credential: { ...c, weight: Math.max(1, c.weight || 1) },
      currentWeight: 0,
      disabledUntil: 0,
    }));
  }
  pick(excludeIds: ReadonlySet<string> = new Set()): CursorCredential {
    const now = Date.now(),
      cs = this.states.filter(
        (s) => !excludeIds.has(s.credential.id) && s.disabledUntil <= now,
      );
    if (!cs.length) throw new NoAvailableCursorCredentialError();
    let selected = cs[0]!,
      total = 0;
    for (const s of cs) {
      s.currentWeight += s.credential.weight;
      total += s.credential.weight;
      if (s.currentWeight > selected.currentWeight) selected = s;
    }
    selected.currentWeight -= total;
    return { ...selected.credential };
  }
  disable(id: string): void {
    const s = this.states.find((x) => x.credential.id === id);
    if (s) s.disabledUntil = Date.now() + this.cooldownMs;
  }
  get snapshot(): ReadonlyArray<{ id: string; disabled: boolean }> {
    const now = Date.now();
    return this.states.map((s) => ({
      id: s.credential.id,
      disabled: s.disabledUntil > now,
    }));
  }
}
