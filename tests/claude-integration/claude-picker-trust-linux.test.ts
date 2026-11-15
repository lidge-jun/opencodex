import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import { PICKER_CA_COMMON_NAME, PICKER_HOST, pickerCaFingerprints } from "../../src/claude/intercept/picker-ca";
import {
  inspectPickerTrustLinux,
  linuxNssDbDir,
  trustPickerCaLinux,
  untrustPickerCaLinux,
  type LinuxTrustRunner,
} from "../../src/claude/intercept/picker-trust-linux";
import type { SecurityResult } from "../../src/claude/intercept/picker-trust";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function home(withDb = true): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-nss-home-"));
  homes.push(dir);
  if (withDb) {
    mkdirSync(linuxNssDbDir(dir), { recursive: true });
    writeFileSync(join(linuxNssDbDir(dir), "cert9.db"), "");
  }
  return dir;
}

function pickerRoot(): { pem: string; sha1: string } {
  const pem = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] }).certPem;
  return { pem, sha1: pickerCaFingerprints(pem).sha1 };
}

const ok = (stdout = ""): SecurityResult => ({ code: 0, stdout, stderr: "" });
const notFound: SecurityResult = { code: 255, stdout: "", stderr: "could not find certificate" };

function listing(flags: string): string {
  return `\nCertificate Nickname                                         Trust Attributes\n`
    + `                                                             SSL,S/MIME,JAR/XPI\n\n`
    + `${PICKER_CA_COMMON_NAME}                           ${flags},,\n`;
}

/** A fake NSS database: a list of PEMs with their SSL flags, driven by certutil argv. */
function nss(initial: Array<{ pem: string; flags: string }> = []): { run: LinuxTrustRunner; calls: string[][]; certs: Array<{ pem: string; flags: string }> } {
  const certs = [...initial];
  const calls: string[][] = [];
  const run: LinuxTrustRunner = async args => {
    calls.push([...args]);
    const op = args[0];
    if (op === "-L" && args.includes("-n")) return certs.length ? ok(certs.map(c => c.pem).join("\n")) : notFound;
    if (op === "-L") return ok(certs.map(c => listing(c.flags)).join(""));
    if (op === "-A") {
      const input = args[args.indexOf("-i") + 1]!;
      certs.push({ pem: readFileSync(input, "utf8"), flags: args[args.indexOf("-t") + 1]!.split(",")[0]! });
      return ok();
    }
    if (op === "-D") { certs.shift(); return ok(); }
    if (op === "-N") return ok();
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls, certs };
}

test("the current root with the SSL C flag in the user NSS database is trusted", async () => {
  const root = pickerRoot();
  const h = home();
  const db = nss([{ pem: root.pem, flags: "C" }]);
  expect(await inspectPickerTrustLinux(root.sha1, db.run, h)).toBe("trusted");
  expect(db.calls[0]).toEqual(["-L", "-d", `sql:${linuxNssDbDir(h)}`, "-n", PICKER_CA_COMMON_NAME, "-a"]);
});

test("a missing, stale or SSL-untrusted root reads as untrusted", async () => {
  const root = pickerRoot();
  const stale = pickerRoot();
  expect(await inspectPickerTrustLinux(root.sha1, nss().run, home())).toBe("untrusted");
  expect(await inspectPickerTrustLinux(root.sha1, nss([{ pem: stale.pem, flags: "C" }]).run, home())).toBe("untrusted");
  expect(await inspectPickerTrustLinux(root.sha1, nss([{ pem: root.pem, flags: "" }]).run, home())).toBe("untrusted");
  // No NSS database at all: nothing can be trusted and certutil is never run.
  const idle: LinuxTrustRunner = async () => { throw new Error("runner must stay idle"); };
  expect(await inspectPickerTrustLinux(root.sha1, idle, home(false))).toBe("untrusted");
});

test("an absent certutil reports unsupported and a failing one unknown", async () => {
  const root = pickerRoot();
  const missing: LinuxTrustRunner = async () => ({ code: null, stdout: "", stderr: "certutil_missing" });
  expect(await inspectPickerTrustLinux(root.sha1, missing, home())).toBe("unsupported");
  expect(await trustPickerCaLinux("/ca.pem", missing, { pem: root.pem }, home())).toEqual({ ok: false, reason: "unsupported" });
  const failing: LinuxTrustRunner = async () => ({ code: 1, stdout: "", stderr: "SEC_ERROR_BAD_DATABASE" });
  expect(await inspectPickerTrustLinux(root.sha1, failing, home())).toBe("unknown");
});

test("trust installs a private copy of the verified bytes as an SSL CA, then inspects as trusted", async () => {
  const root = pickerRoot();
  const h = home();
  const shared = join(h, "shared-ca.pem");
  writeFileSync(shared, "swapped bytes");
  const db = nss();
  expect(await trustPickerCaLinux(shared, db.run, { pem: root.pem }, h)).toEqual({ ok: true });
  const add = db.calls.find(call => call[0] === "-A")!;
  expect(add.slice(0, 8)).toEqual(["-A", "-d", `sql:${linuxNssDbDir(h)}`, "-n", PICKER_CA_COMMON_NAME, "-t", "C,,", "-a"]);
  expect(add[9]).not.toBe(shared);
  expect(db.certs[0]!.pem).toBe(root.pem);
  expect(await inspectPickerTrustLinux(root.sha1, db.run, h)).toBe("trusted");
});

test("trust creates the NSS database when the user has none", async () => {
  const root = pickerRoot();
  const h = home(false);
  const db = nss();
  expect(await trustPickerCaLinux("/ca.pem", db.run, { pem: root.pem }, h)).toEqual({ ok: true });
  expect(db.calls[0]).toEqual(["-N", "-d", `sql:${linuxNssDbDir(h)}`, "--empty-password"]);
});

test("untrust deletes every copy of the current root and is a no-op when it is absent", async () => {
  const root = pickerRoot();
  const h = home();
  const db = nss([{ pem: root.pem, flags: "C" }, { pem: root.pem, flags: "C" }]);
  expect(await untrustPickerCaLinux(root.sha1, db.run, h)).toEqual({ ok: true });
  expect(db.certs).toHaveLength(0);
  expect(db.calls.filter(call => call[0] === "-D")).toHaveLength(2);
  const empty = nss();
  expect(await untrustPickerCaLinux(root.sha1, empty.run, h)).toEqual({ ok: true });
  expect(empty.calls.map(call => call[0])).toEqual(["-L"]);
  const refusing: LinuxTrustRunner = async args => args[0] === "-D" ? { code: 1, stdout: "", stderr: "" } : ok(root.pem);
  expect(await untrustPickerCaLinux(root.sha1, refusing, h)).toEqual({ ok: false });
});
