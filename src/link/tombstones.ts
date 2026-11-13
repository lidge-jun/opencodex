import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { linkDir } from "./paths";
import { parseExplicitRoute, type ExplicitRoute } from "./explicit-route";
import { assertSshAlias } from "./ssh-argv";
import { MAX_LINK_ROUTES } from "./store";

/**
 * Tombstones for ephemeral links whose Child was never cleaned (lane O5 of the disposable-machines
 * design). A forced revoke skips the remote disconnect, so the link record and key go while the
 * planted ocx-child may still hold that link's state and CODEX_HOME changes. The tombstone keeps
 * what ocx link recover needs to reach that machine over the same pinned SSH trust, and stays until
 * the Child's own receipt proves cleanup. It holds no key.
 */
export interface LinkTombstone {
  linkId: string;
  alias: string;
  hostKeyFingerprint: string;
  remotePlatform?: "posix" | "windows";
  /** The link's route list when it had several; recover uses only alias, the pinned name. */
  routes?: string[];
  /** The link's explicit route (src/link/explicit-route.ts); recover reaches the machine over it. */
  explicitRoute?: ExplicitRoute;
  /** The link was exclusive: no other route may reach it. Required by explicitRoute. */
  exclusive?: true;
  revokedAt: string;
  /**
   * Fields a later Home adds go here, never at the top level: this Home keeps them verbatim when it
   * rewrites the file and reads none of them, so a newer Home's tombstone never makes an older one
   * refuse forced revokes. A change older Homes must not ignore bumps the store version instead.
   */
  ext?: Record<string, unknown>;
}

export interface LinkTombstoneStore {
  version: 1;
  tombstones: LinkTombstone[];
}

export class LinkTombstoneStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkTombstoneStoreError";
  }
}

/** At most this many forced revokes wait for cleanup; a forced revoke beyond it is refused, never dropped. */
export const MAX_TOMBSTONES = 256;
const MAX_EXT_BYTES = 4096;

export class LinkTombstoneLimitError extends Error {
  constructor() {
    super(`at most ${MAX_TOMBSTONES} link tombstones can wait for cleanup`);
    this.name = "LinkTombstoneLimitError";
  }
}

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const FINGERPRINT = /^[A-Z0-9]+:[A-Za-z0-9+/=]{16,128}$/;
const KEYS = new Set(["linkId", "alias", "hostKeyFingerprint", "remotePlatform", "routes", "explicitRoute", "exclusive", "revokedAt", "ext"]);

export function tombstonesPath(configDir?: string): string {
  return join(linkDir(configDir), "tombstones.json");
}

function isAlias(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { assertSshAlias(value); return true; } catch { return false; }
}

function parseTombstone(value: unknown, index: number): LinkTombstone {
  const fail = (): never => { throw new LinkTombstoneStoreError(`tombstones[${index}] is invalid`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !KEYS.has(key))) fail();
  if (typeof raw.linkId !== "string" || !LINK_ID.test(raw.linkId)) fail();
  if (!isAlias(raw.alias)) fail();
  if (typeof raw.hostKeyFingerprint !== "string" || !FINGERPRINT.test(raw.hostKeyFingerprint)) fail();
  if (raw.remotePlatform !== undefined && raw.remotePlatform !== "posix" && raw.remotePlatform !== "windows") fail();
  if (raw.routes !== undefined) {
    const routes: unknown = raw.routes;
    if (!Array.isArray(routes) || routes.length < 2 || routes.length > MAX_LINK_ROUTES
      || !routes.every(isAlias) || !routes.includes(raw.alias as string) || new Set(routes).size !== routes.length) fail();
  }
  if (typeof raw.revokedAt !== "string" || Number.isNaN(Date.parse(raw.revokedAt))) fail();
  if (raw.exclusive !== undefined && (raw.exclusive !== true || raw.routes !== undefined)) fail();
  const explicitRoute = raw.explicitRoute === undefined ? undefined : parseExplicitRoute(raw.explicitRoute);
  if (explicitRoute === null || (explicitRoute && raw.exclusive !== true)) fail();
  const ext = raw.ext;
  if (ext !== undefined && (!ext || typeof ext !== "object" || Array.isArray(ext) || Buffer.byteLength(JSON.stringify(ext), "utf8") > MAX_EXT_BYTES)) fail();
  return {
    linkId: raw.linkId as string,
    alias: raw.alias as string,
    hostKeyFingerprint: raw.hostKeyFingerprint as string,
    ...(raw.remotePlatform === undefined ? {} : { remotePlatform: raw.remotePlatform as "posix" | "windows" }),
    ...(raw.routes === undefined ? {} : { routes: [...raw.routes as string[]] }),
    ...(explicitRoute ? { explicitRoute } : {}),
    ...(raw.exclusive === true ? { exclusive: true as const } : {}),
    revokedAt: raw.revokedAt as string,
    ...(ext === undefined ? {} : { ext: JSON.parse(JSON.stringify(ext)) as Record<string, unknown> }),
  };
}

export function parseTombstones(text: string): LinkTombstoneStore {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new LinkTombstoneStoreError("tombstones.json is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LinkTombstoneStoreError("tombstones.json is not an object");
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== "version" && key !== "tombstones") || body.version !== 1 || !Array.isArray(body.tombstones)) {
    throw new LinkTombstoneStoreError("tombstones.json has an invalid shape");
  }
  if (body.tombstones.length > MAX_TOMBSTONES) throw new LinkTombstoneStoreError("tombstones.json has too many entries");
  const tombstones = body.tombstones.map(parseTombstone);
  if (new Set(tombstones.map(t => t.linkId)).size !== tombstones.length) throw new LinkTombstoneStoreError("tombstones.json has duplicate link ids");
  return { version: 1, tombstones };
}

/**
 * A missing file is empty. A damaged file is an error: it is the only evidence that a Child still
 * needs cleanup, so it is never read as empty and never overwritten.
 */
export function readTombstones(path: string = tombstonesPath()): LinkTombstoneStore {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if (isMissingPathError(error)) return { version: 1, tombstones: [] };
    throw error;
  }
  return parseTombstones(text);
}

function writeTombstones(path: string, store: LinkTombstoneStore): void {
  const normalized = parseTombstones(JSON.stringify(store));
  const dir = dirname(path);
  assertNotRealHomeUnderTest(dirname(dir));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  else chmodSync(dir, 0o700);
  atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/** Add or replace the tombstone for tombstone.linkId. Callers hold the config mutation lock. */
export function recordTombstone(tombstone: LinkTombstone, path: string = tombstonesPath()): void {
  const current = readTombstones(path);
  const others = current.tombstones.filter(t => t.linkId !== tombstone.linkId);
  if (others.length >= MAX_TOMBSTONES) throw new LinkTombstoneLimitError();
  writeTombstones(path, { version: 1, tombstones: [...others, tombstone] });
}

/** Remove the tombstone for linkId; true when one was removed. Callers hold the config mutation lock. */
export function removeTombstone(linkId: string, path: string = tombstonesPath()): boolean {
  const current = readTombstones(path);
  const next = current.tombstones.filter(t => t.linkId !== linkId);
  if (next.length === current.tombstones.length) return false;
  writeTombstones(path, { version: 1, tombstones: next });
  return true;
}
