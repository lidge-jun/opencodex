import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:tls";
import { createCertificateAuthority, createLocalInterceptCa, issueServerLeaf } from "../../src/claude/intercept/local-ca";
import {
  ensurePickerCa, issuePickerLeaf, pickerCaCertPath, pickerCaFingerprints,
  pickerLeafCertPath, pickerStateDir, PICKER_CA_COMMON_NAME, PICKER_HOST,
} from "../../src/claude/intercept/picker-ca";

function tempDir(): string { return mkdtempSync(join(tmpdir(), "ocx-picker-ca-")); }

function der(bytes: Buffer, offset: number): { tag: number; body: Buffer; next: number } {
  const tag = bytes[offset]!;
  let length = bytes[offset + 1]!;
  let start = offset + 2;
  if (length & 0x80) {
    const width = length & 0x7f;
    length = 0;
    for (let i = 0; i < width; i++) length = length * 256 + bytes[start++]!;
  }
  return { tag, body: bytes.subarray(start, start + length), next: start + length };
}

function parts(bytes: Buffer): ReturnType<typeof der>[] {
  const items = [];
  for (let at = 0; at < bytes.length;) {
    const item = der(bytes, at);
    items.push(item);
    at = item.next;
  }
  return items;
}

function constraints(certPem: string): { critical: boolean; dnsNames: string[]; excludedIps: string[] } | null {
  const root = der(new X509Certificate(certPem).raw, 0);
  const tbs = parts(root.body)[0]!;
  const wrapper = parts(tbs.body).find(item => item.tag === 0xa3)!;
  const extensions = parts(der(wrapper.body, 0).body);
  const matched = extensions.map(item => parts(item.body)).find(fields =>
    fields[0]?.tag === 0x06 && fields[0].body.equals(Buffer.from([0x55, 0x1d, 0x1e])));
  if (!matched) return null;
  const nc = parts(der(matched.at(-1)!.body, 0).body);
  const permitted = nc.find(field => field.tag === 0xa0);
  const excluded = nc.find(field => field.tag === 0xa1);
  return {
    critical: matched[1]?.tag === 0x01 && matched[1].body.equals(Buffer.from([0xff])),
    dnsNames: permitted ? parts(permitted.body).flatMap(subtree =>
      parts(subtree.body).filter(base => base.tag === 0x82).map(base => base.body.toString("ascii"))) : [],
    excludedIps: excluded ? parts(excluded.body).flatMap(subtree =>
      parts(subtree.body).filter(base => base.tag === 0x87).map(base => base.body.toString("hex"))) : [],
  };
}

const ALL_IPS = ["00".repeat(8), "00".repeat(32)];

test("picker root has a critical claude.ai-only DNS constraint that excludes every IP; intercept root remains unconstrained", () => {
  const ca = ensurePickerCa(tempDir());
  expect(new X509Certificate(ca.certPem).subject).toContain(`CN=${PICKER_CA_COMMON_NAME}`);
  expect(constraints(ca.certPem)).toEqual({ critical: true, dnsNames: [PICKER_HOST], excludedIps: ALL_IPS });
  expect(constraints(createLocalInterceptCa().certPem)).toBeNull();
  expect(ca.fingerprint).toBe(pickerCaFingerprints(ca.certPem).sha256);
  expect(pickerCaFingerprints(ca.certPem).sha1).toMatch(/^[0-9A-F]{40}$/);
});

test("picker leaf SAN is exactly claude.ai and verifies under its issuer", () => {
  const dir = tempDir();
  const ca = ensurePickerCa(dir);
  const leaf = issuePickerLeaf(ca, dir);
  const cert = new X509Certificate(leaf.certPem);
  expect(cert.subjectAltName).toBe("DNS:claude.ai");
  expect(cert.verify(ca.publicKey)).toBe(true);
  expect(cert.checkIssued(new X509Certificate(ca.certPem))).toBe(true);
  expect(readFileSync(pickerLeafCertPath(dir), "utf8")).toBe(leaf.certPem);
});

