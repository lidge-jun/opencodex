import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connect, createServer } from "node:tls";
import { createCertificateAuthority, createLocalInterceptCa, issueServerLeaf, mintAuthorityWithExtensionsForTests } from "../../src/claude/intercept/local-ca";
import { drainPendingPickerCaUntrust } from "../../src/claude/intercept/picker-ca-cleanup";
import {
  acknowledgePendingPickerCaUntrust, acceptsPickerAuthority, ensurePickerCa, issuePickerLeaf, pickerCaCertPath, pickerCaFingerprints,
  pickerCaOwnerPath, pickerCaPendingUntrustPath, pickerLeafCertPath, pickerStateDir,
  pendingPickerCaHasLivePublishedOwner, readPendingPickerCaUntrust, PICKER_CA_COMMON_NAME, PICKER_HOST,
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

// ── acceptsPickerAuthority trust-boundary fixtures ─────────────────────────────
//
// Adversarial profiles are built by splicing real extension items out of certificates the
// production mint issues and re-minting them on a fresh self-signed authority, so every forged
// certificate still parses and verifies.

function rawTlvs(bytes: Buffer): Buffer[] {
  const items: Buffer[] = [];
  for (let at = 0; at < bytes.length;) {
    const item = der(bytes, at);
    items.push(bytes.subarray(at, item.next));
    at = item.next;
  }
  return items;
}

function extensionItems(certPem: string): Buffer[] {
  const root = der(new X509Certificate(certPem).raw, 0);
  const tbs = parts(root.body)[0]!;
  const wrapper = parts(tbs.body).find(item => item.tag === 0xa3)!;
  return rawTlvs(der(wrapper.body, 0).body);
}

function hasOid(oid: number[]): (item: Buffer) => boolean {
  return item => {
    const first = parts(der(item, 0).body)[0];
    return first?.tag === 0x06 && first.body.equals(Buffer.from(oid));
  };
}

const OID_BASIC_CONSTRAINTS = [0x55, 0x1d, 0x13];
const OID_KEY_USAGE = [0x55, 0x1d, 0x0f];
const OID_SUBJECT_KEY_IDENTIFIER = [0x55, 0x1d, 0x0e];
const OID_SUBJECT_ALT_NAME = [0x55, 0x1d, 0x11];
const OID_EXTENDED_KEY_USAGE = [0x55, 0x1d, 0x25];
const OID_NAME_CONSTRAINTS = [0x55, 0x1d, 0x1e];

function testTlv(tag: number, body: Buffer): Buffer {
  const head: number[] = [tag];
  if (body.length < 0x80) head.push(body.length);
  else if (body.length < 0x100) head.push(0x81, body.length);
  else head.push(0x82, body.length >> 8, body.length & 0xff);
  return Buffer.concat([Buffer.from(head), body]);
}

/** Re-encode an Extension SEQUENCE without its critical BOOLEAN (the non-critical form). */
function asNonCritical(extension: Buffer): Buffer {
  const fields = rawTlvs(der(extension, 0).body).filter(field => der(field, 0).tag !== 0x01);
  return testTlv(0x30, Buffer.concat(fields));
}

const mintPickerCa = () => createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
const mintedExtension = (certPem: string, oid: number[]) => extensionItems(certPem).find(hasOid(oid))!;
const forgeAuthority = (extensions: Buffer[]) =>
  mintAuthorityWithExtensionsForTests(PICKER_CA_COMMON_NAME, extensions).certPem;

test("acceptsPickerAuthority accepts the minted picker root and rejects other profiles", () => {
  expect(acceptsPickerAuthority(mintPickerCa().certPem)).toBe(true);
  expect(acceptsPickerAuthority(ensurePickerCa(tempDir()).certPem)).toBe(true);
  expect(acceptsPickerAuthority("not a certificate")).toBe(false);
  // A foreign common name with an otherwise valid constraint set is not a picker authority.
  expect(acceptsPickerAuthority(createCertificateAuthority({
    commonName: "other root", permittedDnsNames: [PICKER_HOST],
  }).certPem)).toBe(false);
});

test("acceptsPickerAuthority rejects relaxed name-constraint profiles", () => {
  // An additional permitted DNS subtree widens the root beyond claude.ai.
  expect(acceptsPickerAuthority(createCertificateAuthority({
    commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST, "example.com"],
  }).certPem)).toBe(false);
  // Without the all-IP exclusion the address-space name form stays unconstrained.
  expect(acceptsPickerAuthority(createCertificateAuthority({
    commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST], excludeAllIpAddresses: false,
  }).certPem)).toBe(false);
  // A non-critical nameConstraints extension may be ignored by consumers; it is not the profile.
  const items = extensionItems(mintPickerCa().certPem);
  expect(acceptsPickerAuthority(forgeAuthority(
    items.map(item => hasOid(OID_NAME_CONSTRAINTS)(item) ? asNonCritical(item) : item),
  ))).toBe(false);
});

