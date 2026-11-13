import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollow, isMissingPathError } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { getConfigDir } from "../config/paths";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir, hardenSecretPath, verifySecretPathAcl, windowsSecretAclApplies } from "../lib/windows-secret-acl";
import { linkDir, linkStorePath } from "./paths";
import { isOperationId } from "./operations-journal";
import { parseLinkStore, readLinkStore, type LinkRecord, type LinkStore } from "./store";

/** How the removal that claimed the receipt cleaned up its Child before the commit: a retry must ask for the same. */
export type LinkRetirementMode = "force" | "disconnect" | "purge";
/**
 * operationId names the journalled revoke that claimed the receipt: only that operation's replay resumes it (#8416),
 * so a recorded revoke is never credited with, or skips its own cleanup through, another removal's receipt.
 */
export interface LinkRetirement { version: 1; link: LinkRecord; nonce: string; mode?: LinkRetirementMode; operationId?: string }
export class LinkRetirementError extends Error {
  constructor(message: string) { super(message); this.name = "LinkRetirementError"; }
}
const ID = /^lnk_[0-9a-f]{16}$/;
const NONCE = /^[0-9a-f]{64}$/;

function pathFor(id: string, configDir: string): string {
  if (!ID.test(id)) throw new LinkRetirementError("invalid link id");
  return join(linkDir(configDir), `retirement-${id}.json`);
}
function parse(text: string, id: string): LinkRetirement {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new LinkRetirementError("invalid retirement JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LinkRetirementError("invalid retirement record");
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  const allowed = new Set(["version", "link", "nonce", "mode", "operationId"]);
  if (keys.some(key => !allowed.has(key)) || !("link" in value) || value.version !== 1 || typeof value.nonce !== "string" || !NONCE.test(value.nonce)
    || (value.mode !== undefined && value.mode !== "force" && value.mode !== "disconnect" && value.mode !== "purge")
    || (value.operationId !== undefined && !isOperationId(value.operationId))) {
    throw new LinkRetirementError("invalid retirement record");
  }
  let link: LinkRecord;
  try { link = parseLinkStore(JSON.stringify({ version: 1, listenerPort: null, links: [value.link] })).links[0]!; }
  catch { throw new LinkRetirementError("invalid retirement link"); }
  if (link.id !== id) throw new LinkRetirementError("retirement id mismatch");
  return { version: 1, link, nonce: value.nonce, ...(value.mode === undefined ? {} : { mode: value.mode as LinkRetirementMode }),
    ...(value.operationId === undefined ? {} : { operationId: value.operationId as string }) };
}
function sameLink(a: LinkRecord, b: LinkRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
/** A receipt whose provenance cannot be established: see readTrustedLinkRetirement. */
export class LinkRetirementUntrustedError extends LinkRetirementError {
  constructor(message: string) { super(message); this.name = "LinkRetirementUntrustedError"; }
}
const ownUid = (): number | undefined => typeof process.getuid === "function" ? process.getuid() : undefined;
function privateDirectory(path: string): boolean {
  const entry = lstatSync(path);
  return entry.isDirectory() && !entry.isSymbolicLink() && (entry.mode & 0o022) === 0 && (ownUid() === undefined || entry.uid === ownUid());
}
/**
 * Read a receipt only when this user demonstrably wrote it (#8416). A receipt lets a removal skip the Child cleanup it
 * records, so one another principal could plant, now or before the directories were last tightened, must not be
 * honoured. On POSIX the config root and its link directory must be real directories owned by this user and writable
 * by no one else, and the receipt a single-link regular file owned by this user with no group or other access, read
 * without following a link and checked to be the file that was inspected. On Windows both directories must hold the
 * owner-only ACL and the receipt must carry this user as owner under a protected DACL. Missing is null; anything else
 * throws LinkRetirementUntrustedError, or LinkRetirementError for a malformed record.
 */
export function readTrustedLinkRetirement(id: string, configDir: string = getConfigDir()): LinkRetirement | null {
  const path = pathFor(id, configDir);
  let entry;
  try { entry = lstatSync(path); } catch (error) { if (isMissingPathError(error)) return null; throw error; }
  const untrusted = () => new LinkRetirementUntrustedError("the link retirement receipt's provenance cannot be established");
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw untrusted();
  if (windowsSecretAclApplies()) {
    try {
      hardenSecretDir(configDir, { required: true, timeoutMemoKey: `${configDir}::link-retirement` });
      hardenSecretDir(linkDir(configDir), { required: true });
    } catch { throw untrusted(); }
    if (!verifySecretPathAcl(path)) throw untrusted();
    return parse(readFileSync(path, "utf8"), id);
  }
  if (!privateDirectory(configDir) || !privateDirectory(linkDir(configDir))) throw untrusted();
  if ((entry.mode & 0o077) !== 0 || (ownUid() !== undefined && entry.uid !== ownUid())) throw untrusted();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== entry.dev || opened.ino !== entry.ino) throw untrusted();
    return parse(readFileSync(fd, "utf8"), id);
  } finally { closeSync(fd); }
}
/** Missing is distinct from malformed; malformed records always throw. */
export function readLinkRetirement(id: string, configDir: string = getConfigDir()): LinkRetirement | null {
  const path = pathFor(id, configDir);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) { if (isMissingPathError(error)) return null; throw error; }
  return parse(text, id);
}
/** Claims only the still-current full link. A competing or damaged receipt is never replaced. */
export function claimLinkRetirement(link: LinkRecord, configDir: string = getConfigDir(), readStore?: () => LinkStore, mode?: LinkRetirementMode, operationId?: string): LinkRetirement {
  const candidate = parse(JSON.stringify({ version: 1, link, nonce: randomBytes(32).toString("hex"), ...(mode ? { mode } : {}), ...(operationId ? { operationId } : {}) }), link.id);
  assertNotRealHomeUnderTest(configDir);
  return withConfigMutationLockSync(() => {
    const path = pathFor(candidate.link.id, configDir);
    if (readLinkRetirement(candidate.link.id, configDir)) throw new LinkRetirementError("retirement already claimed");
    const store = readStore ? parseLinkStore(JSON.stringify(readStore())) : readLinkStore(linkStorePath(configDir));
    const current = store.links.find(item => item.id === candidate.link.id);
    if (!current || !sameLink(current, candidate.link)) throw new LinkRetirementError("link identity changed");
    const dir = linkDir(configDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") hardenSecretDir(dir, { required: true });
    else chmodSync(dir, 0o700);
    atomicWriteFileNoFollow(path, `${JSON.stringify(candidate, null, 2)}\n`, undefined, {}, { exclusive: true });
    // readTrustedLinkRetirement requires this user as owner under a protected DACL on Windows.
    if (process.platform === "win32") hardenSecretPath(path, { required: true });
    return candidate;
  }, configDir);
}
/** Clear only the exact receipt previously read or claimed, under the config mutation lock. */
export function clearLinkRetirement(expected: LinkRetirement, configDir: string = getConfigDir(), safeToClear?: () => boolean): boolean {
  const owner = parse(JSON.stringify(expected), expected.link.id);
  assertNotRealHomeUnderTest(configDir);
  return withConfigMutationLockSync(() => {
    const current = readLinkRetirement(owner.link.id, configDir);
    if (!current || current.nonce !== owner.nonce || !sameLink(current.link, owner.link) || (safeToClear && !safeToClear())) return false;
    unlinkSync(pathFor(owner.link.id, configDir));
    return true;
  }, configDir);
}
