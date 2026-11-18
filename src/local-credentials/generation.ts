import { randomUUID } from "node:crypto";
import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { atomicWriteFileStreamed } from "../config/atomic-write";
import { withCredentialPublicationFence, withCredentialPublicationFenceAsync } from "./publication-fence";
import { configuredOsStoreAccounts } from "./references";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { acquireCredentialObservationLease, credentialObservationLeaseAlive, sweepDeadCredentialObservationLeases } from "./observation-lease";

/**
 * Durable coordination for the local-credential attestation in `ocx status --json`.
 *
 * `local-credentials.json` holds a random epoch, a sequence, pending publication tickets,
 * the private OS keychain accounts an instrumented writer touched, and the runtime observer's
 * coverage vector of file identities. It never holds a credential value or a hash of one. Every
 * instrumented credential write advances the sequence, so `lc1:<epoch>:<sequence>` changes even
 * when the final count is unchanged.
 */
type Ticket = { id: string; pid: number };
type Coverage = { owner: string; pid: number; vector: string };
export type CredentialGeneration = {
  version: 1;
  epoch: string;
  sequence: number;
  pending: Ticket[];
  keyAccounts: string[];
  /**
   * Accounts a read proved absent after a deletion. A config reference to one of them is not
   * registered again; only a new keychain write or deletion attempt for that account clears it.
   */
  absentAccounts: string[];
  coverage: Coverage | null;
};
const MAX_ACCOUNTS = 8192;
function accountList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ACCOUNTS && new Set(value).size === value.length
    && value.every(k => typeof k === "string" && k.length > 0 && k.length <= 1024);
}
const observers = new Map<string, () => void>();
const decoder = new TextDecoder("utf-8", { fatal: true });
const uuid = /^[0-9a-f-]{36}$/;
const pathFor = (home: string) => join(home, "local-credentials.json");

export function observationAlive(state: CredentialGeneration, home = getConfigDir()): boolean {
  return !!state.coverage && credentialObservationLeaseAlive(home, state.coverage.owner);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code !== "ESRCH"; }
}
export function readCredentialGeneration(home = getConfigDir()): CredentialGeneration | undefined {
  try {
    const path = pathFor(home);
    if (!lstatSync(path).isFile()) return undefined;
    const value: unknown = JSON.parse(decoder.decode(readBoundedRegularFileSync(path, 1024 * 1024)));
    if (!value || typeof value !== "object") return undefined;
    const s = value as CredentialGeneration;
    if (s.version !== 1 || typeof s.epoch !== "string" || !uuid.test(s.epoch)
      || !Number.isSafeInteger(s.sequence) || s.sequence < 0
      || !Array.isArray(s.pending) || s.pending.length > 1024
      || !s.pending.every(t => t && typeof t.id === "string" && uuid.test(t.id)
        && Number.isSafeInteger(t.pid) && t.pid > 0)
      || new Set(s.pending.map(t => t.id)).size !== s.pending.length
      || !accountList(s.keyAccounts)) return undefined;
    if (s.absentAccounts === undefined) s.absentAccounts = [];
    else if (!accountList(s.absentAccounts)) return undefined;
    if (s.coverage !== null && (!s.coverage || typeof s.coverage.owner !== "string"
      || !uuid.test(s.coverage.owner) || !Number.isSafeInteger(s.coverage.pid)
      || s.coverage.pid <= 0 || typeof s.coverage.vector !== "string"
      || s.coverage.vector.length > 512 * 1024)) return undefined;
    return s;
  } catch { return undefined; }
}
function empty(): CredentialGeneration {
  return { version: 1, epoch: randomUUID(), sequence: 0, pending: [], keyAccounts: [], absentAccounts: [], coverage: null };
}
/** Missing metadata starts a fresh epoch; unreadable metadata is never guessed over. */
function loadForWrite(home: string): CredentialGeneration {
  const state = readCredentialGeneration(home);
  if (state) return state;
  if (!exists(pathFor(home))) return empty();
  throw new Error("Local credential coordination metadata is unreadable; explicit recovery required");
}
function save(home: string, state: CredentialGeneration): void {
  atomicWriteFileStreamed(pathFor(home), fd => writeFileSync(fd, JSON.stringify(state) + "\n"));
}
function advance(state: CredentialGeneration): void {
  if (state.sequence >= Number.MAX_SAFE_INTEGER) { state.epoch = randomUUID(); state.sequence = 0; }
  else state.sequence += 1;
}
/**
 * Registration. Accounts a write may hold (a keychain write or deletion attempt) always register
 * and lose any absent marker; accounts a config merely references register unless a read already
 * proved them absent, so a stale reference cannot bring a deleted secret back into the count.
 */
function register(state: CredentialGeneration, held: readonly string[], references: readonly string[]): void {
  if ([...held, ...references].some(a => !a || a.length > 1024)) throw new Error("Invalid private key account");
  const absent = new Set(state.absentAccounts.filter(a => !held.includes(a)));
  state.absentAccounts = [...absent];
  state.keyAccounts = [...new Set([...state.keyAccounts, ...held, ...references.filter(a => !absent.has(a))])];
  if (state.keyAccounts.length > MAX_ACCOUNTS) throw new Error("Too many private key accounts");
}
/** Retain every OS-store account config.json references now; only a verified absence drops one. */
function seedConfiguredAccounts(home: string, state: CredentialGeneration): void {
  register(state, [], configuredOsStoreAccounts(home));
}
export function generationToken(state: CredentialGeneration): string {
  return `lc1:${state.epoch}:${state.sequence}`;
}
/**
 * Inside the publication fence, before any credential bytes change: persist a ticket that advances
 * the generation. Once coordination metadata exists every publication needs one, because a write
 * whose ticket was lost could end where it began (add then remove) and leave an earlier token
 * attestable; so any failure here, including unreadable or unwritable metadata, aborts the
 * publication before it writes. Without metadata no observer has ever attested, so a file write
 * needs no ticket; a keychain write still creates the metadata to record its account first.
 */