test("acceptsPickerAuthority rejects leaf privileges or loosened CA bits on a picker-named root", () => {
  const legit = mintPickerCa();
  const leaf = issueServerLeaf(legit, PICKER_CA_COMMON_NAME, ["example.com"]);
  const bc = mintedExtension(legit.certPem, OID_BASIC_CONSTRAINTS);
  const keyUsage = mintedExtension(legit.certPem, OID_KEY_USAGE);
  const ski = mintedExtension(legit.certPem, OID_SUBJECT_KEY_IDENTIFIER);
  const nc = mintedExtension(legit.certPem, OID_NAME_CONSTRAINTS);
  // The spoofed-listener shape: right CN, right critical claude.ai constraint, plus leaf extras.
  expect(acceptsPickerAuthority(forgeAuthority([bc, keyUsage, ski, nc, mintedExtension(leaf.certPem, OID_SUBJECT_ALT_NAME)]))).toBe(false);
  expect(acceptsPickerAuthority(forgeAuthority([bc, keyUsage, ski, nc, mintedExtension(leaf.certPem, OID_EXTENDED_KEY_USAGE)]))).toBe(false);
  // Leaf-shaped key usage (digitalSignature) or a CA:FALSE constraint are not the profile.
  expect(acceptsPickerAuthority(forgeAuthority([bc, mintedExtension(leaf.certPem, OID_KEY_USAGE), ski, nc]))).toBe(false);
  expect(acceptsPickerAuthority(forgeAuthority([mintedExtension(leaf.certPem, OID_BASIC_CONSTRAINTS), keyUsage, ski, nc]))).toBe(false);
  // Dropping a required extension or duplicating one also breaks the profile.
  expect(acceptsPickerAuthority(forgeAuthority([bc, keyUsage, nc]))).toBe(false);
  expect(acceptsPickerAuthority(forgeAuthority([bc, keyUsage, ski, nc, nc]))).toBe(false);
});

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

test("picker authority keeps its private key in process memory and removes a legacy key", () => {
  const dir = tempDir();
  const stateDir = pickerStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ca.key"), "legacy-exportable-key\n");
  const first = ensurePickerCa(dir);
  expect(ensurePickerCa(dir).fingerprint).toBe(first.fingerprint);
  expect(existsSync(join(stateDir, "ca.key"))).toBe(false);
  expect(constraints(readFileSync(pickerCaCertPath(dir), "utf8"))?.dnsNames).toEqual([PICKER_HOST]);
});

test("a cached authority refuses a different certificate but republishes a missing one", () => {
  const dir = tempDir();
  const stateDir = pickerStateDir(dir);
  const ca = ensurePickerCa(dir);
  // A different valid certificate needs startup rotation and verified untrust first.
  writeFileSync(join(stateDir, "ca.key"), "legacy-exportable-key\n");
  const other = createCertificateAuthority({
    commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST],
  }).certPem;
  writeFileSync(pickerCaCertPath(dir), other);
  expect(() => ensurePickerCa(dir)).toThrow("picker_ca_rotation_requires_startup");
  expect(readFileSync(pickerCaCertPath(dir), "utf8")).toBe(other);
  expect(existsSync(join(stateDir, "ca.key"))).toBe(false);
  // A missing certificate has no predecessor to untrust and can be republished under the lock.
  rmSync(pickerCaCertPath(dir));
  expect(ensurePickerCa(dir).fingerprint).toBe(ca.fingerprint);
  expect(readFileSync(pickerCaCertPath(dir), "utf8")).toBe(ca.certPem);
});

