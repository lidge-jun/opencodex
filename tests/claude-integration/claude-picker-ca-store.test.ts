import { afterEach, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import { PICKER_CA_COMMON_NAME, PICKER_HOST } from "../../src/claude/intercept/picker-ca";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardPickerCaKey, ensurePickerCa, pickerCaCertPath, pickerCaFingerprints, readPendingPickerCaUntrust } from "../../src/claude/intercept/picker-ca";
import { memoryPickerCaStore } from "../helpers/picker-ca-store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), "ocx-picker-store-")); roots.push(value); return value; };
afterEach(() => { for (const dir of roots.splice(0)) removeTreeWithRetry(dir); });
/** Keep non-link assertions active; only a native Windows file-link privilege gap is unavailable. */
function fileSymlink(target: string, path: string): boolean {
  try { symlinkSync(target, path, "file"); return true; }
  catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    console.warn("[picker-ca-store test] Windows denied file symlink creation (EPERM); file-link assertions unavailable");
    return false;
  }
}
const caUrl = pathToFileURL(join(import.meta.dir, "../../src/claude/intercept/picker-ca.ts")).href;
const helperUrl = pathToFileURL(join(import.meta.dir, "../helpers/picker-ca-store.ts")).href;
function fresh(dir: string, extra = "", timeout = 10_000) {
  const child = Bun.spawnSync({ cmd: [process.execPath, "-e", `
    import { ensurePickerCa } from ${JSON.stringify(caUrl)};
    import { filePickerCaStore } from ${JSON.stringify(helperUrl)};
    ${extra}
    process.stdout.write(ensurePickerCa(${JSON.stringify(dir)}, { rotation: "startup", persistent: true,
      store: filePickerCaStore(${JSON.stringify(join(dir, "test-only-store"))}) }).fingerprint);
  `], timeout, stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

test("persistent startup reuses the same signing identity in two fresh processes", () => {
  const dir = root();
  const first = fresh(dir);
  expect(first.code, first.stderr).toBe(0);
  const second = fresh(dir);
  expect(second.code, second.stderr).toBe(0);
  expect(second.stdout).toBe(first.stdout);
  expect(readPendingPickerCaUntrust(dir)).toBeNull();
  expect(existsSync(join(dir, "claude-picker", "ca.key"))).toBe(false);
  expect(readFileSync(join(dir, "claude-picker", "authority.json"), "utf8")).not.toContain("PRIVATE KEY");
  expect(existsSync(join(dir, "claude-picker", "authority-init.json"))).toBe(false);
});

test("store write is preceded by public init journal and recovery keeps the exact stored pair", () => {
  const dir = root();
  const fake = memoryPickerCaStore();
  const interrupted = () => ({
    getPassword: () => fake.value,
    setPassword: (value: string) => {
      const journal = readFileSync(join(dir, "claude-picker", "authority-init.json"), "utf8");
      expect(journal).not.toContain("PRIVATE KEY");
      fake.value = value;
      throw new Error("secret diagnostic must not escape");
    },
  });
  expect(() => ensurePickerCa(dir, { rotation: "startup", persistent: true, store: interrupted })).toThrow("picker_ca_store_unavailable");
  const stored = JSON.parse(fake.value!);
  const ca = ensurePickerCa(dir, { rotation: "startup", persistent: true, store: fake.store });
  expect(ca.fingerprint).toBe(stored.fingerprint);
  expect(fake.writes).toBe(0);
  expect(existsSync(join(dir, "claude-picker", "authority-init.json"))).toBe(false);
});

test("initialized missing, invalid, or denied stores never rotate public identity", () => {
  const dir = root();
  const fake = memoryPickerCaStore();
  const ca = ensurePickerCa(dir, { rotation: "startup", persistent: true, store: fake.store });
  const original = fake.value;
  for (const invalid of [null, "", "{}", original!.replace('"schema":1', '"schema":2')]) {
    fake.value = invalid;
    expect(() => ensurePickerCa(dir, { rotation: "startup", persistent: true, store: fake.store })).toThrow();
    expect(readFileSync(pickerCaCertPath(dir), "utf8")).toBe(ca.certPem);
  }
  expect(() => ensurePickerCa(dir, { rotation: "startup", persistent: true,
    store: () => ({ getPassword: () => { throw new Error("denied"); }, setPassword: () => { throw new Error("must not write"); } }) })).toThrow("picker_ca_store_unavailable");
  expect(fake.writes).toBe(1);
});

test("a live predecessor refuses before a credential write or initialization journal", () => {
  const dir = root();
  const ca = ensurePickerCa(dir);
  const child = fresh(dir);
  expect(child.code).not.toBe(0);
  expect(child.stderr).toContain("picker_ca_live_owner");
  expect(existsSync(join(dir, "test-only-store"))).toBe(false);
  expect(existsSync(join(dir, "claude-picker", "authority-init.json"))).toBe(false);
  expect(pickerCaFingerprints(readFileSync(pickerCaCertPath(dir), "utf8")).sha256).toBe(ca.fingerprint);
});

test("canonical config aliases share the credential namespace and authority", () => {
  const dir = root();
  const alias = join(root(), "alias");
  symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
  const fake = memoryPickerCaStore();
  const entries: string[] = [];
  const store = (service: string, account: string) => { entries.push(`${service}/${account}`); return fake.store(service, account); };
  const first = ensurePickerCa(dir, { rotation: "startup", persistent: true, store });
  const second = ensurePickerCa(alias, { rotation: "startup", persistent: true, store });
  expect(second.fingerprint).toBe(first.fingerprint);
  expect(new Set(entries).size).toBe(1);
  expect(entries[0]).toMatch(/^opencodex\.claude-desktop-picker\.ca\.v1\/[a-f0-9]{64}$/);
  expect(fake.writes).toBe(1);
});

test("uncommitted store without exact initialization evidence fails closed", () => {
  const dir = root();
  const fake = memoryPickerCaStore();
  ensurePickerCa(dir, { rotation: "startup", persistent: true, store: fake.store });
  rmSync(join(dir, "claude-picker", "authority.json"));
  expect(() => ensurePickerCa(dir, { rotation: "startup", persistent: true, store: fake.store })).toThrow();
  expect(fake.writes).toBe(1);
});

test("only literal null permits initialization; ambiguous absence and thrown reads are unavailable", () => {
  for (const value of [undefined, false, 0]) {
    const dir = root();
    let writes = 0;
    const store = () => ({ getPassword: () => value as unknown as string | null, setPassword: () => { writes++; } });
    expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store }); }).toThrow("picker_ca_store_unavailable");
    expect(writes).toBe(0);
    expect(existsSync(join(dir, "claude-picker", "authority-init.json"))).toBe(false);
  }
  const dir = root();
  expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store: () => { throw new Error("binding unavailable"); } }); }).toThrow("picker_ca_store_unavailable");
});