function begin(home: string, accounts: readonly string[], references: readonly string[]): Ticket | null {
  if (accounts.length === 0 && references.length === 0 && !exists(pathFor(home))) return null;
  const state = loadForWrite(home);
  if (state.pending.length >= 1024) throw new Error("Too many pending credential publications");
  const ticket = { id: randomUUID(), pid: process.pid };
  state.pending.push(ticket);
  register(state, accounts, references);
  advance(state);
  save(home, state);
  return ticket;
}

/** Inside the fence. Never throws: a ticket that cannot be closed keeps withholding attestation. */
function finish(home: string, ticket: Ticket | null, removed: readonly string[]): void {
  if (ticket) {
    try {
      const state = loadForWrite(home);
      if (state.pending.some(t => t.id === ticket.id && t.pid === ticket.pid)) {
        state.pending = state.pending.filter(t => t.id !== ticket.id);
        state.keyAccounts = state.keyAccounts.filter(k => !removed.includes(k));
        state.absentAccounts = [...new Set([...state.absentAccounts, ...removed])].slice(-MAX_ACCOUNTS);
        advance(state);
        save(home, state);
      }
    } catch { /* the pending ticket keeps the field omitted until a runtime restart clears it */ }
  }
  observers.get(home)?.();
}

export interface CredentialPublication {
  /** Keychain accounts this write may create or hold; they count until verified absent. */
  accounts?: readonly string[];
  /** Accounts the config references around this write; registered unless verified absent. */
  references?: readonly string[];
  /** After the write settles: accounts now verified absent, dropped from the registry. */
  absent?: (completed: boolean) => readonly string[];
}

/** Every instrumented credential write runs here, inside the publication fence (fails if it cannot be taken). */
export function publishCredentialSync<T>(write: () => T, publication: CredentialPublication = {}): T {
  const home = getConfigDir();
  return withCredentialPublicationFence(home, () => {
    const ticket = begin(home, publication.accounts ?? [], publication.references ?? []);
    let completed = false;
    try {
      const result = write();
      if (result instanceof Promise) throw new Error("Synchronous credential publication returned a Promise");
      completed = true;
      return result;
    } finally {
      let removed: readonly string[] = [];
      try { removed = publication.absent?.(completed) ?? []; } catch { /* unverified stays counted */ }
      finish(home, ticket, removed);
    }
  });
}
export async function publishCredentialAsync<T>(write: () => Promise<T>): Promise<T> {
  const home = getConfigDir();
  return await withCredentialPublicationFenceAsync(home, async () => {
    const ticket = begin(home, [], []);
    try { return await write(); }
    finally { finish(home, ticket, []); }
  });
}

/**
 * Runtime start: refuse while another observer lives or a live writer holds a ticket, clear the
 * tickets of dead writers, start a new epoch and take the observer's OS lease.
 */
export function claimCredentialObservation(home: string, scan: (accounts: readonly string[]) => string): { owner: string; close(): void } {
  return withCredentialPublicationFence(home, () => {
    const state = loadForWrite(home);
    if (observationAlive(state, home)) throw new Error("Credential observer already running");
    if (state.pending.some(t => processAlive(t.pid))) throw new Error("Credential publication still running");
    state.pending = [];
    state.epoch = randomUUID();
    state.sequence = 0;
    seedConfiguredAccounts(home, state);
    const owner = randomUUID();
    const lease = acquireCredentialObservationLease(home, owner);
    sweepDeadCredentialObservationLeases(home, owner);
    try {
      state.coverage = { owner, pid: process.pid, vector: scan(state.keyAccounts) };
      save(home, state);
      return { owner, close: () => lease.close() };
    } catch (error) { lease.close(); throw error; }
  });
}
/**
 * Advance on every observed coverage-relevant event and rescan; a failed scan leaves an empty
 * vector, which never attests. It never waits for the fence: the runtime observer retries
 * asynchronously instead. "Coverage-relevant" is the watcher's classification in inventory.ts:
 * every event on a target name, credential-write residue, or ancestor structural change --
 * but not an ancestor directory's last-write tick from ordinary child churn, which reports no
 * credential change and would re-arm the observer's own save forever.
 */
export function updateCredentialObservation(home: string, owner: string, scan: ((accounts: readonly string[]) => string) | null): void {
  withCredentialPublicationFence(home, () => {
    const state = loadForWrite(home);
    if (state.coverage?.owner !== owner) return;
    advance(state);
    if (scan === null) state.coverage = null;
    else {
      try {
        seedConfiguredAccounts(home, state);
        state.coverage.vector = scan(state.keyAccounts);
      }
      catch { state.coverage.vector = ""; }
    }
    save(home, state);
  }, 0);
}
export function registerCredentialObserver(home: string, reconcile: () => void): () => void {
  if (observers.has(home)) throw new Error("Credential observer already registered");
  observers.set(home, reconcile);
  return () => { if (observers.get(home) === reconcile) observers.delete(home); };
}
