import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { DESKTOP_UPDATE_FEED_URL, desktopInstallerUrl } from "../../src/desktop-update/trust";
import { HEADLESS_EXIT, runHeadlessDesktopUpdate, type HeadlessDeps } from "../../src/desktop-update/headless";
import { desktopUpdateCommand, windowsDesktopInstall, withDesktopSkewAdvice } from "../../src/desktop-update/install";
import { parseHeadlessArgs, parseVersionOutput } from "../../src/desktop-update/cli";
import { computeVersionSkew } from "../../src/cli/version-skew";
import type { LiveProxy } from "../../src/server/proxy-liveness";

const INSTALL = { dir: "C:\\Program Files\\OpenCodex", ocxExe: "C:\\Program Files\\OpenCodex\\ocx.exe", desktopExe: "C:\\Program Files\\OpenCodex\\opencodex-desktop.exe" };
const MOVED = "C:\\Program Files\\OpenCodex\\ocx.exe.42-1.update-old";
const MSI = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.from("fixture installer")]);

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
  const id = Buffer.from("8899aabbccddeeff", "hex");
  const pubkey = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`).toString("base64");
  const signBytes = (bytes: Uint8Array, version: string) => {
    const comment = `timestamp:1\tfile:OpenCodex_${version}_x64_en-US.msi`;
    const signature = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    const packet = Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64");
    return Buffer.from(`untrusted comment: s\n${packet}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`).toString("base64");
  };
  return { pubkey, signBytes };
}

function live(pid: number, version: string): LiveProxy {
  return { pid, port: 10100, hostname: "127.0.0.1", source: "runtime", version };
}

interface Scenario {
  installed?: string;
  published?: string;
  signature?: string;
  msi?: Uint8Array;
  tamperStaged?: boolean;
  installerExit?: number | "hang";
  readBack?: string | null;
  runtime?: Array<LiveProxy | null>;
  image?: string;
  moveFails?: boolean;
  restoreBlocked?: boolean;
}

function harness(s: Scenario = {}) {
  const key = signer();
  const published = s.published ?? "2.100.3";
  const events: string[] = [];
  const files = new Map<string, Uint8Array>();
  const answers = [...(s.runtime ?? [live(7, "2.99.0"), live(7, "2.99.0"), live(7, "2.99.0"), live(8, published)])];
  let clock = 0;
  let fireInstallerDeadline: (() => void) | null = null;
  const deps: HeadlessDeps = {
    install: INSTALL,
    currentVersion: s.installed ?? "2.99.0",
    fixturePublicKey: key.pubkey,
    fetch: async (url, maxBytes) => {
      events.push(`fetch ${url} ${maxBytes}`);
      if (url === DESKTOP_UPDATE_FEED_URL) {
        return new TextEncoder().encode(JSON.stringify({ version: published, platforms: { "windows-x86_64": {
          url: desktopInstallerUrl(published), signature: s.signature ?? key.signBytes(MSI, published) } } }));
      }
      if (url === desktopInstallerUrl(published)) return s.msi ?? MSI;
      throw new Error(`unexpected ${url}`);
    },
    staging: {
      create: () => { events.push("stage"); return "C:\\Temp\\ocx-desktop-update-1"; },
      write: (path, bytes) => { events.push(`write ${path}`); files.set(path, bytes); },
      read: path => { const bytes = Buffer.from(files.get(path)!); if (s.tamperStaged) bytes[bytes.length - 1] ^= 1; return bytes; },
      join: (dir, name) => `${dir}\\${name}`,
      discard: (dir, keep) => { events.push(`discard ${dir} keep=${keep.join(",")}`); },
    },
    moveAsideOwnImage: () => {
      if (s.moveFails) throw new Error("EPERM");
      events.push("move-aside");
      return MOVED;
    },
    restoreOwnImage: moved => { events.push(`restore ${moved}`); return !s.restoreBlocked; },
    retireMovedImages: current => { events.push(`retire ${current ?? "-"}`); },
    msiexecPath: () => "C:\\Windows\\System32\\msiexec.exe",
    spawnInstaller: (file, args) => {
      events.push(`msiexec ${[file, ...args].join(" ")}`);
      if (s.installerExit === "hang") return { exited: new Promise(() => {}) };
      return { exited: Promise.resolve(s.installerExit ?? 0) };
    },
    timers: { schedule: (_ms, fire) => { fireInstallerDeadline = fire; return () => { fireInstallerDeadline = null; }; } },
    readInstalledVersion: async exe => { events.push(`version ${exe}`); return s.readBack === undefined ? published : s.readBack; },
    runtime: {
      findLive: async () => (answers.length > 1 ? answers.shift()! : answers[0] ?? null),
      runtimeImage: () => s.image ?? INSTALL.ocxExe,
      requestRestart: async (target, version) => { events.push(`restart ${target.pid} ${version}`); return { accepted: true }; },
      desktopSupervisor: () => null,
      drainRuntime: async () => { events.push("drain"); return { ok: true }; },
      now: () => clock,
      wait: async ms => { clock += ms; },
    },
    log: () => {},
  };
  return { deps, events, fireInstallerDeadline: () => fireInstallerDeadline?.() };
}

describe("ocx update --desktop", () => {
  test("downloads, verifies twice, installs, reads back and replaces the old runtime", async () => {
    const h = harness();
    const result = await runHeadlessDesktopUpdate({ check: false }, h.deps);
    expect(result).toMatchObject({ outcome: "updated", exitCode: 0, installedVersion: "2.99.0", targetVersion: "2.100.3",
      runtime: { pid: 8, version: "2.100.3" }, installer: { exitCode: 0, rebootRequired: false } });
    expect(h.events).toEqual([
      `fetch ${DESKTOP_UPDATE_FEED_URL} 262144`,
      `fetch ${desktopInstallerUrl("2.100.3")} 1073741824`,
      "retire -",
      "stage",
      "write C:\\Temp\\ocx-desktop-update-1\\OpenCodex-2.100.3-windows-x64.msi",
      "move-aside",
      "msiexec C:\\Windows\\System32\\msiexec.exe /i C:\\Temp\\ocx-desktop-update-1\\OpenCodex-2.100.3-windows-x64.msi /qn /norestart /l*v C:\\Temp\\ocx-desktop-update-1\\msiexec.log",
      `retire ${MOVED}`,
      `version ${INSTALL.ocxExe}`,
      "discard C:\\Temp\\ocx-desktop-update-1 keep=",
      "restart 7 2.100.3",
    ]);
  });

  test("a bad signature, tampered staging or wrong bytes never reach msiexec", async () => {
    for (const s of [{ signature: signer().signBytes(MSI, "2.100.3") }, { tamperStaged: true }, { msi: Buffer.from("MZ not an msi") }] as Scenario[]) {
      const h = harness(s);
      const result = await runHeadlessDesktopUpdate({ check: false }, h.deps);
      expect(result).toMatchObject({ outcome: "refused", exitCode: HEADLESS_EXIT.unchanged });
      expect(h.events.some(event => event.startsWith("msiexec"))).toBe(false);
      expect(h.events.some(event => event.startsWith("restart"))).toBe(false);
    }
    // Staged bytes that fail the second verification are discarded with their directory.
    const tampered = harness({ tamperStaged: true });
    await runHeadlessDesktopUpdate({ check: false }, tampered.deps);
    expect(tampered.events.at(-1)).toBe("discard C:\\Temp\\ocx-desktop-update-1 keep=");
  });

  test("an installer failure keeps its log and changes nothing else", async () => {
    const h = harness({ installerExit: 1603 });
    const result = await runHeadlessDesktopUpdate({ check: false }, h.deps);
    expect(result).toMatchObject({ outcome: "installer-failed", exitCode: 1, installer: { exitCode: 1603, log: "C:\\Temp\\ocx-desktop-update-1\\msiexec.log" } });
    expect(h.events.at(-1)).toBe("discard C:\\Temp\\ocx-desktop-update-1 keep=C:\\Temp\\ocx-desktop-update-1\\msiexec.log");
    expect(h.events.some(event => event.startsWith("restart") || event.startsWith("version"))).toBe(false);
  });

  test("an installer past its deadline is uncertain and nothing follows it", async () => {
    const h = harness({ installerExit: "hang" });
    const work = runHeadlessDesktopUpdate({ check: false }, h.deps);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    h.fireInstallerDeadline();
    expect(await work).toMatchObject({ outcome: "installer-uncertain", exitCode: HEADLESS_EXIT.uncertain });
    expect(h.events.some(event => event.startsWith("restart") || event.startsWith("version"))).toBe(false);
  });

  test("3010 is installed; a binary still old after it needs a reboot", async () => {
    const ok = harness({ installerExit: 3010 });
    const done = await runHeadlessDesktopUpdate({ check: false }, ok.deps);
    expect(done).toMatchObject({ outcome: "updated", exitCode: 0, installer: { rebootRequired: true } });
    expect(done.message).toContain("restart");
    const pending = harness({ installerExit: 3010, readBack: "2.99.0" });
    expect(await runHeadlessDesktopUpdate({ check: false }, pending.deps)).toMatchObject({ outcome: "reboot-required", exitCode: HEADLESS_EXIT.runtimeStale });
    const mismatch = harness({ readBack: "2.99.0" });
    expect(await runHeadlessDesktopUpdate({ check: false }, mismatch.deps)).toMatchObject({ outcome: "installed-version-mismatch", exitCode: HEADLESS_EXIT.uncertain });
    expect(mismatch.events.some(event => event.startsWith("restart"))).toBe(false);
  });

  test("an old runtime still serving after the install is not success, and says how to finish", async () => {
    const h = harness({ runtime: [live(7, "2.99.0")], image: "C:\\Other\\ocx.exe" });
    const result = await runHeadlessDesktopUpdate({ check: false }, h.deps);
    expect(result).toMatchObject({ outcome: "old-runtime-serving", exitCode: HEADLESS_EXIT.runtimeStale, reason: "foreign-image", runtime: { pid: 7, version: "2.99.0" } });
    expect(result.message).toContain("still serves 2.99.0");
    expect(result.message).toContain("C:\\Other\\ocx.exe");
    expect(h.events.some(event => event.startsWith("restart"))).toBe(false);
  });

  test("no runtime before the install reports installed-stopped and starts none", async () => {
    const h = harness({ runtime: [null] });
    expect(await runHeadlessDesktopUpdate({ check: false }, h.deps)).toMatchObject({ outcome: "installed-stopped", exitCode: 0 });
    expect(h.events.some(event => event.startsWith("restart"))).toBe(false);
  });

  test("with nothing newer, an earlier install's old runtime is replaced; --check only reports it", async () => {
    const stale = [live(7, "2.99.0"), live(7, "2.99.0"), live(8, "2.100.3")];
    const check = harness({ installed: "2.100.3", runtime: [...stale] });
    const checked = await runHeadlessDesktopUpdate({ check: true }, check.deps);
    expect(checked).toMatchObject({ outcome: "old-runtime-serving", exitCode: HEADLESS_EXIT.runtimeStale });
    expect(checked.message).toContain(desktopUpdateCommand(INSTALL));
    expect(check.events).toEqual([`fetch ${DESKTOP_UPDATE_FEED_URL} 262144`]);
    const apply = harness({ installed: "2.100.3", runtime: [...stale] });
    expect(await runHeadlessDesktopUpdate({ check: false }, apply.deps)).toMatchObject({ outcome: "runtime-replaced", exitCode: 0, runtime: { pid: 8 } });
    expect(apply.events.filter(event => event.startsWith("msiexec"))).toEqual([]);
    expect(apply.events.at(-1)).toBe("restart 7 2.100.3");
  });

  test("check mode reports an available version without downloading it", async () => {
    const h = harness();
    expect(await runHeadlessDesktopUpdate({ check: true }, h.deps)).toMatchObject({ outcome: "available", exitCode: 0, targetVersion: "2.100.3" });
    expect(h.events).toEqual([`fetch ${DESKTOP_UPDATE_FEED_URL} 262144`]);
  });

  test("an older or equal published version installs nothing", async () => {
    for (const published of ["2.99.0", "2.98.0"]) {
      const h = harness({ published, runtime: [live(7, "2.99.0")] });
      expect(await runHeadlessDesktopUpdate({ check: false }, h.deps)).toMatchObject({ outcome: "up-to-date", exitCode: 0 });
      expect(h.events).toEqual([`fetch ${DESKTOP_UPDATE_FEED_URL} 262144`]);
    }
  });
});

describe("Desktop installation and stale-runtime advice", () => {
  test("only a compiled ocx.exe beside opencodex-desktop.exe on Windows is a Desktop installation", () => {
    const exists = (path: string) => path === INSTALL.desktopExe;
    expect(windowsDesktopInstall({ platform: "win32", standalone: true, execPath: INSTALL.ocxExe, exists })).toEqual(INSTALL);
    expect(windowsDesktopInstall({ platform: "darwin", standalone: true, execPath: INSTALL.ocxExe, exists })).toBeNull();
    expect(windowsDesktopInstall({ platform: "win32", standalone: false, execPath: INSTALL.ocxExe, exists })).toBeNull();
    expect(windowsDesktopInstall({ platform: "win32", standalone: true, execPath: "C:\\bun\\bun.exe", exists })).toBeNull();
    expect(windowsDesktopInstall({ platform: "win32", standalone: true, execPath: INSTALL.ocxExe, exists: () => false })).toBeNull();
  });

  test("ocx status names the installed and serving versions and the command that finishes the update", () => {
    const skew = withDesktopSkewAdvice(computeVersionSkew("2.100.3", "2.99.0"), INSTALL);
    expect(skew.warning).toBe('OpenCodex Desktop 2.100.3 is installed, but the running proxy still serves 2.99.0. '
      + 'Replace it with: "C:\\Program Files\\OpenCodex\\ocx.exe" update --desktop (or quit and reopen OpenCodex Desktop).');
    expect(skew.relation).toBe("cli-newer");
    const other = computeVersionSkew("2.100.3", "2.101.0");
    expect(withDesktopSkewAdvice(other, INSTALL)).toBe(other);
    const plain = computeVersionSkew("2.100.3", "2.99.0");
    expect(withDesktopSkewAdvice(plain, null)).toBe(plain);
  });

  test("argument and version parsing are exact", () => {
    expect(parseHeadlessArgs(["--desktop"])).toEqual({ ok: true, check: false, json: false });
    expect(parseHeadlessArgs(["--desktop", "--check", "--json"])).toEqual({ ok: true, check: true, json: true });
    for (const args of [[], ["--check"], ["--desktop", "--desktop"], ["--desktop", "--tag", "preview"], ["--desktop", "--yes"]]) {
      expect(parseHeadlessArgs(args)).toEqual({ ok: false });
    }
    expect(parseVersionOutput("opencodex 2.100.3\r\n")).toBe("2.100.3");
    expect(parseVersionOutput("warning\nopencodex 2.100.3\n")).toBe("2.100.3");
    expect(parseVersionOutput("2.100.3")).toBeNull();
  });
});

test("a runtime newer than the installation is not called stale", async () => {
  const h = harness({ installed: "2.100.3", runtime: [live(7, "2.101.0")] });
  expect(await runHeadlessDesktopUpdate({ check: false }, h.deps)).toMatchObject({ outcome: "up-to-date", exitCode: 0, runtime: { version: "2.101.0" } });
  expect(h.events.some(event => event.startsWith("restart") || event === "drain")).toBe(false);
});

describe("the updater's own image and Windows Installer", () => {
  test("the running ocx.exe is moved aside before msiexec and restored when the install rolls back", async () => {
    const h = harness({ installerExit: 1603 });
    const result = await runHeadlessDesktopUpdate({ check: false }, h.deps);
    expect(result.outcome).toBe("installer-failed");
    const order = h.events.filter(event => /^(move-aside|msiexec|restore|retire)/.test(event)).map(event => event.split(" ")[0]);
    expect(order).toEqual(["retire", "move-aside", "msiexec", "restore"]);
    expect(result.message).not.toContain("previous ocx.exe");
    const blocked = harness({ installerExit: 1603, restoreBlocked: true });
    expect((await runHeadlessDesktopUpdate({ check: false }, blocked.deps)).message).toContain(`The previous ocx.exe is at ${MOVED}.`);
  });

  test("an image that cannot be moved aside refuses before msiexec", async () => {
    const h = harness({ moveFails: true });
    const result = await runHeadlessDesktopUpdate({ check: false }, h.deps);
    expect(result).toMatchObject({ outcome: "failed", exitCode: HEADLESS_EXIT.unchanged });
    expect(result.message).toContain("elevated");
    expect(h.events.some(event => event.startsWith("msiexec") || event.startsWith("restore"))).toBe(false);
  });

  test("an installer that may still be running keeps the moved image where it is", async () => {
    const h = harness({ installerExit: "hang" });
    const work = runHeadlessDesktopUpdate({ check: false }, h.deps);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    h.fireInstallerDeadline();
    const result = await work;
    expect(result.outcome).toBe("installer-uncertain");
    expect(result.message).toContain(MOVED);
    expect(h.events.some(event => event.startsWith("restore"))).toBe(false);
  });
});