const PICKER_CA_MODULE_URL = pathToFileURL(join(import.meta.dir, "../../src/claude/intercept/picker-ca.ts")).href;
const LIFECYCLE_LOCK_MODULE_URL = pathToFileURL(join(import.meta.dir, "../../src/client/lifecycle-lock.ts")).href;

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(5);
  }
  throw new Error(`fixture signal missing: ${path}`);
}

test("one uncontended fresh authority publishes its certificate and owner exactly once", () => {
  const dir = tempDir();
  const child = Bun.spawnSync({
    cmd: [process.execPath, "-e",
      `import { spyOn } from "bun:test"; import * as fs from "node:fs";\n` +
      `const renames = spyOn(fs, "renameSync");\n` +
      `const { ensurePickerCa } = await import(${JSON.stringify(PICKER_CA_MODULE_URL)});\n` +
      `ensurePickerCa(${JSON.stringify(dir)});\n` +
      `process.stdout.write(JSON.stringify(renames.mock.calls.map(call => call[1])));`],
    cwd: dir,
    env: { ...process.env, HOME: dir, OPENCODEX_HOME: dir, TMPDIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  const published = JSON.parse(child.stdout.toString()) as string[];
  expect(published.filter(path => path === pickerCaCertPath(dir))).toHaveLength(1);
  expect(published.filter(path => path === pickerCaOwnerPath(dir))).toHaveLength(1);
});

// The restart contract is process-scoped: a new process must mint its own authority, not reuse
// the previous one's certificate. This needs a real second process — the in-process authority
// cache would otherwise hand the same keypair back.
test("a replacement process mints a fresh authority and records the outgoing public root", () => {
  const dir = tempDir();
  const first = Bun.spawnSync({
    cmd: [process.execPath, "-e",
      `import { ensurePickerCa } from ${JSON.stringify(PICKER_CA_MODULE_URL)};\n` +
      `process.stdout.write(ensurePickerCa(${JSON.stringify(dir)}).fingerprint);`],
    cwd: dir,
    env: { ...process.env, HOME: dir, OPENCODEX_HOME: dir, TMPDIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(first.exitCode).toBe(0);
  const firstFingerprint = first.stdout.toString().trim();
  const firstPem = readFileSync(pickerCaCertPath(dir), "utf8");
  const second = Bun.spawnSync({
    cmd: [process.execPath, "-e",
      `import { ensurePickerCa } from ${JSON.stringify(PICKER_CA_MODULE_URL)};\n` +
      `process.stdout.write(ensurePickerCa(${JSON.stringify(dir)}, { rotation: "startup" }).fingerprint);`],
    cwd: dir,
    env: { ...process.env, HOME: dir, OPENCODEX_HOME: dir, TMPDIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(second.exitCode).toBe(0);
  const secondFingerprint = second.stdout.toString().trim();
  expect(secondFingerprint).not.toBe(firstFingerprint);
  expect(pickerCaFingerprints(readFileSync(pickerCaCertPath(dir), "utf8")).sha256).toBe(secondFingerprint);
  expect(readPendingPickerCaUntrust(dir)).toEqual({ certPem: firstPem, ...pickerCaFingerprints(firstPem) });
  expect(readFileSync(pickerCaPendingUntrustPath(dir), "utf8")).not.toContain("PRIVATE KEY");
});

test("a live foreign owner is never clobbered; a dead one is reclaimed", async () => {
  const dir = tempDir();
  const ours = ensurePickerCa(dir);
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", "setInterval(() => {}, 60000);"],
    cwd: dir,
    env: { ...process.env, HOME: dir, OPENCODEX_HOME: dir, TMPDIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // Simulate a foreign owner's matching publication; the new fresh-owner guard prevents a
    // second ensurePickerCa process from creating this state while ours is alive.
    const foreign = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
    const foreignFingerprint = pickerCaFingerprints(foreign.certPem).sha256;
    writeFileSync(pickerCaCertPath(dir), foreign.certPem);
    writeFileSync(pickerCaOwnerPath(dir), JSON.stringify({ pid: child.pid, sha256: foreignFingerprint }));
    expect(() => ensurePickerCa(dir)).toThrow("picker_ca_live_owner");
    expect(readFileSync(pickerCaCertPath(dir), "utf8")).toBe(foreign.certPem);
    child.kill();
    await child.exited;
    // A startup may reclaim after the owner exits, but retains its outgoing public root.
    ensurePickerCa(dir, { rotation: "startup" });
    expect(readFileSync(pickerCaCertPath(dir), "utf8")).toBe(ours.certPem);
    expect(readPendingPickerCaUntrust(dir)?.sha256).toBe(foreignFingerprint);
  } finally {
    child.kill();
  }
});

test("a legacy live PID is reclaimed only when it started after the owner file", () => {
  if (process.platform !== "darwin") return; // Linux's /proc start ticks are not wall-clock time.
  const dir = tempDir();
  const ours = ensurePickerCa(dir);
  const foreign = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
  const ownerPath = pickerCaOwnerPath(dir);
  writeFileSync(pickerCaCertPath(dir), foreign.certPem);
  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, sha256: pickerCaFingerprints(foreign.certPem).sha256 }));

  utimesSync(ownerPath, new Date(0), new Date(0));
  ensurePickerCa(dir, { rotation: "startup" });
  expect(readFileSync(pickerCaCertPath(dir), "utf8")).toBe(ours.certPem);
  expect(readPendingPickerCaUntrust(dir)?.certPem).toBe(foreign.certPem);

  const newerDir = tempDir();
  ensurePickerCa(newerDir);
  writeFileSync(pickerCaCertPath(newerDir), foreign.certPem);
  writeFileSync(pickerCaOwnerPath(newerDir), JSON.stringify({ pid: process.pid, sha256: pickerCaFingerprints(foreign.certPem).sha256 }));
  const future = new Date(Date.now() + 10_000);
  utimesSync(pickerCaOwnerPath(newerDir), future, future);
  expect(() => ensurePickerCa(newerDir, { rotation: "startup" })).toThrow("picker_ca_live_owner");
  expect(readFileSync(pickerCaCertPath(newerDir), "utf8")).toBe(foreign.certPem);
});

test("a held picker CA lock never permits publication outside the critical section", async () => {
  const dir = tempDir();
  const held = join(dir, "lock-held");
  const release = join(dir, "lock-release");
  const lockPath = join(pickerStateDir(dir), "ca.lock.sqlite");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e",
      `import { existsSync, writeFileSync } from "node:fs";\n` +
      `import { withClientLifecycleSync } from ${JSON.stringify(LIFECYCLE_LOCK_MODULE_URL)};\n` +
      `withClientLifecycleSync(() => {\n` +
      `  writeFileSync(${JSON.stringify(held)}, "held");\n` +
      `  const cell = new Int32Array(new SharedArrayBuffer(4));\n` +
      `  const until = Date.now() + 5000;\n` +
      `  while (!existsSync(${JSON.stringify(release)}) && Date.now() < until) Atomics.wait(cell, 0, 0, 20);\n` +
      `}, { lockPath: ${JSON.stringify(lockPath)} });`],
    cwd: dir,
    env: { ...process.env, HOME: dir, OPENCODEX_HOME: dir, TMPDIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitForFile(held);
    expect(() => ensurePickerCa(dir)).toThrow("client_lifecycle_busy");
    expect(existsSync(pickerCaCertPath(dir))).toBe(false);
    expect(existsSync(pickerCaOwnerPath(dir))).toBe(false);
  } finally {
    writeFileSync(release, "release");
    await child.exited;
    child.kill();
  }
  expect(ensurePickerCa(dir).fingerprint).toBe(pickerCaFingerprints(readFileSync(pickerCaCertPath(dir), "utf8")).sha256);
});

test("two competing processes leave one matching public certificate and owner", async () => {
  const dir = tempDir();
  const start = join(dir, "start");
  const release = join(dir, "release");
  const workers = [0, 1].map(index => {
    const result = join(dir, `result-${index}.json`);
    const child = Bun.spawn({
      cmd: [process.execPath, "-e",
        `import { existsSync, writeFileSync } from "node:fs";\n` +
        `import { ensurePickerCa } from ${JSON.stringify(PICKER_CA_MODULE_URL)};\n` +
        `while (!existsSync(${JSON.stringify(start)})) await Bun.sleep(5);\n` +
        `try {\n` +
        `  const ca = ensurePickerCa(${JSON.stringify(dir)}, { rotation: "startup" });\n` +
        `  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ ok: true, sha256: ca.fingerprint, pid: process.pid }));\n` +
        `  while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);\n` +
        `} catch (error) {\n` +
        `  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ ok: false, message: String(error) }));\n` +
        `}`],
      cwd: dir,
      env: { ...process.env, HOME: dir, OPENCODEX_HOME: dir, TMPDIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { child, result };
  });
  try {
    writeFileSync(start, "start");
    for (const worker of workers) await waitForFile(worker.result);
    const results = workers.map(worker => JSON.parse(readFileSync(worker.result, "utf8")) as {
      ok: boolean; sha256?: string; pid?: number;
    });
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const winner = results.find(result => result.ok)!;
    const owner = JSON.parse(readFileSync(pickerCaOwnerPath(dir), "utf8")) as {
      pid: number; startTime: string | null; sha256: string;
    };
    expect(owner).toMatchObject({ pid: winner.pid, sha256: winner.sha256 });
    if (process.platform === "darwin" || process.platform === "linux") expect(owner.startTime).toBeTruthy();
    expect(pickerCaFingerprints(readFileSync(pickerCaCertPath(dir), "utf8")).sha256).toBe(owner.sha256);
    // Contention alone can make the loser fail. A later process must independently see and
    // refuse the live published owner, rather than relying on the racing failure.
    const contender = Bun.spawnSync({
      cmd: [process.execPath, "-e",
        `import { ensurePickerCa } from ${JSON.stringify(PICKER_CA_MODULE_URL)};\n` +
        `try { ensurePickerCa(${JSON.stringify(dir)}, { rotation: "startup" }); process.stdout.write("unexpected success"); }\n` +
        `catch (error) { process.stdout.write(String(error)); }`],
      cwd: dir,
      env: { ...process.env, HOME: dir, OPENCODEX_HOME: dir, TMPDIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(contender.exitCode).toBe(0);
    expect(contender.stdout.toString()).toContain("picker_ca_live_owner");
    expect(pickerCaFingerprints(readFileSync(pickerCaCertPath(dir), "utf8")).sha256).toBe(owner.sha256);
  } finally {
    writeFileSync(release, "release");
    for (const worker of workers) {
      await worker.child.exited;
      worker.child.kill();
    }
  }
});

test("pending untrust contains one canonical public PEM and clears only on an exact acknowledgement", () => {
  const dir = tempDir();
  const ours = ensurePickerCa(dir);
  const old = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
  writeFileSync(pickerCaCertPath(dir), old.certPem);
  expect(ensurePickerCa(dir, { rotation: "startup" }).fingerprint).toBe(ours.fingerprint);
  const pending = readPendingPickerCaUntrust(dir)!;
  expect(Object.keys(JSON.parse(readFileSync(pickerCaPendingUntrustPath(dir), "utf8"))).sort())
    .toEqual(["certPem", "sha1", "sha256"]);
  expect(pending).toEqual({ certPem: old.certPem, ...pickerCaFingerprints(old.certPem) });
  expect(readFileSync(pickerCaPendingUntrustPath(dir), "utf8")).not.toContain("PRIVATE KEY");
  expect(() => ensurePickerCa(dir)).toThrow("picker_ca_pending_untrust");
  expect(acknowledgePendingPickerCaUntrust(dir, { ...pending, sha1: "0".repeat(40) }, { ok: true })).toBe(false);
  expect(readPendingPickerCaUntrust(dir)).toEqual(pending);
  expect(acknowledgePendingPickerCaUntrust(dir, pending, { ok: false })).toBe(false);
  expect(readPendingPickerCaUntrust(dir)).toEqual(pending);
  expect(acknowledgePendingPickerCaUntrust(dir, pending, { ok: true })).toBe(true);
  expect(readPendingPickerCaUntrust(dir)).toBeNull();
  expect(ensurePickerCa(dir).fingerprint).toBe(ours.fingerprint);
});

test("failed untrust leaves the pending record byte-for-byte intact", async () => {
  const dir = tempDir();
  ensurePickerCa(dir);
  const old = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
  writeFileSync(pickerCaCertPath(dir), old.certPem);
  ensurePickerCa(dir, { rotation: "startup" });
  const path = pickerCaPendingUntrustPath(dir);
  const before = readFileSync(path);
  const sha1 = pickerCaFingerprints(old.certPem).sha1;
  const calls: string[] = [];
  const drained = await drainPendingPickerCaUntrust(dir, async args => {
    calls.push(args[0]!);
    return args[0] === "find-certificate"
      ? { code: 0, stdout: `SHA-1 hash: ${sha1}\n`, stderr: "" }
      : { code: 1, stdout: "", stderr: "" };
  }, "darwin");
  expect(drained).toBe(false);
  expect(calls).toContain("remove-trusted-cert");
  expect(readFileSync(path)).toEqual(before);
});

test("cached ensure repairs a missing owner so a peer cannot rotate a live CA", async () => {
  const dir = tempDir();
  const ready = join(dir, "ready");
  const release = join(dir, "release");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e",
      `import { existsSync, unlinkSync, writeFileSync } from "node:fs";\n` +
      `import { ensurePickerCa, pickerCaOwnerPath } from ${JSON.stringify(PICKER_CA_MODULE_URL)};\n` +
      `ensurePickerCa(${JSON.stringify(dir)});\n` +
      `unlinkSync(pickerCaOwnerPath(${JSON.stringify(dir)}));\n` +
      `ensurePickerCa(${JSON.stringify(dir)});\n` +
      `writeFileSync(${JSON.stringify(ready)}, "ready");\n` +
      `while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);`],
    cwd: dir,
    env: { ...process.env, HOME: dir, OPENCODEX_HOME: dir, TMPDIR: dir },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    await waitForFile(ready);
    expect(existsSync(pickerCaOwnerPath(dir))).toBe(true);
    const published = readFileSync(pickerCaCertPath(dir), "utf8");
    const peer = Bun.spawnSync({
      cmd: [process.execPath, "-e",
        `import { ensurePickerCa } from ${JSON.stringify(PICKER_CA_MODULE_URL)};\n` +
        `try { ensurePickerCa(${JSON.stringify(dir)}, { rotation: "startup" }); process.stdout.write("rotated"); }\n` +
        `catch (error) { process.stdout.write(String(error)); }`],
      cwd: dir,
      env: { ...process.env, HOME: dir, OPENCODEX_HOME: dir, TMPDIR: dir },
      stdout: "pipe", stderr: "pipe",
    });
    expect(peer.exitCode).toBe(0);
    expect(peer.stdout.toString()).toContain("picker_ca_live_owner");
    expect(readFileSync(pickerCaCertPath(dir), "utf8")).toBe(published);
  } finally {
    writeFileSync(release, "release");
    await child.exited;
  }
});

test("a failed certificate replacement retains the public predecessor record and published PEM", () => {
  const dir = tempDir();
  const first = Bun.spawnSync({
    cmd: [process.execPath, "-e",
      `import { ensurePickerCa } from ${JSON.stringify(PICKER_CA_MODULE_URL)};\n` +
      `ensurePickerCa(${JSON.stringify(dir)});`],
    cwd: dir,
    env: { ...process.env, HOME: dir, OPENCODEX_HOME: dir, TMPDIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(first.exitCode).toBe(0);
  const priorPem = readFileSync(pickerCaCertPath(dir), "utf8");
  const failed = Bun.spawnSync({
    cmd: [process.execPath, "-e",
      `import { spyOn } from "bun:test"; import * as fs from "node:fs";\n` +
      `const rename = fs.renameSync;\n` +
      `spyOn(fs, "renameSync").mockImplementation((from, to) => {\n` +
      `  if (to === ${JSON.stringify(pickerCaCertPath(dir))}) throw new Error("injected CA rename failure");\n` +
      `  return rename(from, to);\n` +
      `});\n` +
      `const { ensurePickerCa } = await import(${JSON.stringify(PICKER_CA_MODULE_URL)});\n` +
      `try { ensurePickerCa(${JSON.stringify(dir)}, { rotation: "startup" }); process.stdout.write("unexpected success"); }\n` +
      `catch (error) { process.stdout.write(String(error)); }`],
    cwd: dir,
    env: { ...process.env, HOME: dir, OPENCODEX_HOME: dir, TMPDIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(failed.exitCode).toBe(0);
  expect(failed.stdout.toString()).toContain("injected CA rename failure");
  expect(readFileSync(pickerCaCertPath(dir), "utf8")).toBe(priorPem);
  expect(readPendingPickerCaUntrust(dir)).toEqual({ certPem: priorPem, ...pickerCaFingerprints(priorPem) });
  expect(pendingPickerCaHasLivePublishedOwner(dir, readPendingPickerCaUntrust(dir)!)).toBe(false);
});

test("a malformed pending record blocks publication and an actively published pending root is deferred", () => {
  const invalidDir = tempDir();
  mkdirSync(pickerStateDir(invalidDir), { recursive: true });
  writeFileSync(pickerCaPendingUntrustPath(invalidDir), "{malformed");
  expect(() => ensurePickerCa(invalidDir, { rotation: "startup" })).toThrow("picker_ca_pending_untrust_invalid");
  expect(existsSync(pickerCaCertPath(invalidDir))).toBe(false);

  const dir = tempDir();
  const ca = ensurePickerCa(dir);
  const pending = { certPem: ca.certPem, ...pickerCaFingerprints(ca.certPem) };
  writeFileSync(pickerCaPendingUntrustPath(dir), JSON.stringify(pending));
  expect(pendingPickerCaHasLivePublishedOwner(dir, pending)).toBe(true);
  const owner = JSON.parse(readFileSync(pickerCaOwnerPath(dir), "utf8")) as Record<string, unknown>;
  writeFileSync(pickerCaOwnerPath(dir), JSON.stringify({ ...owner, startTime: "recycled-pid" }));
  if (process.platform === "darwin" || process.platform === "linux") {
    expect(pendingPickerCaHasLivePublishedOwner(dir, pending)).toBe(false);
  }
  expect(() => ensurePickerCa(dir, { rotation: "startup" })).toThrow("picker_ca_pending_untrust");
  expect(readPendingPickerCaUntrust(dir)).toEqual(pending);
});
// Minimal DER writers for minting nonstandard authorities that the issuer API cannot emit.
function tlv(tag: number, body: Buffer): Buffer {
  const hdr = body.length < 0x80 ? [body.length]
    : body.length < 0x100 ? [0x81, body.length]
      : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...hdr]), body]);
}
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const oid = (...bytes: number[]) => tlv(0x06, Buffer.from(bytes));
const octet = (body: Buffer) => tlv(0x04, body);
const extension = (oidBytes: number[], critical: boolean, value: Buffer) =>
  seq(oid(...oidBytes), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), octet(value));
const dnsName = (name: string) => tlv(0x82, Buffer.from(name, "ascii"));

/** The nameConstraints extnValue this process emits (claude.ai permitted, all IPs excluded). */
const pickerConstraints = () => seq(
  tlv(0xa0, seq(dnsName(PICKER_HOST))),
  tlv(0xa1, Buffer.concat([seq(tlv(0x87, Buffer.alloc(8))), seq(tlv(0x87, Buffer.alloc(32)))])),
);

/** Flips the keyUsage bits byte inside an emitted certificate, leaving the signature stale. */
function withKeyUsageBits(pem: string, bits: number): string {
  const raw = Buffer.from(pem.replace(/-----[A-Z ]+-----|\s/g, ""), "base64");
  const tbs = parts(der(raw, 0).body)[0]!;
  const wrapper = parts(tbs.body).find(item => item.tag === 0xa3)!;
  for (const item of parts(der(wrapper.body, 0).body)) {
    const fields = parts(item.body);
    if (fields[0]?.tag === 0x06 && fields[0].body.equals(Buffer.from([0x55, 0x1d, 0x0f]))) {
      const value = fields.at(-1)!; // OCTET STRING wrapping `03 02 <unused> <bits>`
      raw[value.body.byteOffset + 3] = bits;
      const b64 = raw.toString("base64").replace(/.{1,64}/g, "$&\n");
      return `-----BEGIN CERTIFICATE-----\n${b64}-----END CERTIFICATE-----\n`;
    }
  }
  throw new Error("keyUsage extension not found");
}

const pickable = (overrides: Parameters<typeof createCertificateAuthority>[0]) =>
  createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, ...overrides }).certPem;

// The four extensions createCertificateAuthority emits, re-encoded here so a forged profile can
// differ in one field while mintAuthorityWithExtensionsForTests keeps the signature valid.
const pickerBasicConstraints = () => extension([0x55, 0x1d, 0x13], true, seq(tlv(0x01, Buffer.from([0xff])), tlv(0x02, Buffer.from([0]))));
const pickerKeyUsage = (bits: number) => extension([0x55, 0x1d, 0x0f], true, tlv(0x03, Buffer.from([1, bits])));
const pickerSubjectKeyId = () => extension([0x55, 0x1d, 0x0e], false, octet(Buffer.alloc(20)));
const pickerNameConstraints = () => extension([0x55, 0x1d, 0x1e], true, pickerConstraints());
const standardProfile = (keyUsageBits = 0x06): Buffer[] =>
  [pickerBasicConstraints(), pickerKeyUsage(keyUsageBits), pickerSubjectKeyId(), pickerNameConstraints()];

describe("acceptsPickerAuthority", () => {
  test("accepts exactly the authority profile this process issues", () => {
    expect(acceptsPickerAuthority(pickable({ permittedDnsNames: [PICKER_HOST] }))).toBe(true);
    expect(acceptsPickerAuthority(ensurePickerCa(tempDir()).certPem)).toBe(true);
  });

  test.each<[string, Parameters<typeof createCertificateAuthority>[0]]>([
    ["an extra permitted DNS subtree", { permittedDnsNames: [PICKER_HOST, "evil.example"] }],
    ["missing IP exclusions", { permittedDnsNames: [PICKER_HOST], excludeAllIpAddresses: false }],
    ["no name constraint at all", {}],
  ])("rejects a root with %s", (_name, options) => {
    expect(acceptsPickerAuthority(pickable(options))).toBe(false);
  });

  // These profiles cannot come from the issuer API; each is signed correctly, so a refusal can
  // only come from the extension-profile comparison, not the signature check.
  test.each<[string, Buffer[]]>([
    ["a non-critical name constraint", [...standardProfile().slice(0, 3), extension([0x55, 0x1d, 0x1e], false, pickerConstraints())]],
    ["a second nameConstraints extension", [...standardProfile(), extension([0x55, 0x1d, 0x1e], true, pickerConstraints())]],
    // SAN + serverAuth would let the trust anchor itself terminate an off-host handshake.
    ["a subjectAltName for an off-host name", [...standardProfile(), extension([0x55, 0x1d, 0x11], false, seq(dnsName("example.com")))]],
    ["a serverAuth extended key usage", [...standardProfile(), extension([0x55, 0x1d, 0x25], false, seq(oid(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01)))]],
    // Swapping the emitted non-critical SKID for a critical one keeps a single SKID, so the
    // refusal must come from the criticality mismatch, not from a duplicate-OID rejection.
    ["a critical key identifier", [...standardProfile().slice(0, 2), extension([0x55, 0x1d, 0x0e], true, octet(Buffer.alloc(20))), pickerNameConstraints()]],
  ])("rejects a signed root with %s", (_name, extensions) => {
    expect(acceptsPickerAuthority(forgeAuthority(extensions))).toBe(false);
  });

  test("rejects a signed root whose key usage also grants digitalSignature", () => {
    expect(acceptsPickerAuthority(forgeAuthority(standardProfile(0x87)))).toBe(false);
  });

  test("rejects a root whose bytes no longer match its signature", () => {
    const forged = withKeyUsageBits(pickable({ permittedDnsNames: [PICKER_HOST] }), 0x87);
    expect(acceptsPickerAuthority(forged)).toBe(false);
  });

  test("rejects the unconstrained intercept root and a wrong common name", () => {
    expect(acceptsPickerAuthority(createLocalInterceptCa().certPem)).toBe(false);
    expect(acceptsPickerAuthority(createCertificateAuthority({
      commonName: "not the picker", permittedDnsNames: [PICKER_HOST],
    }).certPem)).toBe(false);
  });
});
