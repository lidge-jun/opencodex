import { readFileSync, type Stats } from "node:fs";
import { type OwnerDeps } from "./prompt-lock-owner";
import { LockFileBusy, lockFileOperation } from "./prompt-lock-io";

export class ChangedLock extends LockFileBusy {}
export interface Namespace { path: string; stat: Stats }
export interface Entry extends Namespace { body: string }
export function checkIdentity(saved: Namespace, deps: OwnerDeps): void {
  const current = deps.lstat(saved.path);
  if (current.isSymbolicLink() || current.dev !== saved.stat.dev || current.ino !== saved.stat.ino
    || current.uid !== saved.stat.uid || current.isDirectory() !== saved.stat.isDirectory()
    || current.isFile() !== saved.stat.isFile()) throw new ChangedLock("Lock namespace changed");
}
export function checkEntry(saved: Entry, deps: OwnerDeps): void {
  checkIdentity(saved, deps);
  if (readFileSync(saved.path, "utf8") !== saved.body) throw new ChangedLock("Claim evidence changed");
  checkIdentity(saved, deps);
}
export function guarded<T>(parents: Namespace[], entries: Entry[], deps: OwnerDeps, operation: () => T): T {
  return lockFileOperation(() => {
    for (const parent of parents) checkIdentity(parent, deps);
    for (const entry of entries) checkEntry(entry, deps);
    for (const parent of parents) checkIdentity(parent, deps);
    return operation();
  }, deps.platform);
}
