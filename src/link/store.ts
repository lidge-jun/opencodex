import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { isLinkPort } from "./ports";
import { assertSshAlias } from "./ssh-argv";
import { parseExplicitRoute, type ExplicitRoute } from "./explicit-route";

/**
 * Persisted machine links. The file names hosts, ports, host-key fingerprints and data-key ids.
 * It never holds a key: keys live in the running proxy's `apiKeys`, and admission reads them there.
 */
export type LinkDirection = "hub-initiated" | "client-initiated";
export type LinkChildKind = "full" | "ephemeral";

export interface LinkRecord {
  id: string;
  alias: string;
  direction: LinkDirection;
  /**
   * `ssh-keygen -lf` fingerprint the user confirmed for the client host, e.g. "SHA256:…".
   * Null only for client-initiated links: the hub never opens SSH to that client.
   */
  hostKeyFingerprint: string | null;
  /** Port the tunnel listens on at the client machine's 127.0.0.1. */
  tunnelPort: number;
  /** Id of the data key issued for this link. */
  apiKeyId: string;
  createdAt: string;
  remotePlatform?: "posix" | "windows";
  childKind?: LinkChildKind;
  /**
   * Ordered SSH routes to the same machine, direct routes first and the relay alias last.
   * Absent means exactly [alias]; a list always contains alias, which stays the pinned host-key
   * name (HostKeyAlias) and the destination of every exec operation. Hub-initiated links only.
   */
  routes?: string[];
  /**
   * How ssh reaches alias, passed on the command line for every command and tunnel of this link, so
   * ssh_config cannot change it (src/link/explicit-route.ts). Fixed at enrollment; requires exclusive.
   */
  explicitRoute?: ExplicitRoute;
  /**
   * The link has exactly one route, its alias: no route list, and every route edit is refused.
   * Hub-initiated links only; absent means today's editable route list.
   */
  exclusive?: true;
}

export interface LinkStore {
  version: 1;
  /** Port of the link listener at this machine's 127.0.0.1, fixed once chosen. */
  listenerPort: number | null;
  links: LinkRecord[];
}

export class LinkStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkStoreError";
  }
}

export function emptyLinkStore(): LinkStore {
  return { version: 1, listenerPort: null, links: [] };
}

export function newLinkId(): string {
  return `lnk_${randomBytes(8).toString("hex")}`;
}

/** Most routes one link may list, the alias included. */
export const MAX_LINK_ROUTES = 8;

const RECORD_KEYS = new Set(["id", "alias", "direction", "hostKeyFingerprint", "tunnelPort", "apiKeyId", "createdAt", "remotePlatform", "childKind", "routes", "explicitRoute", "exclusive"]);
const STORE_KEYS = new Set(["version", "listenerPort", "links"]);
const API_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const FINGERPRINT = /^[A-Z0-9]+:[A-Za-z0-9+/=]{16,128}$/;

/** A trust-boundary file: an unknown field is an error, not something to drop silently. */
function assertOnlyKeys(raw: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new LinkStoreError(`${where} has an unknown field ${JSON.stringify(key)}`);
  }
}

const isListenerPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;

/** The routes the supervisor tries, in order. A one-route link is its alias. */
export function effectiveLinkRoutes(record: Pick<LinkRecord, "alias" | "routes">): string[] {
  return record.routes ? [...record.routes] : [record.alias];
}

/**
 * A valid route list, normalized: exactly [alias] becomes undefined so a one-route link keeps the
 * record an older Home reads. Null when the list is invalid.
 */
function parseRoutes(value: unknown, alias: string, direction: LinkDirection): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (direction !== "hub-initiated" || !Array.isArray(value) || value.length < 1 || value.length > MAX_LINK_ROUTES) return null;
  const seen = new Set<string>();
  for (const route of value) {
    if (typeof route !== "string" || seen.has(route)) return null;
    try { assertSshAlias(route); } catch { return null; }
    seen.add(route);
  }
  if (!seen.has(alias)) return null;
  return value.length === 1 ? undefined : [...value as string[]];
}

