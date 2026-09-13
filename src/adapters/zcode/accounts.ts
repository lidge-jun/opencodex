import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfigDir } from "../../config/paths";

export interface ZcodeAccount { id: string; label: string; subjectHash?: string; draftFor?: string; pending?: boolean }
const ACCOUNT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Normal operation has at most 20 saved accounts plus eight live OAuth jobs. Keep enough room to
// recover older orphaned drafts without turning a user-writable directory into unbounded sync IO.
const MAX_ACCOUNT_DIRECTORIES = 256;
export function accountRoot(id: string): string {
  if (!ACCOUNT_ID.test(id)) throw new Error("account_invalid");
  return join(getConfigDir(), "zcode-accounts", id);
}
export const accountProfile = (id: string) => join(accountRoot(id), "profile");
export function readAccount(id: string): ZcodeAccount {
  const fd = openSync(join(accountRoot(id), "account.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 4096 || (st.mode & 0o077) || st.uid !== process.getuid?.()) throw new Error();
    const value = JSON.parse(readFileSync(fd, "utf8"));
    if (value.id !== id || typeof value.label !== "string" || value.label.length > 80
      || (value.subjectHash !== undefined && !/^[a-f0-9]{64}$/.test(value.subjectHash))
      || (value.draftFor !== undefined && !ACCOUNT_ID.test(value.draftFor))
      || (value.pending !== undefined && value.pending !== true)) throw new Error();
    return { id, label: value.label, ...(value.subjectHash ? { subjectHash: value.subjectHash } : {}),
      ...(value.draftFor ? { draftFor: value.draftFor } : {}), ...(value.pending ? { pending: true } : {}) };
  } finally { closeSync(fd); }
}
export function writeAccount(account: ZcodeAccount): void {
  const dir = accountRoot(account.id);
  const label = account.label.trim();
  if (!label || label.length > 80 || /[\x00-\x1f]/.test(label)
    || (account.subjectHash !== undefined && !/^[a-f0-9]{64}$/.test(account.subjectHash))
    || (account.draftFor !== undefined && !ACCOUNT_ID.test(account.draftFor))
    || (account.pending !== undefined && account.pending !== true)) throw new Error("account_invalid");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, randomUUID() + ".tmp");
  writeFileSync(temp, JSON.stringify({ ...account, label }), { mode: 0o600, flag: "wx" });
  renameSync(temp, join(dir, "account.json"));
}
function storedAccountIds(): string[] {
  const dir = join(getConfigDir(), "zcode-accounts");
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir).filter(id => ACCOUNT_ID.test(id));
  if (ids.length > MAX_ACCOUNT_DIRECTORIES) throw new Error("account_invalid");
  return ids;
}
function storedAccounts(): ZcodeAccount[] {
  // Read every bounded, syntactically valid account directory before applying visibility or
  // capacity rules. Slicing directory entries first can omit a real account when legacy/orphaned
  // drafts sort ahead of it, which makes duplicate and account-limit checks order-dependent.
  return storedAccountIds().flatMap(id => {
    try { return [readAccount(id)]; } catch { return []; }
  });
}
export function listAccounts(): ZcodeAccount[] {
  return storedAccounts().filter(account => !account.draftFor && !account.pending);
}
/** Remove hidden OAuth profiles whose owning in-memory job vanished after a process restart. */
export function reconcileAccountDrafts(activeDraftIds: ReadonlySet<string>): void {
  for (const id of storedAccountIds()) {
    if (activeDraftIds.has(id)) continue;
    try { const account = readAccount(id); if (account.draftFor || account.pending) removeAccountFiles(id); }
    catch { /* Invalid state is never deleted implicitly. */ }
  }
}
export function allocateAccount(label: string, replaceId?: string): ZcodeAccount {
  if (replaceId) readAccount(replaceId);
  // A live standalone draft reserves its eventual slot without becoming a visible saved account.
  // Restart reconciliation removes abandoned reservations before management routes allocate again.
  if (!replaceId && storedAccounts().filter(account => !account.draftFor).length >= 20) throw new Error("account_limit");
  const account = { id: randomUUID(), label, ...(replaceId ? { draftFor: replaceId } : { pending: true as const }) };
  writeAccount(account);
  mkdirSync(accountProfile(account.id), { recursive: true, mode: 0o700 });
  return account;
}
export function removeAccountFiles(id: string): void { rmSync(accountRoot(id), { recursive: true, force: true }); }
