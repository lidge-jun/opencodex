/** Cursor OAuth account-pool kernel. No configuration or HTTP surface lives here. */
import { randomUUID } from "node:crypto";
import { getAccountSet } from "../oauth/store";

export const CURSOR_POOL_KEY = "cursor";
export const CURSOR_POOL_TTL_MS = 30 * 60_000;
export const CURSOR_POOL_COOLDOWN_MS = 300_000;
export interface CursorCredential {
  readonly id: string;
  weight: number;
}
export class NoAvailableCursorCredentialError extends Error {}
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
}

function usable(
  account:
    | CursorPoolAccount
    | { credential?: CursorPoolAccount; needsReauth?: boolean },
  now: number,
): boolean {
  if (account.needsReauth === true) return false;
  const c = ("credential" in account ? account.credential : account) as
    CursorPoolAccount | undefined;
  if (!c) return false;
  return (
    Boolean(c.access) &&
    (!Number.isFinite(c.expires) || (c.expires as number) > now)
  );
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
  private sweep(now = this.now()): void {
    for (const [ref, s] of this.states)
      if (s.touched + CURSOR_POOL_TTL_MS <= now) {
        this.states.delete(ref);
        for (const [k, v] of this.affinity)
          if (v === ref) this.affinity.delete(k);
      }
  }
  private accounts(
    now: number,
  ): Array<{ ref: string; id: string; token: string }> {
    const source =
      this.listAccounts?.() ??
      (getAccountSet(CURSOR_POOL_KEY)?.accounts ?? []).map((a) => ({
        id: a.id,
        ...a.credential,
        needsReauth: a.needsReauth,
      }));
    return source
      .filter((a) => usable(a, now))
      .map((a) => {
        let ref = this.refs.get(a.id);
        if (!ref) {
          ref = `cp_${randomUUID().replaceAll("-", "")}`;
          this.refs.set(a.id, ref);
        }
        const token =
          this.resolveAccessToken?.(a.id) ??
          (a.access &&
          (!Number.isFinite(a.expires) || (a.expires as number) > now)
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
    if (
      capability !== this.capability ||
      !owner ||
      !thread ||
      (expectedGeneration !== undefined &&
        expectedGeneration !== this.generation)
    )
      return null;
    this.sweep();
    const now = this.now();
    const accounts = this.accounts(now);
    if (accounts.length < 2) return null;
    const active = new Set(accounts.map((a) => a.id));
    for (const [id, ref] of this.refs)
      if (!active.has(id)) this.refs.delete(id);
    for (const a of accounts) {
      const key = `${owner}\0${thread}\0${a.ref}`;
      const p = this.states.get(key);
      this.states.set(key, {
        ref: a.ref,
        owner,
        thread,
        cooldownUntil: p?.cooldownUntil ?? 0,
        rotated: p?.rotated ?? false,
        touched: now,
      });
    }
    this.generation++;
    return {
      generation: this.generation,
      owner,
      thread,
      refs: accounts.map((a) => a.ref),
    };
  }
  pick(
    owner: string,
    thread: string,
    capability: symbol,
  ): CursorPoolPick | null {
    if (capability !== this.capability) return null;
    const snap = this.activate(owner, thread, capability);
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
    const a = this.accounts(now).find((x) => x.ref === state.ref);
    return a
      ? { accountRef: state.ref, token: a.token, generation: this.generation }
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
    if (!s || s.rotated) return false;
    s.cooldownUntil = Math.max(s.cooldownUntil, now + CURSOR_POOL_COOLDOWN_MS);
    s.rotated = true;
    s.touched = now;
    return true;
  }
  rollback(snapshot: CursorPoolSnapshot, capability: symbol): boolean {
    if (
      capability !== this.capability ||
      snapshot.generation !== this.generation
    )
      return false;
    for (const [k, s] of this.states)
      if (s.owner === snapshot.owner && s.thread === snapshot.thread)
        this.states.delete(k);
    const key = this.key(snapshot.owner, snapshot.thread);
    this.affinity.delete(key);
    this.generation++;
    return true;
  }
  remove(accountRef: string, capability: symbol): void {
    if (capability !== this.capability) return;
    for (const [k, s] of this.states)
      if (s.ref === accountRef) this.states.delete(k);
    for (const [k, v] of this.affinity)
      if (v === accountRef) this.affinity.delete(k);
  }
  clear(capability: symbol): void {
    if (capability === this.capability) {
      this.states.clear();
      this.affinity.clear();
      this.generation++;
    }
  }
}
export function createCursorPoolCapability(): symbol {
  return Symbol(`cursor-pool:${randomUUID()}`);
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
