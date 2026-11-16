import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollow, isMissingPathError } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { getConfigDir } from "../config/paths";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { linkDir, linkStorePath } from "./paths";
import { isOperationId } from "./operations-journal";
import { parseLinkStore, readLinkStore, type LinkRecord, type LinkStore } from "./store";

/** How the removal that claimed the receipt cleaned up its Child before the commit: a retry must ask for the same. */
export type LinkRetirementMode = "force" | "disconnect" | "purge";
/**
 * operationId names the journalled revoke that claimed the receipt: only that operation's replay resumes it (#8416),
 * so a recorded revoke is never credited with, or skips its own cleanup through, another removal's receipt.
 */
/**
 * formerOwner names the operation a plain --force took the receipt over from (disownLinkRetirement): that operation may
 * take it back only while the force has provably committed nothing (#8416).
 */
export interface LinkRetirement { version: 1; link: LinkRecord; nonce: string; mode?: LinkRetirementMode; operationId?: string; formerOwner?: string }
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
  const allowed = new Set(["version", "link", "nonce", "mode", "operationId", "formerOwner"]);
  if (keys.some(key => !allowed.has(key)) || !("link" in value) || value.version !== 1 || typeof value.nonce !== "string" || !NONCE.test(value.nonce)
    || (value.mode !== undefined && value.mode !== "force" && value.mode !== "disconnect" && value.mode !== "purge")
    || (value.operationId !== undefined && !isOperationId(value.operationId))
    || (value.formerOwner !== undefined && (!isOperationId(value.formerOwner) || value.operationId !== undefined))) {
    throw new LinkRetirementError("invalid retirement record");
  }
  let link: LinkRecord;
  try { link = parseLinkStore(JSON.stringify({ version: 1, listenerPort: null, links: [value.link] })).links[0]!; }
  catch { throw new LinkRetirementError("invalid retirement link"); }
  if (link.id !== id) throw new LinkRetirementError("retirement id mismatch");
  return { version: 1, link, nonce: value.nonce, ...(value.mode === undefined ? {} : { mode: value.mode as LinkRetirementMode }),
    ...(value.operationId === undefined ? {} : { operationId: value.operationId as string }),
    ...(value.formerOwner === undefined ? {} : { formerOwner: value.formerOwner as string }) };
}
function sameLink(a: LinkRecord, b: LinkRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
    return candidate;
  }, configDir);
}
/**
 * Take an owned receipt over for a plain --force (#8416): rewrite the exact receipt (same nonce, link and mode) without
 * its operation id, under the config mutation lock, before the force changes anything. From then on the original
 * operation no longer owns it, so a later replay of that operation cannot resume it and be credited with the force's
 * removal. Returns the rewritten receipt, or null when the receipt changed.
 */
export function disownLinkRetirement(expected: LinkRetirement, configDir: string = getConfigDir()): LinkRetirement | null {
  const owner = parse(JSON.stringify(expected), expected.link.id);
  assertNotRealHomeUnderTest(configDir);
  return withConfigMutationLockSync(() => {
    const current = readLinkRetirement(owner.link.id, configDir);
    if (!current || current.nonce !== owner.nonce || !sameLink(current.link, owner.link)) return null;
    if (current.operationId === undefined) return current;
    const { operationId: former, ...unowned } = current;
    const next = parse(JSON.stringify({ ...unowned, formerOwner: former }), owner.link.id);
    atomicWriteFileNoFollow(pathFor(owner.link.id, configDir), JSON.stringify(next, null, 2) + "\n");
    return next;
  }, configDir);
}
/**
 * Undo disownLinkRetirement for a plain --force takeover that stopped before its removal began (#8416): give the exact
 * receipt (same nonce and link, still without an owner) back to the operation that claimed it, under the config lock.
 */
export function reownLinkRetirement(expected: LinkRetirement, operationId: string, configDir: string = getConfigDir()): boolean {
  const owner = parse(JSON.stringify(expected), expected.link.id);
  assertNotRealHomeUnderTest(configDir);
  return withConfigMutationLockSync(() => {
    const current = readLinkRetirement(owner.link.id, configDir);
    if (!current || current.nonce !== owner.nonce || !sameLink(current.link, owner.link) || current.operationId !== undefined) return false;
    const { formerOwner: _former, ...rest } = current;
    const next = parse(JSON.stringify({ ...rest, operationId }), owner.link.id);
    atomicWriteFileNoFollow(pathFor(owner.link.id, configDir), JSON.stringify(next, null, 2) + "\n");
    return true;
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