function parseRecord(value: unknown, index: number): LinkRecord {
  const fail = (field: string): never => { throw new LinkStoreError(`links[${index}].${field} is invalid`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LinkStoreError(`links[${index}] is not an object`);
  const raw = value as Record<string, unknown>;
  assertOnlyKeys(raw, RECORD_KEYS, `links[${index}]`);
  if (typeof raw.id !== "string" || !/^lnk_[0-9a-f]{16}$/.test(raw.id)) fail("id");
  if (typeof raw.alias !== "string") fail("alias");
  try { assertSshAlias(raw.alias as string); } catch { fail("alias"); }
  if (raw.direction !== "hub-initiated" && raw.direction !== "client-initiated") fail("direction");
  if (raw.remotePlatform !== undefined && raw.remotePlatform !== "posix" && raw.remotePlatform !== "windows") fail("remotePlatform");
  if (raw.childKind !== undefined && raw.childKind !== "full" && raw.childKind !== "ephemeral") fail("childKind");
  const fingerprint = raw.hostKeyFingerprint;
  if (fingerprint === null ? raw.direction !== "client-initiated"
    : typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) fail("hostKeyFingerprint");
  if (!isLinkPort(raw.tunnelPort)) fail("tunnelPort");
  if (typeof raw.apiKeyId !== "string" || !API_KEY_ID.test(raw.apiKeyId)) fail("apiKeyId");
  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) fail("createdAt");
  const routes = parseRoutes(raw.routes, raw.alias as string, raw.direction as LinkDirection);
  if (routes === null) fail("routes");
  // An exclusive link has one route, its alias; an explicit route is how that one route is reached.
  if (raw.exclusive !== undefined && (raw.exclusive !== true || raw.direction !== "hub-initiated")) fail("exclusive");
  if (raw.exclusive === true && raw.routes !== undefined) fail("routes");
  const explicitRoute = raw.explicitRoute === undefined ? undefined : parseExplicitRoute(raw.explicitRoute);
  if (explicitRoute === null) fail("explicitRoute");
  if (explicitRoute && raw.exclusive !== true) fail("exclusive");
  return {
    id: raw.id as string,
    alias: raw.alias as string,
    direction: raw.direction as LinkDirection,
    hostKeyFingerprint: fingerprint as string | null,
    tunnelPort: raw.tunnelPort as number,
    apiKeyId: raw.apiKeyId as string,
    createdAt: raw.createdAt as string,
    ...(raw.remotePlatform === undefined ? {} : { remotePlatform: raw.remotePlatform as "posix" | "windows" }),
    ...(raw.childKind === undefined ? {} : { childKind: raw.childKind as LinkChildKind }),
    ...(routes ? { routes } : {}),
    ...(explicitRoute ? { explicitRoute } : {}),
    ...(raw.exclusive === true ? { exclusive: true as const } : {}),
  };
}

export function parseLinkStore(text: string): LinkStore {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new LinkStoreError("links.json is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LinkStoreError("links.json is not an object");
  const body = raw as Record<string, unknown>;
  assertOnlyKeys(body, STORE_KEYS, "links.json");
  if (body.version !== 1) throw new LinkStoreError("links.json has an unsupported version");
  if (body.listenerPort !== null && !isListenerPort(body.listenerPort)) throw new LinkStoreError("listenerPort is invalid");
  if (!Array.isArray(body.links)) throw new LinkStoreError("links is not an array");
  const links = body.links.map(parseRecord);
  const ids = new Set(links.map(link => link.id));
  if (ids.size !== links.length) throw new LinkStoreError("links.json has duplicate link ids");
  return { version: 1, listenerPort: body.listenerPort as number | null, links };
}

/** A missing file is an empty store. A damaged file is an error, never silently empty. */
export function readLinkStore(path: string): LinkStore {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if (isMissingPathError(error)) return emptyLinkStore();
    throw error;
  }
  return parseLinkStore(text);
}

export function writeLinkStore(path: string, store: LinkStore): void {
  const normalized = parseLinkStore(JSON.stringify(store));
  const dir = dirname(path);
  assertNotRealHomeUnderTest(dirname(dir));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  else chmodSync(dir, 0o700);
  // atomicWriteFile hardens its private temp on Windows before the rename, so only POSIX needs
  // the explicit mode here.
  atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/**
 * Activation gate for the link listener: true only for a readable store with at least one link.
 * A damaged store keeps the listener closed rather than guessing.
 */
export function hasLinks(path: string): boolean {
  try { return readLinkStore(path).links.length > 0; } catch { return false; }
}
