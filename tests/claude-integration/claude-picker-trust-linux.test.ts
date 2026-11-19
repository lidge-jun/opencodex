import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import {
  ensurePickerCa, PICKER_CA_COMMON_NAME, PICKER_HOST, pickerCaCertPath, pickerCaFingerprints,
  pickerCaPendingUntrustPath,
} from "../../src/claude/intercept/picker-ca";
import { drainPendingPickerCaUntrust } from "../../src/claude/intercept/picker-ca-cleanup";
import {
  createLinuxCertutilRunner,
  inspectPickerTrustLinux,
  LINUX_TRUST_TRUNCATED,
  linuxNssDbDir,
  linuxPickerNickname,
  trustPickerCaLinux,
  untrustPickerCaLinux,
  type LinuxTrustRunner,
} from "../../src/claude/intercept/picker-trust-linux";
import { repoPath } from "../helpers/repo-root";
import { trustPickerCa, type SecurityResult } from "../../src/claude/intercept/picker-trust";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function home(withDb = true): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-nss-home-"));
  homes.push(dir);
  if (withDb) {
    const legacy = join(dir, ".pki", "nssdb");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "cert9.db"), "");
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
const header = "\nCertificate Nickname                                         Trust Attributes\n"
  + "                                                             SSL,S/MIME,JAR/XPI\n\n";