test("a journal without a stored pair is incomplete setup and never generates again", () => {
  const dir = root();
  let writes = 0;
  const store = () => ({ getPassword: () => null, setPassword: () => { writes++; throw new Error("write denied"); } });
  expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store }); }).toThrow("picker_ca_store_unavailable");
  const evidence = readFileSync(join(dir, "claude-picker", "authority-init.json"), "utf8");
  expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store }); }).toThrow("picker_ca_store_missing");
  expect(writes).toBe(1);
  expect(readFileSync(join(dir, "claude-picker", "authority-init.json"), "utf8")).toBe(evidence);
  expect(existsSync(pickerCaCertPath(dir))).toBe(false);
});

test("readback mismatch retains initialization evidence and does not commit public authority", () => {
  const dir = root();
  let reads = 0;
  const store = () => ({ getPassword: () => ++reads === 1 ? null : "different payload", setPassword: () => {} });
  expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store }); }).toThrow("picker_ca_store_readback_failed");
  expect(existsSync(join(dir, "claude-picker", "authority-init.json"))).toBe(true);
  expect(existsSync(join(dir, "claude-picker", "authority.json"))).toBe(false);
  expect(existsSync(pickerCaCertPath(dir))).toBe(false);
});

for (const boundary of ["authority.json", "ca.pem", "ca-owner.json"] as const) {
  test(`recovery after ${boundary} publication failure reuses the exact stored fingerprint`, () => {
    const dir = root();
    const failed = fresh(dir, `
      import { spyOn } from "bun:test";
      import * as fs from "node:fs";
      import { basename } from "node:path";
      const rename = fs.renameSync;
      spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (basename(String(to)) === "${boundary}") throw new Error("injected publication failure");
        return rename(from, to);
      });
    `);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("injected publication failure");
    const stored = JSON.parse(readFileSync(join(dir, "test-only-store"), "utf8"));
    expect(existsSync(join(dir, "claude-picker", "authority-init.json"))).toBe(true);
    const recovered = fresh(dir);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(recovered.stdout).toBe(stored.fingerprint);
    expect(existsSync(join(dir, "claude-picker", "authority-init.json"))).toBe(false);
    expect(readPendingPickerCaUntrust(dir)).toBeNull();
  });
}

