import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import { PICKER_CA_COMMON_NAME, PICKER_HOST, pickerCaFingerprints } from "../../src/claude/intercept/picker-ca";
import {
  inspectPickerTrustLinux,
  LINUX_TRUST_TRUNCATED,
  linuxNssDbDir,
  linuxPickerNickname,
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
/** certutil exits 255 both for an absent nickname and for a database it cannot open. */
const exit255: SecurityResult = { code: 255, stdout: "", stderr: "SEC_ERROR_BAD_DATABASE" };

interface Entry { nickname: string; pem: string; flags: string }

/** A fake NSS database driven by certutil argv; `broken` makes every read fail like an unreadable database. */
function nss(initial: Entry[] = [], options: { broken?: boolean } = {}) {
  const certs = [...initial];
  const calls: string[][] = [];
  const run: LinuxTrustRunner = async args => {
    calls.push([...args]);
    const op = args[0];
    const nickname = args.includes("-n") ? args[args.indexOf("-n") + 1]! : undefined;
    if (options.broken && op === "-L") return exit255;
    if (op === "-L" && nickname !== undefined) {
      const found = certs.find(c => c.nickname === nickname);
      return found ? ok(found.pem) : exit255;
    }
    if (op === "-L") {
      return ok("\nCertificate Nickname                                         Trust Attributes\n"
        + "                                                             SSL,S/MIME,JAR/XPI\n\n"
        + certs.map(c => `${c.nickname}                           ${c.flags},,\n`).join(""));
    }
    if (op === "-A") {
      const input = args[args.indexOf("-i") + 1]!;
      certs.push({ nickname: nickname!, pem: readFileSync(input, "utf8"), flags: args[args.indexOf("-t") + 1]!.split(",")[0]! });
      return ok();
    }
    if (op === "-D") {
      const at = certs.findIndex(c => c.nickname === nickname);
      if (at < 0) return exit255;
      certs.splice(at, 1);
      return ok();
    }
    if (op === "-N") return ok();
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls, certs };
}

const entry = (root: { pem: string; sha1: string }, flags = "C"): Entry => ({ nickname: linuxPickerNickname(root.sha1), pem: root.pem, flags });

test("the current root under its own nickname with the SSL C flag is trusted", async () => {
  const root = pickerRoot();
  const h = home();
  const db = nss([entry(root)]);
  expect(await inspectPickerTrustLinux(root.sha1, db.run, h)).toBe("trusted");
  expect(db.calls).toEqual([
    ["-L", "-d", `sql:${linuxNssDbDir(h)}`],
    ["-L", "-d", `sql:${linuxNssDbDir(h)}`, "-n", linuxPickerNickname(root.sha1), "-a"],
  ]);
});

test("a missing, SSL-untrusted or foreign root reads as untrusted", async () => {
  const root = pickerRoot();
  const other = pickerRoot();
  expect(await inspectPickerTrustLinux(root.sha1, nss([entry(other)]).run, home())).toBe("untrusted");
  expect(await inspectPickerTrustLinux(root.sha1, nss([entry(root, "")]).run, home())).toBe("untrusted");
  const foreign = { nickname: linuxPickerNickname(root.sha1), pem: other.pem, flags: "C" };
  expect(await inspectPickerTrustLinux(root.sha1, nss([foreign]).run, home())).toBe("untrusted");
  const idle: LinuxTrustRunner = async () => { throw new Error("runner must stay idle"); };
  expect(await inspectPickerTrustLinux(root.sha1, idle, home(false))).toBe("untrusted");
});

test("an unreadable database reads as unknown, never as absent", async () => {
  const root = pickerRoot();
  expect(await inspectPickerTrustLinux(root.sha1, nss([entry(root)], { broken: true }).run, home())).toBe("unknown");
});

test("an absent certutil reports unsupported", async () => {
  const root = pickerRoot();
  const missing: LinuxTrustRunner = async () => ({ code: null, stdout: "", stderr: "certutil_missing" });
  expect(await inspectPickerTrustLinux(root.sha1, missing, home())).toBe("unsupported");
  expect(await trustPickerCaLinux("/ca.pem", missing, { pem: root.pem }, home())).toEqual({ ok: false, reason: "unsupported" });
});

test("trust installs a private copy of the verified bytes under the root's own nickname", async () => {
  const root = pickerRoot();
  const h = home();
  const shared = join(h, "shared-ca.pem");
  writeFileSync(shared, "swapped bytes");
  const db = nss();
  expect(await trustPickerCaLinux(shared, db.run, { pem: root.pem }, h)).toEqual({ ok: true });
  const add = db.calls.find(call => call[0] === "-A")!;
  expect(add.slice(0, 8)).toEqual(["-A", "-d", `sql:${linuxNssDbDir(h)}`, "-n", linuxPickerNickname(root.sha1), "-t", "C,,", "-a"]);
  expect(add[9]).not.toBe(shared);
  expect(db.certs[0]!.pem).toBe(root.pem);
  expect(await inspectPickerTrustLinux(root.sha1, db.run, h)).toBe("trusted");
  // Without verified bytes nothing is installed.
  expect(await trustPickerCaLinux(shared, nss().run, undefined, h)).toEqual({ ok: false, reason: "declined_or_failed" });
});

test("trust creates the NSS database when the user has none", async () => {
  const root = pickerRoot();
  const h = home(false);
  const db = nss();
  expect(await trustPickerCaLinux("/ca.pem", db.run, { pem: root.pem }, h)).toEqual({ ok: true });
  expect(db.calls[0]).toEqual(["-N", "-d", `sql:${linuxNssDbDir(h)}`, "--empty-password"]);
});

test("untrust removes only the predecessor, even when the current root was installed meanwhile", async () => {
  const predecessor = pickerRoot();
  const current = pickerRoot();
  const h = home();
  const db = nss([entry(predecessor), entry(current)]);
  expect(await untrustPickerCaLinux(predecessor.sha1, db.run, h)).toEqual({ ok: true });
  expect(db.certs.map(c => c.nickname)).toEqual([linuxPickerNickname(current.sha1)]);
  expect(await inspectPickerTrustLinux(current.sha1, db.run, h)).toBe("trusted");
});

test("untrust succeeds only on a readable database proving absence", async () => {
  const root = pickerRoot();
  const empty = nss();
  expect(await untrustPickerCaLinux(root.sha1, empty.run, home())).toEqual({ ok: true });
  expect(empty.calls.map(call => call[0])).toEqual(["-L"]);
  expect(await untrustPickerCaLinux(root.sha1, nss([entry(root)], { broken: true }).run, home())).toEqual({ ok: false });
  const foreign = { nickname: linuxPickerNickname(root.sha1), pem: pickerRoot().pem, flags: "C" };
  const kept = nss([foreign]);
  expect(await untrustPickerCaLinux(root.sha1, kept.run, home())).toEqual({ ok: false });
  expect(kept.certs).toHaveLength(1);
  const refusing: LinuxTrustRunner = async args => args[0] === "-D" ? { code: 1, stdout: "", stderr: "" } : nss([entry(root)]).run(args);
  expect(await untrustPickerCaLinux(root.sha1, refusing, home())).toEqual({ ok: false });
});

test("a root under the legacy shared nickname is still recognised and removed by its own fingerprint", async () => {
  const legacy = pickerRoot();
  const other = pickerRoot();
  const h = home();
  const db = nss([{ nickname: PICKER_CA_COMMON_NAME, pem: legacy.pem, flags: "C" }]);
  expect(await inspectPickerTrustLinux(legacy.sha1, db.run, h)).toBe("trusted");
  // Another root under the legacy nickname is neither trusted nor deleted for this fingerprint.
  expect(await inspectPickerTrustLinux(other.sha1, db.run, h)).toBe("untrusted");
  expect(await untrustPickerCaLinux(other.sha1, db.run, h)).toEqual({ ok: true });
  expect(db.certs).toHaveLength(1);
  expect(await untrustPickerCaLinux(legacy.sha1, db.run, h)).toEqual({ ok: true });
  expect(db.certs).toHaveLength(0);
});

test("a root installed between the predecessor lookup and its deletion stays trusted", async () => {
  const predecessor = pickerRoot();
  const current = pickerRoot();
  const h = home();
  const db = nss([entry(predecessor)]);
  let installed = false;
  // Install the current root exactly when untrust is about to delete, after it read the predecessor.
  const run: LinuxTrustRunner = async args => {
    if (args[0] === "-D" && !installed) {
      installed = true;
      expect(await trustPickerCaLinux("/ca.pem", db.run, { pem: current.pem }, h)).toEqual({ ok: true });
    }
    return db.run(args);
  };
  expect(await untrustPickerCaLinux(predecessor.sha1, run, h)).toEqual({ ok: true });
  expect(installed).toBe(true);
  expect(db.certs.map(c => c.nickname)).toEqual([linuxPickerNickname(current.sha1)]);
  expect(await inspectPickerTrustLinux(current.sha1, db.run, h)).toBe("trusted");
});

test("a truncated listing is a failed read: untrust fails and trust stays unknown", async () => {
  const root = pickerRoot();
  const truncated: LinuxTrustRunner = async () => ({ code: null, stdout: "", stderr: LINUX_TRUST_TRUNCATED });
  expect(await untrustPickerCaLinux(root.sha1, truncated, home())).toEqual({ ok: false });
  expect(await inspectPickerTrustLinux(root.sha1, truncated, home())).toBe("unknown");
});