function nss(initial: Entry[] = [], options: { broken?: boolean } = {}) {
  const certs = [...initial];
  const calls: string[][] = [];
  const run: LinuxTrustRunner = async args => {
    calls.push([...args]);
    const op = args[0];
    const db = args.includes("-d") ? args[args.indexOf("-d") + 1]!.slice("sql:".length) : "";
    const nickname = args.includes("-n") ? args[args.indexOf("-n") + 1]! : undefined;
    if (options.broken && op === "-L") return exit255;
    if (op === "-L" && nickname !== undefined) {
      const found = certs.find(c => c.nickname === nickname);
      if (!found) return exit255;
      const parse = (candidate: Entry): X509Certificate | null => {
        try { return new X509Certificate(candidate.pem); } catch { return null; }
      };
      const subject = parse(found)?.subject;
      if (!subject) return ok(found.pem);
      const siblings = certs.filter(c => parse(c)?.subject === subject);
      if (siblings.length > 1) {
        using sql = new Database(join(db, "cert9.db"));
        sql.exec("CREATE TABLE IF NOT EXISTS nssPublic (a0 BLOB, a3 BLOB, a11 BLOB); DELETE FROM nssPublic");
        const insert = sql.query("INSERT INTO nssPublic VALUES (X'00000001', ?, ?)");
        for (const sibling of siblings) insert.run(Buffer.from(sibling.nickname), parse(sibling)!.raw);
      }
      return ok(siblings.map(c => c.pem).join("\n"));
    }
    if (op === "-L") {
      return ok(header + certs.map(c => `${c.nickname}                           ${c.flags},,\n`).join(""));
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
    if (op === "-N") {
      writeFileSync(join(db, "cert9.db"), "");
      return ok();
    }
    if (op === "--build-flags") return ok();
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

test("an NSS directory stat failure reads as unknown without invoking certutil", async () => {
  const root = pickerRoot();
  const db = nss();
  const inaccessibleHome = join(home(false), "h".repeat(512));
  expect(await inspectPickerTrustLinux(root.sha1, db.run, inaccessibleHome)).toBe("unknown");
  expect(db.calls).toEqual([]);
});

test("confirmed NSS directory absence skips certutil for inspection and removal", async () => {
  const root = pickerRoot();
  const db = nss();
  const missing = home(false);
  const blockedByFile = home(false);
  writeFileSync(join(blockedByFile, ".pki"), "");
  for (const h of [missing, blockedByFile]) {
    expect(await inspectPickerTrustLinux(root.sha1, db.run, h)).toBe("untrusted");
    expect(await untrustPickerCaLinux(root.sha1, db.run, h, root)).toEqual({ ok: true });
  }
  expect(db.calls).toEqual([]);
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
  expect(db.calls.slice(0, 2)).toEqual([
    ["--build-flags"],
    ["-N", "-d", `sql:${join(h, ".local", "share", "pki", "nssdb")}`, "--empty-password"],
  ]);
});

test("untrust removes only the predecessor, even when the current root was installed meanwhile", async () => {
  const predecessor = pickerRoot();
  const current = pickerRoot();
  const h = home();
  const db = nss([entry(predecessor), entry(current)]);
  expect(await inspectPickerTrustLinux(predecessor.sha1, db.run, h)).toBe("trusted");
  expect(await inspectPickerTrustLinux(current.sha1, db.run, h)).toBe("trusted");
  expect(await untrustPickerCaLinux(predecessor.sha1, db.run, h, predecessor)).toEqual({ ok: true });
  expect(db.certs.map(c => c.nickname)).toEqual([linuxPickerNickname(current.sha1)]);
  expect(await inspectPickerTrustLinux(current.sha1, db.run, h)).toBe("trusted");
});

test("a same-subject export cannot lend a sibling's DER to a mismatched nickname", async () => {
  const root = pickerRoot();
  const sibling = pickerRoot();
  const h = home();
  const db = nss([
    { ...entry(sibling), nickname: linuxPickerNickname(root.sha1) },
    { ...entry(root), nickname: "renamed certificate" },
  ]);
  expect(await inspectPickerTrustLinux(root.sha1, db.run, h)).toBe("untrusted");
  expect(await untrustPickerCaLinux(root.sha1, db.run, h, root)).toEqual({ ok: false });
  expect(db.calls.some(call => call[0] === "-D")).toBe(false);
});

test("untrust succeeds only on a readable database proving absence", async () => {
  const root = pickerRoot();
  const empty = nss();
  expect(await untrustPickerCaLinux(root.sha1, empty.run, home(), root)).toEqual({ ok: true });
  expect(empty.calls.map(call => call[0])).toEqual(["-L", "-L"]);
  expect(await untrustPickerCaLinux(root.sha1, nss([entry(root)], { broken: true }).run, home(), root)).toEqual({ ok: false });
  const foreign = { nickname: linuxPickerNickname(root.sha1), pem: pickerRoot().pem, flags: "C" };
  const kept = nss([foreign]);
  expect(await untrustPickerCaLinux(root.sha1, kept.run, home(), root)).toEqual({ ok: false });
  expect(kept.certs).toHaveLength(1);
  const refusing: LinuxTrustRunner = async args => args[0] === "-D" ? { code: 1, stdout: "", stderr: "" } : nss([entry(root)]).run(args);
  expect(await untrustPickerCaLinux(root.sha1, refusing, home(), root)).toEqual({ ok: false });
});

test("legacy trust is recognised but its shared nickname is never used for deletion", async () => {
  const legacy = pickerRoot();
  const other = pickerRoot();
  const h = home();
  const db = nss([{ nickname: PICKER_CA_COMMON_NAME, pem: legacy.pem, flags: "C" }]);
  expect(await inspectPickerTrustLinux(legacy.sha1, db.run, h)).toBe("trusted");
  // Another root under the legacy nickname is neither trusted nor deleted for this fingerprint.
  expect(await inspectPickerTrustLinux(other.sha1, db.run, h)).toBe("untrusted");
  expect(await untrustPickerCaLinux(other.sha1, db.run, h, other)).toEqual({ ok: true });
  expect(db.certs).toHaveLength(1);
  expect(await untrustPickerCaLinux(legacy.sha1, db.run, h, legacy)).toEqual({ ok: false });
  expect(db.calls.some(call => call[0] === "-D")).toBe(false);
  expect(db.certs).toHaveLength(1);
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
  expect(await untrustPickerCaLinux(predecessor.sha1, run, h, predecessor)).toEqual({ ok: true });
  expect(installed).toBe(true);
  expect(db.certs.map(c => c.nickname)).toEqual([linuxPickerNickname(current.sha1)]);
  expect(await inspectPickerTrustLinux(current.sha1, db.run, h)).toBe("trusted");
});

test("a truncated listing is a failed read: untrust fails and trust stays unknown", async () => {
  const root = pickerRoot();
  const truncated: LinuxTrustRunner = async () => ({ code: null, stdout: "", stderr: LINUX_TRUST_TRUNCATED });
  expect(await untrustPickerCaLinux(root.sha1, truncated, home(), root)).toEqual({ ok: false });
  expect(await inspectPickerTrustLinux(root.sha1, truncated, home())).toBe("unknown");
});

/** Execute a JS certutil fixture through the current Bun executable, including on Windows. */
function fakeCertutil(dir: string, nickname: string, pem: string, padding: number): LinuxTrustRunner {
  const script = join(dir, "certutil.cjs");
  writeFileSync(script, `
    if (process.argv.includes("-n")) process.stdout.write(${JSON.stringify(pem)});
    else process.stdout.write(${JSON.stringify(header + nickname + "    C,,\n")} + " ".repeat(${padding}));
  `);
  const run = createLinuxCertutilRunner(process.execPath);
  return args => run([script, ...args]);
}

test("the production runner rejects a listing past its output limit instead of reporting absence", async () => {
  const predecessor = pickerRoot();
  const h = home();
  const nickname = linuxPickerNickname(predecessor.sha1);
  // Control: the same listing under the limit shows the predecessor through the real runner.
  const small = fakeCertutil(mkdtempSync(join(h, "small-")), nickname, predecessor.pem, 1024);
  expect(await inspectPickerTrustLinux(predecessor.sha1, small, h)).toBe("trusted");
  // Past 4 MiB the predecessor, listed first, must not be read as absent.
  const large = fakeCertutil(mkdtempSync(join(h, "large-")), nickname, predecessor.pem, 5 * 1024 * 1024);
  expect(await large(["-L", "-d", `sql:${linuxNssDbDir(h)}`])).toEqual({ code: null, stdout: "", stderr: LINUX_TRUST_TRUNCATED });
  expect(await untrustPickerCaLinux(predecessor.sha1, large, h, predecessor)).toEqual({ ok: false });
  expect(await inspectPickerTrustLinux(predecessor.sha1, large, h)).toBe("unknown");
});

test("trust, inspect and untrust select the XDG database without creating a legacy shadow", async () => {
  const root = pickerRoot();
  for (const custom of [false, true]) {
    const h = home(false);
    const xdg = custom ? join(h, "data") : undefined;
    const dir = join(xdg ?? join(h, ".local", "share"), "pki", "nssdb");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cert9.db"), "");
    const db = nss();
    expect(await trustPickerCaLinux("/ca.pem", db.run, root, h, xdg)).toEqual({ ok: true });
    expect(await inspectPickerTrustLinux(root.sha1, db.run, h, xdg)).toBe("trusted");
    expect(await untrustPickerCaLinux(root.sha1, db.run, h, root, xdg)).toEqual({ ok: true });
    expect(db.calls.filter(call => call.includes("-d")).every(call => call.includes(`sql:${dir}`))).toBe(true);
    expect(existsSync(join(h, ".pki"))).toBe(false);
  }
});

test("missing certutil leaves a fresh home untouched", async () => {
  const h = home(false);
  const root = pickerRoot();
  const missing = createLinuxCertutilRunner(null);
  expect(await trustPickerCaLinux("/ca.pem", missing, root, h)).toEqual({ ok: false, reason: "unsupported" });
  expect(existsSync(join(h, ".pki"))).toBe(false);
  expect(existsSync(join(h, ".local"))).toBe(false);
});

test.skipIf(process.platform === "win32")("unsafe NSS paths refuse reads and writes", async () => {
  const root = pickerRoot();
  const h = home();
  const dir = linuxNssDbDir(h);
  chmodSync(dir, 0o777);
  const linkedHome = home(false);
  mkdirSync(join(linkedHome, ".pki"));
  symlinkSync(linuxNssDbDir(home()), join(linkedHome, ".pki", "nssdb"));
  for (const unsafeHome of [h, linkedHome]) {
    const db = nss([entry(root)]);
    expect(await inspectPickerTrustLinux(root.sha1, db.run, unsafeHome)).toBe("unknown");
    expect(await trustPickerCaLinux("/ca.pem", db.run, root, unsafeHome)).toEqual({ ok: false, reason: "declined_or_failed" });
    expect(await untrustPickerCaLinux(root.sha1, db.run, unsafeHome, root)).toEqual({ ok: false });
    expect(db.calls).toEqual([]);
  }
});

test("pending PEM must authorize the exact constrained picker root before any certutil call", async () => {
  const root = pickerRoot();
  const foreign = createCertificateAuthority({ commonName: "foreign CA" }).certPem;
  const unconstrained = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME }).certPem;
  const other = pickerRoot();
  for (const [target, pem] of [
    [{ pem: foreign, sha1: pickerCaFingerprints(foreign).sha1 }, foreign],
    [{ pem: unconstrained, sha1: pickerCaFingerprints(unconstrained).sha1 }, unconstrained],
    [root, other.pem],
  ] as const) {
    const db = nss([entry(target)]);
    expect(await untrustPickerCaLinux(target.sha1, db.run, home(), { pem })).toEqual({ ok: false });
    expect(db.calls).toEqual([]);
  }
});

test("untrust refuses a nickname that lists multiple certificates", async () => {
  const root = pickerRoot();
  const foreign = { ...entry(pickerRoot()), nickname: linuxPickerNickname(root.sha1) };
  const db = nss([entry(root), foreign]);
  expect(await untrustPickerCaLinux(root.sha1, db.run, home(), root)).toEqual({ ok: false });
  expect(db.calls.some(call => call[0] === "-D")).toBe(false);
  expect(db.certs).toEqual([entry(root), foreign]);
});

test("untrust checks the nickname again immediately before deleting", async () => {
  const root = pickerRoot();
  const foreign = { ...entry(pickerRoot()), nickname: linuxPickerNickname(root.sha1) };
  const db = nss([entry(root)]);
  let exports = 0;
  const run: LinuxTrustRunner = async args => {
    if (args[0] === "-L" && args.includes("-n") && ++exports === 2) db.certs[0] = foreign;
    return db.run(args);
  };
  expect(await untrustPickerCaLinux(root.sha1, run, home(), root)).toEqual({ ok: false });
  expect(db.calls.some(call => call[0] === "-D")).toBe(false);
  expect(db.certs).toEqual([foreign]);
});

test("untrust retains the retry record when the root is renamed or an export is unreadable", async () => {
  const root = pickerRoot();
  for (const cert of [
    { ...entry(root), nickname: "renamed certificate" },
    { ...entry(root), nickname: PICKER_CA_COMMON_NAME, pem: "unreadable" },
  ]) {
    const db = nss([cert]);
    expect(await untrustPickerCaLinux(root.sha1, db.run, home(), root)).toEqual({ ok: false });
    expect(db.calls.some(call => call[0] === "-D")).toBe(false);
  }
});

test("untrust checks the whole database after deletion and verifies other certificates survived", async () => {
  const root = pickerRoot();
  const foreign = { ...entry(pickerRoot()), nickname: PICKER_CA_COMMON_NAME };
  for (const renamed of [true, false]) {
    const db = nss([entry(root), foreign]);
    const run: LinuxTrustRunner = async args => {
      if (args[0] !== "-D") return db.run(args);
      const result = await db.run(args);
      if (renamed) db.certs.push({ ...entry(root), nickname: "renamed during removal" });
      else db.certs.splice(0, 1);
      return result;
    };
    expect(await untrustPickerCaLinux(root.sha1, run, home(), root)).toEqual({ ok: false });
  }
});

test("the production runner kills an overflowing child on either pipe before it can finish", async () => {
  const h = home(false);
  const marker = join(h, "child-finished");
  const script = join(h, "overflow.cjs");
  writeFileSync(script, `
    const fs = require("node:fs");
    process[process.argv[2]].write("é".repeat(3 * 1024 * 1024), () => {
      setTimeout(() => fs.writeFileSync(process.argv[3], "finished"), 200);
    });
  `);
  const run = createLinuxCertutilRunner(process.execPath);
  for (const pipe of ["stdout", "stderr"]) {
    expect(await run([script, pipe, marker])).toEqual({ code: null, stdout: "", stderr: LINUX_TRUST_TRUNCATED });
    expect(existsSync(marker)).toBe(false);
  }
});

test("the runtime contract includes on-demand Linux picker startup", () => {
  const runtime = readFileSync(repoPath("structure/runtime.md"), "utf8");
  expect(runtime.includes("Windows and Linux defer picker startup until picker intent or an applied profile requires recovery.")).toBe(true);
});

const certutil = Bun.which("certutil");
const realCertutil = certutil && Bun.spawnSync([certutil, "--build-flags"], { stderr: "ignore" }).exitCode === 0
  ? certutil : null;
const realNssTest = test.skipIf(realCertutil === null);
const nssSkipReason = realCertutil === null ? " (NSS certutil is unavailable on PATH)" : "";

async function initializeNss(run: LinuxTrustRunner, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  expect(await run(["-N", "-d", `sql:${dir}`, "--empty-password"])).toMatchObject({ code: 0 });
}

function realNssRunner(h: string): LinuxTrustRunner {
  return createLinuxCertutilRunner(realCertutil, { ...process.env, HOME: h, USERPROFILE: h });
}

realNssTest("real NSS round trips a single picker root in XDG and legacy stores" + nssSkipReason, async () => {
  for (const legacy of [false, true]) {
    const h = home(false);
    const run = realNssRunner(h);
    const xdg = join(h, "data");
    const dir = legacy ? join(h, ".pki", "nssdb") : join(xdg, "pki", "nssdb");
    if (legacy) await initializeNss(run, dir);
    const root = pickerRoot();
    expect(await trustPickerCaLinux("/ca.pem", run, root, h, xdg)).toMatchObject({ ok: true });
    expect(linuxNssDbDir(h, xdg)).toBe(dir);
    expect(await inspectPickerTrustLinux(root.sha1, run, h, xdg)).toBe("trusted");
    expect(await untrustPickerCaLinux(root.sha1, run, h, root, xdg)).toEqual({ ok: true });
    expect(await inspectPickerTrustLinux(root.sha1, run, h, xdg)).toBe("untrusted");
  }
});

realNssTest("real NSS identifies both same-subject roots and removes only the selected one" + nssSkipReason, async () => {
  const h = home(false);
  const run = realNssRunner(h);
  const roots = [pickerRoot(), pickerRoot()] as const;
  for (const root of roots) expect(await trustPickerCaLinux("/ca.pem", run, root, h)).toMatchObject({ ok: true });
  const db = `sql:${linuxNssDbDir(h)}`;
  for (const root of roots) {
    const exported = await run(["-L", "-d", db, "-n", linuxPickerNickname(root.sha1), "-a"]);
    expect(exported.stdout.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
    expect(await inspectPickerTrustLinux(root.sha1, run, h)).toBe("trusted");
  }
  const [retired, survivor] = roots;
  expect(await untrustPickerCaLinux(retired.sha1, run, h, retired)).toEqual({ ok: true });
  expect(await inspectPickerTrustLinux(retired.sha1, run, h)).toBe("untrusted");
  expect(await inspectPickerTrustLinux(survivor.sha1, run, h)).toBe("trusted");
  expect((await run(["-L", "-d", db])).stdout).toMatch(new RegExp(linuxPickerNickname(survivor.sha1) + "\\s+C,,"));
});

async function retireRoot(run: LinuxTrustRunner, h: string) {
  const root = pickerRoot();
  const configDir = join(h, "config");
  const caPath = pickerCaCertPath(configDir);
  mkdirSync(join(configDir, "claude-picker"), { recursive: true });
  writeFileSync(caPath, root.pem);
  const cert = { pem: root.pem, configDir };
  expect(await trustPickerCa(caPath, run, "linux", cert, h)).toMatchObject({ ok: true });
  ensurePickerCa(configDir, { rotation: "startup" });
  return { configDir, root, journal: pickerCaPendingUntrustPath(configDir) };
}

test("a fake XDG install binds the journal even when an empty legacy database becomes preferred", async () => {
  const h = home(false);
  const xdg = linuxNssDbDir(h);
  const legacy = join(h, ".pki", "nssdb");
  const original = nss();
  const shadow = nss();
  const run: LinuxTrustRunner = args => args.includes(`sql:${legacy}`) ? shadow.run(args) : original.run(args);
  const { configDir, root, journal } = await retireRoot(run, h);
  const recorded = readFileSync(journal, "utf8");
  expect(JSON.parse(recorded).linuxStore.dir).toBe(realpathSync(xdg));
  renameSync(xdg, xdg + "-saved");
  await initializeNss(run, legacy);
  const accesses = original.calls.length + shadow.calls.length;
  expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(false);
  expect(readFileSync(journal, "utf8")).toBe(recorded);
  expect(original.calls.length + shadow.calls.length).toBe(accesses);
  expect(original.certs).toEqual([entry(root)]);
  renameSync(xdg + "-saved", xdg);
  expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(true);
  expect(original.certs).toEqual([]);
  expect(existsSync(journal)).toBe(false);
});

test("a legacy journal checks XDG even when the empty legacy directory is preferred", async () => {
  const h = home(false);
  const xdg = linuxNssDbDir(h);
  const legacy = join(h, ".pki", "nssdb");
  const root = pickerRoot();
  const original = nss();
  const shadow = nss();
  const run: LinuxTrustRunner = args => args.includes(`sql:${legacy}`) ? shadow.run(args) : original.run(args);
  await initializeNss(run, xdg);
  await initializeNss(run, legacy);
  const configDir = join(h, "config");
  const journal = pickerCaPendingUntrustPath(configDir);
  ensurePickerCa(configDir);
  writeFileSync(journal, JSON.stringify({ certPem: root.pem, ...pickerCaFingerprints(root.pem) }));
  const alias = { ...entry(root), nickname: PICKER_CA_COMMON_NAME };
  original.certs.push(alias);
  expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(false);
  expect(existsSync(journal)).toBe(true);
  expect(original.certs).toEqual([alias]);
  original.certs[0] = entry(root);
  expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(true);
  expect(original.certs).toEqual([]);
  expect(shadow.calls.some(call => call[0] === "-L")).toBe(true);
  expect(existsSync(journal)).toBe(false);
});

function writeUnboundJournal(configDir: string, root: { pem: string }): string {
  const journal = pickerCaPendingUntrustPath(configDir);
  mkdirSync(dirname(journal), { recursive: true, mode: 0o700 });
  writeFileSync(journal, JSON.stringify({ certPem: root.pem, ...pickerCaFingerprints(root.pem) }), { mode: 0o600 });
  return journal;
}

test("an unbound journal retries after the fake NSS delete succeeds and verification fails", async () => {
  const h = home(false);
  const dir = linuxNssDbDir(h);
  const configDir = join(h, "config");
  const root = pickerRoot();
  const db = nss([entry(root)]);
  await initializeNss(db.run, dir);
  const journal = writeUnboundJournal(configDir, root);

  let beforeDelete: { linuxStore?: unknown } | undefined;
  let failNextRead = false;
  const run: LinuxTrustRunner = async args => {
    if (args[0] === "-D") beforeDelete = JSON.parse(readFileSync(journal, "utf8"));
    if (args[0] === "-L" && failNextRead) {
      failNextRead = false;
      return exit255;
    }
    const result = await db.run(args);
    if (args[0] === "-D" && result.code === 0) failNextRead = true;
    return result;
  };
  expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(false);
  expect(db.certs).toEqual([]);
  expect(failNextRead).toBe(false);
  const retained = JSON.parse(readFileSync(journal, "utf8"));
  expect(await drainPendingPickerCaUntrust(configDir, db.run, "linux", h)).toBe(true);
  expect(existsSync(journal)).toBe(false);
  expect(db.calls.filter(call => call[0] === "-D")).toHaveLength(1);
  const fileId = (path: string) => {
    const { dev, ino } = fs.lstatSync(path, { bigint: true });
    return `${dev}:${ino}`;
  };
  expect(retained.linuxStore).toEqual({ dir: realpathSync(dir), directoryId: fileId(dir), certDbId: fileId(join(dir, "cert9.db")) });
  expect(beforeDelete).toEqual(retained);
});

test("an unbound journal changed during NSS lookup prevents deletion", async () => {
  const h = home(false);
  const configDir = join(h, "config");
  const root = pickerRoot();
  const replacement = pickerRoot();
  const db = nss([entry(root)]);
  await initializeNss(db.run, linuxNssDbDir(h));
  const journal = writeUnboundJournal(configDir, root);
  const run: LinuxTrustRunner = args => {
    if (args[0] === "-L" && args.includes("-n")) writeUnboundJournal(configDir, replacement);
    return db.run(args);
  };
  expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(false);
  expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual({ certPem: replacement.pem, ...pickerCaFingerprints(replacement.pem) });
  expect(db.certs).toEqual([entry(root)]);
  expect(db.calls.some(call => call[0] === "-D")).toBe(false);
});

test("an unbound journal finds no unique store when two NSS databases contain the CA", async () => {
  const h = home(false);
  const configDir = join(h, "config");
  const root = pickerRoot();
  const xdg = linuxNssDbDir(h);
  const legacy = join(h, ".pki", "nssdb");
  const db = nss([entry(root)]);
  const shadow = nss([entry(root)]);
  await initializeNss(db.run, xdg);
  await initializeNss(shadow.run, legacy);
  const journal = writeUnboundJournal(configDir, root);
  const recorded = readFileSync(journal, "utf8");
  const run: LinuxTrustRunner = args => args.includes(`sql:${legacy}`) ? shadow.run(args) : db.run(args);
  expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(false);
  expect(readFileSync(journal, "utf8")).toBe(recorded);
  expect(db.certs).toEqual([entry(root)]);
  expect(shadow.certs).toEqual([entry(root)]);
  expect([...db.calls, ...shadow.calls].some(call => call[0] === "-D")).toBe(false);
});

realNssTest("real NSS cleanup retains the journal when store preference changes and the recorded store is replaced" + nssSkipReason, async () => {
  const h = home(false);
  const run = realNssRunner(h);
  const { configDir, root, journal } = await retireRoot(run, h);
  const original = linuxNssDbDir(h);
  const saved = original + "-saved";
  const legacy = join(h, ".pki", "nssdb");
  const recorded = readFileSync(journal, "utf8");
  renameSync(original, saved);
  await initializeNss(run, legacy);
  expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(false);
  expect(readFileSync(journal, "utf8")).toBe(recorded);
  expect((await run(["-L", "-d", `sql:${saved}`])).stdout).toContain(linuxPickerNickname(root.sha1));
  await initializeNss(run, original);
  expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(false);
  expect(readFileSync(journal, "utf8")).toBe(recorded);
  renameSync(original, original + "-replacement");
  renameSync(saved, original);
  if (process.platform !== "win32") {
    chmodSync(original, 0o777);
    expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(false);
    expect(readFileSync(journal, "utf8")).toBe(recorded);
    chmodSync(original, 0o700);
  }
  const certDb = join(original, "cert9.db");
  renameSync(certDb, certDb + "-saved");
  writeFileSync(certDb, "");
  expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(false);
  expect(readFileSync(journal, "utf8")).toBe(recorded);
  renameSync(certDb + "-saved", certDb);
  expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(true);
  expect(existsSync(journal)).toBe(false);
  expect((await run(["-L", "-d", `sql:${original}`])).stdout).not.toContain(linuxPickerNickname(root.sha1));
});

realNssTest("real NSS unbound journal needs removal after a custom XDG change" + nssSkipReason, async () => {
  const h = home(false);
  const run = realNssRunner(h);
  const original = join(h, "data-a");
  const switched = join(h, "data-b");
  const root = pickerRoot();
  const configDir = join(h, "config");
  const journal = pickerCaPendingUntrustPath(configDir);
  expect(await trustPickerCaLinux("/ca.pem", run, root, h, original)).toEqual({ ok: true });
  await initializeNss(run, linuxNssDbDir(h, switched));
  ensurePickerCa(configDir);
  const recorded = JSON.stringify({ certPem: root.pem, ...pickerCaFingerprints(root.pem) });
  writeFileSync(journal, recorded, { mode: 0o600 });

  // Start Bun with a disposable HOME so both Chromium paths resolve inside the fixture.
  async function drain(xdg: string) {
    const child = Bun.spawn([process.execPath, "-e", `
      import { drainPendingPickerCaUntrust } from "./src/claude/intercept/picker-ca-cleanup";
      console.log(await drainPendingPickerCaUntrust(process.argv[1], undefined, "linux"));
    `, configDir], {
      cwd: repoPath("."),
      env: { ...process.env, HOME: h, USERPROFILE: h, XDG_DATA_HOME: xdg },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    expect(code).toBe(0);
    return { drained: stdout.trim(), stderr };
  }

  const first = await drain(switched);
  expect(first.drained).toBe("false");
  expect(first.stderr).toContain("XDG_DATA_HOME");
  expect(readFileSync(journal, "utf8")).toBe(recorded);
  expect(await inspectPickerTrustLinux(root.sha1, run, h, original)).toBe("trusted");
  expect((await drain(original)).drained).toBe("true");
  expect(existsSync(journal)).toBe(false);
  expect(await inspectPickerTrustLinux(root.sha1, run, h, original)).toBe("untrusted");
});

realNssTest("real NSS startup retries after the unbound delete succeeds and verification fails" + nssSkipReason, async () => {
  const h = home(false);
  const xdg = join(h, "custom-data");
  const run = realNssRunner(h);
  const root = pickerRoot();
  const configDir = join(h, "config");
  expect(await trustPickerCaLinux("/ca.pem", run, root, h, xdg)).toEqual({ ok: true });
  const journal = writeUnboundJournal(configDir, root);

  const child = Bun.spawn([process.execPath, "-e", `
    import { readFileSync } from "node:fs";
    import { preparePersistentPickerAuthority } from "./src/claude/intercept/picker-ca-startup";
    import { createLinuxCertutilRunner } from "./src/claude/intercept/picker-trust-linux";
    import { memoryPickerCaStore } from "./tests/helpers/picker-ca-store";
    const [configDir, journal, certutil] = process.argv.slice(1);
    const run = createLinuxCertutilRunner(certutil);
    const store = memoryPickerCaStore().store;
    let deleted = 0;
    let failedReads = 0;
    const failVerification = async args => {
      if (args[0] === "-L" && deleted === 1 && failedReads === 0) {
        failedReads++;
        return { code: 255, stdout: "", stderr: "injected post-delete read failure" };
      }
      const result = await run(args);
      if (args[0] === "-D" && result.code === 0) deleted++;
      return result;
    };
    const prepare = security => preparePersistentPickerAuthority({ configDir, platform: "linux", security, store })
      .then(ca => ca.fingerprint, error => error.message);
    const first = await prepare(failVerification);
    const retained = JSON.parse(readFileSync(journal, "utf8"));
    const retry = await prepare(run);
    console.log(JSON.stringify({ first, retained, retry, deleted, failedReads }));
  `, configDir, journal, realCertutil!], {
    cwd: repoPath("."), env: { ...process.env, HOME: h, USERPROFILE: h, XDG_DATA_HOME: xdg },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
  expect(code, stderr).toBe(0);
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({ first: "picker_ca_pending_untrust", deleted: 1, failedReads: 1 });
  expect(await inspectPickerTrustLinux(root.sha1, run, h, xdg)).toBe("untrusted");
  expect(result.retry, stderr).toMatch(/^[A-F0-9]{64}$/);
  expect(result.retained.linuxStore.dir).toBe(realpathSync(linuxNssDbDir(h, xdg)));
  expect(existsSync(journal)).toBe(false);
});

test.skipIf(realCertutil === null || process.platform === "win32")(
  "real NSS refuses a 0666 journal and a group-writable journal directory" +
    (process.platform === "win32" ? " (requires POSIX file modes)" : nssSkipReason),
  async () => {
    const h = home(false);
    const run = realNssRunner(h);
    const { configDir, root, journal } = await retireRoot(run, h);
    const recorded = readFileSync(journal, "utf8");
    for (const [path, unsafe, safe] of [[journal, 0o666, 0o600], [dirname(journal), 0o770, 0o700]] as const) {
      chmodSync(path, unsafe);
      await expect(drainPendingPickerCaUntrust(configDir, run, "linux", h))
        .rejects.toThrow("picker_ca_pending_untrust_unsafe");
      expect(readFileSync(journal, "utf8")).toBe(recorded);
      expect(await inspectPickerTrustLinux(root.sha1, run, h)).toBe("trusted");
      chmodSync(path, safe);
    }
    expect(await drainPendingPickerCaUntrust(configDir, run, "linux", h)).toBe(true);
    expect(existsSync(journal)).toBe(false);
    expect(await inspectPickerTrustLinux(root.sha1, run, h)).toBe("untrusted");
  },
);

test.skipIf(process.platform === "win32")("a journal with a foreign uid or mismatched descriptor stays pending", async () => {
  const h = home(false);
  const db = nss();
  const { configDir, root, journal } = await retireRoot(db.run, h);
  const recorded = readFileSync(journal, "utf8");
  const lstat = fs.lstatSync;
  const fstat = fs.fstatSync;
  const identity = lstat(journal, { bigint: true });
  const foreign = spyOn(fs, "lstatSync").mockImplementation(((path, options) => {
    const stat = lstat(path, options);
    if (path === journal) Object.defineProperty(stat, "uid", { value: identity.uid + 1n });
    return stat;
  }) as typeof lstat);
  try {
    await expect(drainPendingPickerCaUntrust(configDir, db.run, "linux", h))
      .rejects.toThrow("picker_ca_pending_untrust_unsafe");
  } finally {
    foreign.mockRestore();
  }
  const swapped = spyOn(fs, "fstatSync").mockImplementation(((fd, options) => {
    const stat = fstat(fd, options);
    if (stat.dev === identity.dev && stat.ino === identity.ino) {
      Object.defineProperty(stat, "ino", { value: identity.ino + 1n });
    }
    return stat;
  }) as typeof fstat);
  try {
    await expect(drainPendingPickerCaUntrust(configDir, db.run, "linux", h))
      .rejects.toThrow("picker_ca_pending_untrust_unsafe");
  } finally {
    swapped.mockRestore();
  }
  expect(readFileSync(journal, "utf8")).toBe(recorded);
  expect(db.certs).toEqual([entry(root)]);
});