test("a tampered initialization fingerprint or predecessor never publishes the stored CA", () => {
  for (const mutate of [
    (value: Record<string, unknown>) => { value.fingerprint = "A".repeat(64); },
    (value: Record<string, unknown>) => { value.configId = "wrong namespace"; },
    (value: Record<string, unknown>) => { value.predecessor = "not a public certificate"; },
  ]) {
    const dir = root();
    const fake = memoryPickerCaStore();
    const store = () => ({ getPassword: () => fake.value, setPassword: (raw: string) => { fake.value = raw; throw new Error(); } });
    expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store }); }).toThrow();
    const journalPath = join(dir, "claude-picker", "authority-init.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    mutate(journal); writeFileSync(journalPath, JSON.stringify(journal));
    expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store: fake.store }); }).toThrow();
    expect(fake.writes).toBe(0);
    expect(existsSync(pickerCaCertPath(dir))).toBe(false);
    expect(existsSync(journalPath)).toBe(true);
  }
});

test("different config directories cannot reuse a credential payload", () => {
  const fake = memoryPickerCaStore();
  ensurePickerCa(root(), { persistent: true, rotation: "startup", store: fake.store });
  const second = root();
  expect(() => { ensurePickerCa(second, { persistent: true, rotation: "startup", store: fake.store }); }).toThrow("picker_ca_store_invalid");
  expect(fake.writes).toBe(1);
  expect(existsSync(pickerCaCertPath(second))).toBe(false);
});

test("canonical SQLite lease excludes concurrent credential initialization", () => {
  const dir = root();
  const child = fresh(dir, `
    import { withClientLifecycleSync } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../src/client/lifecycle-lock.ts")).href)};
    import { mkdirSync } from "node:fs";
    mkdirSync(${JSON.stringify(join(dir, "claude-picker"))});
    withClientLifecycleSync(() => {
      let writes = 0;
      try { ensurePickerCa(${JSON.stringify(dir)}, { persistent: true, rotation: "startup",
        store: () => ({ getPassword: () => null, setPassword: () => { writes++; } }) }); }
      catch (error) { if (error.message !== "client_lifecycle_busy" || writes !== 0) throw error; }
    }, { lockPath: ${JSON.stringify(join(dir, "claude-picker", "ca.lock.sqlite"))} });
  `);
  expect(child.code, child.stderr).toBe(0);
});

