import { chmodSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { linkDir } from "../link/paths";
import { isLinkPort } from "../link/ports";
import { assertSshAlias } from "../link/ssh-argv";

/**
 * The client-owned half of a client-initiated link, stored beside the hub-side `links.json`
 * as `<configDir>/link/client-link.json` (directory 0700, file 0600). It holds no key: the
 * data key lives only in the client connection config, which already owns it.
 */
export interface ClientLinkState {
  linkId: string;
  alias: string;
  hubHostKeyFingerprint: string;
  peerListenerPort: number;
  tunnelPort: number;
}

export class ClientLinkStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClientLinkStateError";
  }
}

const FIELDS = new Set(["linkId", "alias", "hubHostKeyFingerprint", "peerListenerPort", "tunnelPort"]);
const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const FINGERPRINT = /^[A-Z0-9]+:[A-Za-z0-9+/=]{16,128}$/;

const isPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;

export function clientLinkStatePath(configDir?: string): string {
  return join(linkDir(configDir), "client-link.json");
}

export function parseClientLinkState(value: unknown): ClientLinkState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClientLinkStateError("client-link.json is not an object");
  const raw = value as Record<string, unknown>;
  const fail = (field: string): never => { throw new ClientLinkStateError(`client-link.${field} is invalid`); };
  for (const field of Object.keys(raw)) if (!FIELDS.has(field)) fail(field);
  if (typeof raw.linkId !== "string" || !LINK_ID.test(raw.linkId)) fail("linkId");
  if (typeof raw.alias !== "string") fail("alias");
  try {
    assertSshAlias(raw.alias as string);
  } catch {
    fail("alias");
  }
  if (typeof raw.hubHostKeyFingerprint !== "string" || !FINGERPRINT.test(raw.hubHostKeyFingerprint)) fail("hubHostKeyFingerprint");
  if (!isPort(raw.peerListenerPort)) fail("peerListenerPort");
  if (!isLinkPort(raw.tunnelPort)) fail("tunnelPort");
  return {
    linkId: raw.linkId as string,
    alias: raw.alias as string,
    hubHostKeyFingerprint: raw.hubHostKeyFingerprint as string,
    peerListenerPort: raw.peerListenerPort as number,
    tunnelPort: raw.tunnelPort as number,
  };
}

/** `null` when no sidecar exists. A present but unreadable or malformed sidecar throws. */
export function readClientLinkState(path: string = clientLinkStatePath()): ClientLinkState | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ClientLinkStateError("client-link.json is not valid JSON", { cause: error });
  }
  return parseClientLinkState(raw);
}

export function writeClientLinkState(state: ClientLinkState, path: string = clientLinkStatePath()): void {
  const normalized = parseClientLinkState(state);
  const dir = dirname(path);
  assertNotRealHomeUnderTest(dirname(dir));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  else chmodSync(dir, 0o700);
  // atomicWriteFile hardens its private temp on Windows before the rename, so only POSIX needs
  // the explicit mode on the final path.
  atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/**
 * Deletes the sidecar only while it still names `expectedLinkId`. Returns false when there was
 * nothing to delete or it belongs to a different link, which callers treat as "not ours".
 */
export function clearClientLinkState(expectedLinkId: string, path: string = clientLinkStatePath()): boolean {
  const current = readClientLinkState(path);
  if (!current || current.linkId !== expectedLinkId) return false;
  try {
    unlinkSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  return true;
}
