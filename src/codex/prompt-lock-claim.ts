import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ownEvidence, ownerState, safeNamespace, type OwnerDeps, type OwnerEvidence } from "./prompt-lock-owner";
import { ChangedLock as ChangedClaim, checkEntry, checkIdentity, guarded, type Entry, type Namespace } from "./prompt-lock-evidence";
import { LockFileBusy, lockFileOperation } from "./prompt-lock-io";

export interface ClaimRecord extends OwnerEvidence { ticket: number; token?: string }
export class UnsafeLockNamespace extends Error {
  constructor(readonly path: string) { super(`Unsafe lock state at ${path}; deliberate removal is required.`); }
}
interface AbandonedClaim { token: string; parents: Namespace[]; entry: Entry }
// Only a completed invocation may enter this map; live/reentrant reservations never do.
const abandoned = new Map<string, AbandonedClaim>();
function recoverAbandoned(directory: string, deps: OwnerDeps): void {
  for (const [path, claim] of abandoned) {
    if (dirname(path) !== directory) continue;
    // The token is bound to the captured bytes and unique name, never to PID alone.
    const record = JSON.parse(claim.entry.body) as ClaimRecord;
    if (record.pid !== process.pid || record.token !== claim.token) throw new ChangedClaim("Unknown local claim");
    try { guarded(claim.parents, [claim.entry], deps, () => unlinkSync(path)); }
    catch (error) {
      if (!(error instanceof ChangedClaim) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A replacement is not ours; forget custody without deleting it.
    }
    abandoned.delete(path);
  }
}
/** Publish owner evidence together with choosing=0; an empty reservation is never published. */
export function withLockClaim<T>(
  path: string, token: string, deps: OwnerDeps, run: () => T,
  initialized?: () => void,
): { ok: true; value: T } | { ok: false } {
  const io = <R>(operation: () => R): R => lockFileOperation(operation, deps.platform);
  const directory = `${path}.claims`;
  try { recoverAbandoned(directory, deps); }
  catch (error) { if (error instanceof LockFileBusy) return { ok: false }; throw error; }
  if (!safeNamespace(dirname(path), "directory", deps)) throw new UnsafeLockNamespace(dirname(path));
  const root: Namespace = { path: dirname(path), stat: io(() => deps.lstat(dirname(path))) };
  try { guarded([root], [], deps, () => mkdirSync(directory, { mode: 0o700 })); }
  catch (error) {
    if (error instanceof LockFileBusy) return { ok: false };
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!safeNamespace(directory, "directory", deps)) throw new UnsafeLockNamespace(directory);
  const parents = [root, { path: directory, stat: io(() => deps.lstat(directory)) }];
  const ownName = `${process.pid}-${token}.claim`, ownPath = join(directory, ownName);
  const temporary = `${path}.claim-init-${token}`;
  let ownEntry: Entry | undefined, temporaryEntry: Entry | undefined;
  const evidence = { ...ownEvidence(deps), token };
  const capture = (entryPath: string, expectedBody?: string): Entry => guarded(parents, [], deps, () => {
    if (!safeNamespace(entryPath, "file", deps, true)) throw new UnsafeLockNamespace(entryPath);
    const entry = { path: entryPath, stat: deps.lstat(entryPath), body: readFileSync(entryPath, "utf8") };
    checkEntry(entry, deps);
    if (expectedBody !== undefined && entry.body !== expectedBody) throw new ChangedClaim("Local claim evidence changed");
    return entry;
  });
  const peers = (): Array<{ name: string; ticket: number }> => {
    const result: Array<{ name: string; ticket: number }> = [];
    for (const name of guarded(parents, [], deps, () => readdirSync(directory))) {
      if (name === ownName) continue;
      const peerPath = join(directory, name);
      if (!/^([1-9][0-9]*)-[0-9a-f]{16}\.claim$/.test(name)
        || !safeNamespace(peerPath, "file", deps, true)) throw new UnsafeLockNamespace(peerPath);
      let entry: Entry, peer: ClaimRecord | null;
      try { entry = capture(peerPath); peer = JSON.parse(entry.body); }
      catch (error) {
        if (error instanceof LockFileBusy || error instanceof UnsafeLockNamespace) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new UnsafeLockNamespace(peerPath);
      }
      const state = ownerState(peer, deps);
      if (state === "unsafe") throw new UnsafeLockNamespace(peerPath);
      if (state === "dead") {
        try { guarded(parents, [entry], deps, () => {
          if (ownerState(peer, deps) !== "dead") throw new ChangedClaim("Peer is no longer dead");
          checkEntry(entry, deps);
          for (const parent of parents) checkIdentity(parent, deps);
          unlinkSync(peerPath);
        }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        continue;
      }
      const ticket = peer?.ticket;
      if (typeof ticket !== "number" || !Number.isSafeInteger(ticket) || ticket < 0) throw new UnsafeLockNamespace(peerPath);
      result.push({ name, ticket });
    }
    return result;
  };
  try {
    const choosingBody = JSON.stringify({ ...evidence, ticket: 0 });
    guarded(parents, [], deps, () => writeFileSync(temporary, choosingBody, { mode: 0o600, flag: "wx" }));
    temporaryEntry = capture(temporary, choosingBody);
    guarded(parents, [temporaryEntry], deps, () => linkSync(temporary, ownPath));
    ownEntry = { ...temporaryEntry, path: ownPath };
    guarded(parents, [temporaryEntry], deps, () => unlinkSync(temporary)); temporaryEntry = undefined;
    initialized?.();
    let ticket = 1;
    for (const peer of peers()) ticket = Math.max(ticket, peer.ticket + 1);
    if (!Number.isSafeInteger(ticket)) return { ok: false };
    const ticketBody = JSON.stringify({ ...evidence, ticket });
    guarded(parents, [], deps, () => writeFileSync(temporary, ticketBody, { mode: 0o600, flag: "wx" }));
    temporaryEntry = capture(temporary, ticketBody);
    guarded(parents, [temporaryEntry, ownEntry], deps, () => renameSync(temporary, ownPath));
    ownEntry = { ...temporaryEntry, path: ownPath }; temporaryEntry = undefined;
    for (const peer of peers()) {
      if (peer.ticket === 0 || peer.ticket < ticket || (peer.ticket === ticket && peer.name < ownName)) return { ok: false };
    }
    if (!safeNamespace(path, "file", deps, true)) throw new UnsafeLockNamespace(path);
    return { ok: true, value: run() };
  } catch (error) {
    if (error instanceof LockFileBusy || (error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false };
    throw error;
  } finally {
    if (temporaryEntry) {
      try { guarded(parents, [temporaryEntry], deps, () => unlinkSync(temporary)); } catch { /* Preserve changed or busy entries. */ }
    }
    if (ownEntry) {
      try { guarded(parents, [ownEntry], deps, () => unlinkSync(ownPath)); }
      catch (error) {
        if (!(error instanceof ChangedClaim) && (error as NodeJS.ErrnoException).code !== "ENOENT") {
          abandoned.set(ownPath, { token, parents, entry: ownEntry });
        }
      }
      try { guarded(parents, [], deps, () => rmdirSync(directory)); } catch { /* A peer or replacement still owns the directory. */ }
    }
  }
}