test("payload validation rejects unknown fields, foreign keys, broad CAs, mismatches, and oversized data", () => {
  const dir = root();
  const fake = memoryPickerCaStore();
  const ca = ensurePickerCa(dir, { persistent: true, rotation: "startup", store: fake.store });
  const valid = JSON.parse(fake.value!);
  const other = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
  const broad = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME });
  const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
  const variants = [
    { ...valid, extra: true },
    { ...valid, keyPem: other.keyPem },
    { ...valid, keyPem: p384.privateKey.export({ type: "pkcs8", format: "pem" }) },
    { ...valid, certPem: broad.certPem, keyPem: broad.keyPem, fingerprint: pickerCaFingerprints(broad.certPem).sha256 },
    { ...valid, fingerprint: "B".repeat(64) },
    { ...valid, certPem: `${ca.certPem}${ca.keyPem}` },
    { ...valid, keyPem: `${ca.keyPem}${other.keyPem}` },
    { ...valid, schema: 99 },
    { ...valid, configId: "different config" },
  ].map(value => JSON.stringify(value));
  variants.push(" ".repeat(16 * 1024 + 1));
  for (const raw of variants) {
    fake.value = raw;
    expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store: fake.store }); }).toThrow("picker_ca_store_invalid");
    expect(readFileSync(pickerCaCertPath(dir), "utf8")).toBe(ca.certPem);
  }
  expect(fake.writes).toBe(1);
});

test("expired and not-yet-valid stored authorities fail without replacement", () => {
  const dir = root();
  const fake = memoryPickerCaStore();
  const ca = ensurePickerCa(dir, { persistent: true, rotation: "startup", store: fake.store });
  const cert = new X509Certificate(ca.certPem);
  for (const now of [Date.parse(cert.validFrom) - 1, Date.parse(cert.validTo)]) {
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store: fake.store }); }).toThrow("picker_ca_store_invalid");
      expect(readFileSync(pickerCaCertPath(dir), "utf8")).toBe(ca.certPem);
    } finally { clock.mockRestore(); }
  }
  expect(fake.writes).toBe(1);
});

test("metadata mismatch and symlink recovery records fail before credential mutation", () => {
  const dir = root();
  const fake = memoryPickerCaStore();
  const ca = ensurePickerCa(dir, { persistent: true, rotation: "startup", store: fake.store });
  const path = join(dir, "claude-picker", "authority.json");
  const original = readFileSync(path, "utf8");
  const metadata = JSON.parse(original); metadata.fingerprint = "C".repeat(64);
  writeFileSync(path, JSON.stringify(metadata));
  expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store: fake.store }); }).toThrow("picker_ca_metadata_mismatch");
  writeFileSync(path, original);
  const target = join(dir, "external-public-state"); writeFileSync(target, original);
  if (fileSymlink(target, join(dir, "claude-picker", "authority-init.json"))) {
    expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store: fake.store }); }).toThrow("picker_ca_metadata_unsafe");
  }
  expect(readFileSync(target, "utf8")).toBe(original);
  expect(readFileSync(pickerCaCertPath(dir), "utf8")).toBe(ca.certPem);
  expect(fake.writes).toBe(1);
});

test("metadata replaced between lstat and open fails before credential access", () => {
  const dir = root();
  const fake = memoryPickerCaStore();
  ensurePickerCa(dir, { persistent: true, rotation: "startup", store: fake.store });
  // The picker canonicalizes its config directory (macOS tmpdir is /var -> /private/var).
  const path = join(filesystem.realpathSync(dir), "claude-picker", "authority.json");
  const original = readFileSync(path, "utf8");
  const open = filesystem.openSync;
  let replaced = false;
  const opening = spyOn(filesystem, "openSync").mockImplementation((target, flags, mode) => {
    if (target === path && !replaced) {
      filesystem.renameSync(path, join(dir, "original-metadata"));
      writeFileSync(path, original, { mode: 0o600 });
      replaced = true;
    }
    return open(target, flags, mode);
  });
  let storeCalls = 0;
  try {
    expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store: (service, account) => {
      storeCalls++;
      return fake.store(service, account);
    } }); }).toThrow("picker_ca_metadata_unsafe");
    expect(replaced).toBe(true);
    expect(storeCalls).toBe(0);
    expect(fake.writes).toBe(1);
  } finally { opening.mockRestore(); }
});

