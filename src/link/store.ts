import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { isLinkPort } from "./ports";
import { assertSshAlias } from "./ssh-argv";

/**
 * Persisted machine links. The file names hosts, ports, host-key fingerprints and data-key ids.
 * It never holds a key: keys live in the running proxy's `apiKeys`, and admission reads them there.
 */
export type LinkDirection = "hub-initiated" | "client-initiated";

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

const RECORD_KEYS = new Set(["id", "alias", "direction", "hostKeyFingerprint", "tunnelPort", "apiKeyId", "createdAt"]);
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

function parseRecord(value: unknown, index: number): LinkRecord {
  const fail = (field: string): never => { throw new LinkStoreError(`links[${index}].${field} is invalid`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LinkStoreError(`links[${index}] is not an object`);
  const raw = value as Record<string, unknown>;
  assertOnlyKeys(raw, RECORD_KEYS, `links[${index}]`);
  if (typeof raw.id !== "string" || !/^lnk_[0-9a-f]{16}$/.test(raw.id)) fail("id");
  if (typeof raw.alias !== "string") fail("alias");
  try { assertSshAlias(raw.alias as string); } catch { fail("alias"); }
  if (raw.direction !== "hub-initiated" && raw.direction !== "client-initiated") fail("direction");
  const fingerprint = raw.hostKeyFingerprint;
  if (fingerprint === null ? raw.direction !== "client-initiated"
    : typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) fail("hostKeyFingerprint");
  if (!isLinkPort(raw.tunnelPort)) fail("tunnelPort");
  if (typeof raw.apiKeyId !== "string" || !API_KEY_ID.test(raw.apiKeyId)) fail("apiKeyId");
  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) fail("createdAt");
  return {
    id: raw.id as string,
    alias: raw.alias as string,
    direction: raw.direction as LinkDirection,
    hostKeyFingerprint: fingerprint as string | null,
    tunnelPort: raw.tunnelPort as number,
    apiKeyId: raw.apiKeyId as string,
    createdAt: raw.createdAt as string,
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
