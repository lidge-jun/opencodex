import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_IP_ADDRESS_BASES,
  ensurePersistedAuthority,
  issueServerLeaf,
  type LocalInterceptCa,
  type PemKeyPair,
} from "./local-ca";

/** Separate root for Desktop traffic: its critical DNS constraint is checked on every reload. */
export const PICKER_HOST = "claude.ai";
export const PICKER_CA_COMMON_NAME = "opencodex Claude Desktop Picker CA";
export const PICKER_STATE_DIR = "claude-picker";

export interface PickerCa extends LocalInterceptCa { fingerprint: string }

export function pickerStateDir(configDir: string): string { return join(configDir, PICKER_STATE_DIR); }
export function pickerCaCertPath(configDir: string): string { return join(pickerStateDir(configDir), "ca.pem"); }
export function pickerLeafCertPath(configDir: string): string { return join(pickerStateDir(configDir), "leaf.pem"); }

export function pickerCaFingerprints(certPem: string): { sha1: string; sha256: string } {
  const der = new X509Certificate(certPem).raw;
  return {
    sha1: createHash("sha1").update(der).digest("hex").toUpperCase(),
    sha256: createHash("sha256").update(der).digest("hex").toUpperCase(),
  };
}

interface DerItem { tag: number; body: Buffer; next: number }

function readDer(bytes: Buffer, at: number): DerItem | null {
  if (at + 2 > bytes.length) return null;
  const tag = bytes[at]!;
  let length = bytes[at + 1]!;
  let cursor = at + 2;
  if (length & 0x80) {
    const width = length & 0x7f;
    if (width === 0 || width > 4 || cursor + width > bytes.length) return null;
    length = 0;
    for (let i = 0; i < width; i++) length = length * 256 + bytes[cursor++]!;
  }
  if (cursor + length > bytes.length) return null;
  return { tag, body: bytes.subarray(cursor, cursor + length), next: cursor + length };
}

function children(bytes: Buffer): DerItem[] | null {
  const out: DerItem[] = [];
  for (let cursor = 0; cursor < bytes.length;) {
    const item = readDer(bytes, cursor);
    if (!item) return null;
    out.push(item);
    cursor = item.next;
  }
  return out;
}

function constrainedToPickerHost(value: Buffer): boolean {
  const root = readDer(value, 0);
  if (!root || root.tag !== 0x30 || root.next !== value.length) return false;
  const fields = children(root.body);
  // permittedSubtrees [0] with exactly claude.ai, excludedSubtrees [1] with every IPv4 and IPv6 address.
  if (!fields || fields.length !== 2 || fields[0]!.tag !== 0xa0 || fields[1]!.tag !== 0xa1) return false;
  const excluded = children(fields[1]!.body);
  if (!excluded || excluded.length !== ALL_IP_ADDRESS_BASES.length) return false;
  const excludesAllIps = excluded.every((subtree, index) => {
    if (subtree.tag !== 0x30) return false;
    const base = children(subtree.body);
    return !!base && base.length === 1 && base[0]!.tag === 0x87
      && base[0]!.body.equals(Buffer.from(ALL_IP_ADDRESS_BASES[index]!));
  });
  if (!excludesAllIps) return false;
  const subtrees = children(fields[0]!.body);
  if (!subtrees || subtrees.length !== 1 || subtrees[0]!.tag !== 0x30) return false;
  const subtree = children(subtrees[0]!.body);
  return !!subtree && subtree.length === 1 && subtree[0]!.tag === 0x82
    && subtree[0]!.body.equals(Buffer.from(PICKER_HOST, "ascii"));
}

/** Inspect the extension itself; X509Certificate does not expose nameConstraints. */
function acceptsPickerAuthority(cert: X509Certificate): boolean {
  if (!cert.subject.split("\n").includes(`CN=${PICKER_CA_COMMON_NAME}`)) return false;
  const root = readDer(cert.raw, 0);
  if (!root || root.tag !== 0x30 || root.next !== cert.raw.length) return false;
  const certificate = children(root.body);
  if (!certificate || certificate[0]?.tag !== 0x30) return false;
  const tbs = children(certificate[0].body);
  const extensionField = tbs?.find(item => item.tag === 0xa3);
  const wrapped = extensionField && readDer(extensionField.body, 0);
  if (!wrapped || wrapped.tag !== 0x30 || wrapped.next !== extensionField!.body.length) return false;
  const extensions = children(wrapped.body);
  if (!extensions) return false;
  const matches = extensions.filter(item => {
    if (item.tag !== 0x30) return false;
    const fields = children(item.body);
    return fields?.[0]?.tag === 0x06 && fields[0].body.equals(Buffer.from([0x55, 0x1d, 0x1e]));
  });
  if (matches.length !== 1) return false;
  const fields = children(matches[0]!.body);
  return !!fields && fields.length === 3
    && fields[1]!.tag === 0x01 && fields[1]!.body.equals(Buffer.from([0xff]))
    && fields[2]!.tag === 0x04 && constrainedToPickerHost(fields[2]!.body);
}

export function ensurePickerCa(configDir: string): PickerCa {
  const ca = ensurePersistedAuthority(
    pickerStateDir(configDir),
    { commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] },
    "ca-publication.sqlite",
    acceptsPickerAuthority,
  );
  return { ...ca, fingerprint: pickerCaFingerprints(ca.certPem).sha256 };
}

/** Persist only the public leaf, so trust inspection verifies this exact local issuer. */
export function issuePickerLeaf(ca: PickerCa, configDir: string): PemKeyPair {
  const leaf = issueServerLeaf(ca, PICKER_CA_COMMON_NAME, [PICKER_HOST]);
  const path = pickerLeafCertPath(configDir);
  mkdirSync(pickerStateDir(configDir), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, leaf.certPem, { mode: 0o644 });
  try { chmodSync(tmp, 0o644); } catch { /* best-effort on platforms without POSIX modes */ }
  renameSync(tmp, path);
  return leaf;
}