test("file identities that differ only beyond 2^53 still count as a replacement", () => {
  // Windows file IDs carry a sequence number in the high bits, so two files can share a Number ino.
  const dir = root();
  const fake = memoryPickerCaStore();
  ensurePickerCa(dir, { persistent: true, rotation: "startup", store: fake.store });
  const path = join(filesystem.realpathSync(dir), "claude-picker", "authority.json");
  const withIno = <T extends object>(stat: T, ino: bigint): T => {
    const value = typeof (stat as { ino: unknown }).ino === "bigint" ? ino : Number(ino);
    return Object.create(stat, { ino: { value } });
  };
  const { lstatSync, fstatSync } = filesystem;
  let authorityFd = -1;
  const lstat = spyOn(filesystem, "lstatSync").mockImplementation(((target: filesystem.PathLike, options?: object) => {
    const stat = lstatSync(target, options as never);
    return target === path && stat ? withIno(stat, 2n ** 60n + 1n) : stat;
  }) as typeof lstatSync);
  const open = filesystem.openSync;
  const opening = spyOn(filesystem, "openSync").mockImplementation((target, flags, mode) => {
    const fd = open(target, flags, mode);
    if (target === path) authorityFd = fd;
    return fd;
  });
  const fstat = spyOn(filesystem, "fstatSync").mockImplementation(((fd: number, options?: object) => {
    const stat = fstatSync(fd, options as never);
    return fd === authorityFd ? withIno(stat, 2n ** 60n + 2n) : stat;
  }) as typeof fstatSync);
  try {
    expect(() => ensurePickerCa(dir, { persistent: true, rotation: "startup", store: fake.store }))
      .toThrow("picker_ca_metadata_unsafe");
    expect(fake.writes).toBe(1);
  } finally { lstat.mockRestore(); opening.mockRestore(); fstat.mockRestore(); }
});

test("unsafe picker directory or lock cannot reach the credential store", () => {
  for (const pathKind of ["directory", "lock"] as const) {
    const dir = root();
    const outside = root();
    const fake = memoryPickerCaStore();
    if (pathKind === "directory") {
      writeFileSync(join(outside, "ca.key"), "must remain untouched");
      symlinkSync(outside, join(dir, "claude-picker"), process.platform === "win32" ? "junction" : "dir");
    } else {
      // Prepare normal public state, then replace only the lease path with a symlink.
      ensurePickerCa(dir);
      const lock = join(dir, "claude-picker", "ca.lock.sqlite");
      rmSync(lock);
      const target = join(outside, "lock"); writeFileSync(target, "external");
      if (!fileSymlink(target, lock)) {
        expect(readFileSync(target, "utf8")).toBe("external");
        expect(fake.writes).toBe(0);
        continue;
      }
    }
    let calls = 0;
    expect(() => { ensurePickerCa(dir, { persistent: true, rotation: "startup", store: (service, account) => { calls++; return fake.store(service, account); } }); }).toThrow();
    expect(calls).toBe(0);
    expect(fake.writes).toBe(0);
    if (pathKind === "directory") {
      expect(() => discardPickerCaKey(dir)).toThrow("picker_ca_directory_unsafe");
      expect(readFileSync(join(outside, "ca.key"), "utf8")).toBe("must remain untouched");
    }
    if (pathKind === "directory") expect(readFileSync(join(outside, "ca.key"), "utf8")).toBe("must remain untouched");
    else expect(readFileSync(join(outside, "lock"), "utf8")).toBe("external");
  }
});

for (const filename of ["authority.json", "authority-init.json"]) {
  test.skipIf(process.platform === "win32")(`a FIFO ${filename} fails promptly before any credential read`, () => {
    const dir = root();
    ensurePickerCa(dir);
    const path = join(dir, "claude-picker", filename);
    const made = Bun.spawnSync(["mkfifo", path]);
    expect(made.exitCode).toBe(0);
    const failed = fresh(dir, "", 2_000);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("picker_ca_metadata_invalid");
    expect(existsSync(join(dir, "test-only-store"))).toBe(false);
  });
}