async function handshake(caPem: string, pair: { certPem: string; keyPem: string }, host: string): Promise<boolean> {
  const server = createServer({ cert: pair.certPem, key: pair.keyPem }, socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  try {
    return await new Promise<boolean>(resolve => {
      const socket = connect({ host: "127.0.0.1", port: address.port, servername: host,
        ca: caPem, rejectUnauthorized: true });
      socket.once("secureConnect", () => { resolve(socket.authorized); socket.destroy(); });
      socket.once("error", () => { resolve(false); socket.destroy(); });
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("TLS accepts claude.ai and rejects an off-host leaf issued by the picker root", async () => {
  const dir = tempDir();
  const ca = ensurePickerCa(dir);
  expect(await handshake(ca.certPem, issuePickerLeaf(ca, dir), PICKER_HOST)).toBe(true);
  const offHost = issueServerLeaf(ca, PICKER_CA_COMMON_NAME, ["example.com"]);
  expect(await handshake(ca.certPem, offHost, "example.com")).toBe(false);
});

async function ipHandshake(caPem: string, pair: { certPem: string; keyPem: string }): Promise<boolean> {
  const server = createServer({ cert: pair.certPem, key: pair.keyPem }, socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  try {
    return await new Promise<boolean>(resolve => {
      const socket = connect({ host: "127.0.0.1", port: address.port, ca: caPem, rejectUnauthorized: true });
      socket.once("secureConnect", () => { resolve(socket.authorized); socket.destroy(); });
      socket.once("error", () => { resolve(false); socket.destroy(); });
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("TLS rejects an IP-address leaf issued by the picker root", async () => {
  const ipLeaf = (ca: Parameters<typeof issueServerLeaf>[0]) => issueServerLeaf(ca, PICKER_CA_COMMON_NAME, ["127.0.0.1"]);
  expect(new X509Certificate(ipLeaf(createLocalInterceptCa()).certPem).subjectAltName).toBe("IP Address:127.0.0.1");
  // Control: the same leaf shape verifies under an unconstrained root.
  const unconstrained = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME });
  expect(await ipHandshake(unconstrained.certPem, ipLeaf(unconstrained))).toBe(true);
  const ca = ensurePickerCa(tempDir());
  expect(await ipHandshake(ca.certPem, ipLeaf(ca))).toBe(false);
});

test("picker authority persists private key at 0600 and regenerates a corrupt key", () => {
  const dir = tempDir();
  const first = ensurePickerCa(dir);
  expect(ensurePickerCa(dir).fingerprint).toBe(first.fingerprint);
  if (process.platform !== "win32") expect(statSync(join(pickerStateDir(dir), "ca.key")).mode & 0o777).toBe(0o600);
  writeFileSync(join(pickerStateDir(dir), "ca.key"), "corrupt\n");
  const repaired = ensurePickerCa(dir);
  expect(repaired.fingerprint).not.toBe(first.fingerprint);
  expect(constraints(readFileSync(pickerCaCertPath(dir), "utf8"))?.dnsNames).toEqual([PICKER_HOST]);
});

test("a valid key-matching but unconstrained persisted CA is rotated", () => {
  const dir = tempDir();
  const first = ensurePickerCa(dir);
  const unconstrained = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME });
  writeFileSync(pickerCaCertPath(dir), unconstrained.certPem);
  writeFileSync(join(pickerStateDir(dir), "ca.key"), unconstrained.keyPem);
  const repaired = ensurePickerCa(dir);
  expect(repaired.fingerprint).not.toBe(first.fingerprint);
  expect(repaired.fingerprint).not.toBe(pickerCaFingerprints(unconstrained.certPem).sha256);
  expect(constraints(repaired.certPem)?.dnsNames).toEqual([PICKER_HOST]);
});

test("a claude.ai-constrained CA without the IP exclusion (the first format) is rotated", () => {
  const dir = tempDir();
  ensurePickerCa(dir);
  const legacy = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST], excludeAllIpAddresses: false });
  expect(constraints(legacy.certPem)?.excludedIps).toEqual([]);
  writeFileSync(pickerCaCertPath(dir), legacy.certPem);
  writeFileSync(join(pickerStateDir(dir), "ca.key"), legacy.keyPem);
  const repaired = ensurePickerCa(dir);
  expect(repaired.fingerprint).not.toBe(pickerCaFingerprints(legacy.certPem).sha256);
  expect(constraints(repaired.certPem)?.excludedIps).toEqual(ALL_IPS);
});

test("a valid constrained CA with the wrong name or DNS scope is rotated", () => {
  for (const options of [
    { commonName: "other local CA", permittedDnsNames: [PICKER_HOST] },
    { commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: ["example.com"] },
  ]) {
    const dir = tempDir();
    ensurePickerCa(dir);
    const other = createCertificateAuthority(options);
    writeFileSync(pickerCaCertPath(dir), other.certPem);
    writeFileSync(join(pickerStateDir(dir), "ca.key"), other.keyPem);
    const repaired = ensurePickerCa(dir);
    expect(repaired.fingerprint).not.toBe(pickerCaFingerprints(other.certPem).sha256);
    expect(constraints(repaired.certPem)?.dnsNames).toEqual([PICKER_HOST]);
  }
});
