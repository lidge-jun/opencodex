import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfigDir } from "../../config/paths";

export interface ZcodeAccount { id: string; label: string; subjectHash?: string; draftFor?: string }
export function accountRoot(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("account_invalid");
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
      || (value.draftFor !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.draftFor))) throw new Error();
    return { id, label: value.label, ...(value.subjectHash ? { subjectHash: value.subjectHash } : {}),
      ...(value.draftFor ? { draftFor: value.draftFor } : {}) };
  } finally { closeSync(fd); }
}
export function writeAccount(account: ZcodeAccount): void {
  const dir = accountRoot(account.id);
  const label = account.label.trim();
  if (!label || label.length > 80 || /[\x00-\x1f]/.test(label)
    || (account.subjectHash !== undefined && !/^[a-f0-9]{64}$/.test(account.subjectHash))
    || (account.draftFor !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(account.draftFor))) throw new Error("account_invalid");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, randomUUID() + ".tmp");
  writeFileSync(temp, JSON.stringify({ ...account, label }), { mode: 0o600, flag: "wx" });
  renameSync(temp, join(dir, "account.json"));
}
export function listAccounts(): ZcodeAccount[] {
  const dir = join(getConfigDir(), "zcode-accounts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(id => /^[a-f0-9-]{36}$/.test(id)).slice(0, 100).flatMap(id => {
    try { const account = readAccount(id); return account.draftFor ? [] : [account]; } catch { return []; }
  });
}
export function allocateAccount(label: string, replaceId?: string): ZcodeAccount {
  if (replaceId) readAccount(replaceId);
  if (!replaceId && listAccounts().length >= 20) throw new Error("account_limit");
  const account = { id: randomUUID(), label, ...(replaceId ? { draftFor: replaceId } : {}) };
  writeAccount(account);
  mkdirSync(accountProfile(account.id), { recursive: true, mode: 0o700 });
  return account;
}
export function removeAccountFiles(id: string): void { rmSync(accountRoot(id), { recursive: true, force: true }); }
