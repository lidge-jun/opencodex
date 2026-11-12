import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollow, isMissingPathError } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { getConfigDir } from "../config/paths";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { linkDir, linkStorePath } from "./paths";
import { parseLinkStore, readLinkStore, type LinkRecord, type LinkStore } from "./store";

export interface LinkRetirement { version: 1; link: LinkRecord; nonce: string }
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
  if (Object.keys(value).sort().join(",") !== "link,nonce,version" || value.version !== 1 || typeof value.nonce !== "string" || !NONCE.test(value.nonce)) {
    throw new LinkRetirementError("invalid retirement record");
  }
  let link: LinkRecord;
  try { link = parseLinkStore(JSON.stringify({ version: 1, listenerPort: null, links: [value.link] })).links[0]!; }
  catch { throw new LinkRetirementError("invalid retirement link"); }
  if (link.id !== id) throw new LinkRetirementError("retirement id mismatch");
  return { version: 1, link, nonce: value.nonce };
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
export function claimLinkRetirement(link: LinkRecord, configDir: string = getConfigDir(), readStore?: () => LinkStore): LinkRetirement {
  const candidate = parse(JSON.stringify({ version: 1, link, nonce: randomBytes(32).toString("hex") }), link.id);
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
