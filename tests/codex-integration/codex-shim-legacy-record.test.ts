/**
 * The legacy Codex shim record (codex-shim.json without schema/mode) names the launcher files
 * that Windows uninstall, auto-restore and install refresh act on. Those paths must match the
 * layout an install writes before anything is renamed, deleted or rewritten. The validator is
 * pure and runs on every OS; the uninstall cases run the Windows code path against the host
 * filesystem by overriding process.platform, as codex-shim-windows-revision.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import {
  autoRestoreCodexShim,
  diagnoseCodexShim,
  installCodexShim,
  setLegacyShimUninstallStepHookForTests,
  uninstallCodexShim,
} from "../../src/codex/shim";
import {
  checkLegacyShimRecord,
  legacyShimBackupPath,
  legacyShimFilesProblem,
  resolveLegacyShimDirectory,
  setLegacyShimMutationGuard,
  validateLegacyWindowsShimRecord,
} from "../../src/codex/shim-legacy-record";
import { buildWindowsCodexShim } from "../../src/codex/shim-templates";
import { stableShimPathProbe } from "../../src/codex/shim-fingerprint";
import { refreshObsoleteWindowsShim } from "../../src/codex/shim-windows-refresh";
import { writeShim } from "../../src/codex/shim-wrapper-write";
import { setUninstallElevationProbeForTests, uninstallRunsElevated } from "../../src/lib/config-ownership-removal";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const DIR = "C:\\nodejs\\npm-global";
// Raw concatenation: the validator must see unnormalized spellings exactly as a record holds them.
const at = (name: string, dir = DIR) => `${dir}\\${name}`;
const inPlace = (name: string, dir = DIR) => ({ wrapperPath: at(name, dir), originalPath: at(name, dir), backupPath: legacyShimBackupPath(at(name, dir), win32) });

describe("legacy Windows shim record layout (every OS)", () => {
  const valid = (value: unknown) => validateLegacyWindowsShimRecord(value, win32);

  test("accepts every layout a Windows install has written", () => {
    const files = [inPlace("codex.cmd"), inPlace("codex.ps1"), inPlace("codex")];
    expect(files[0]!.backupPath).toBe(at("codex.opencodex-real.cmd"));
    expect(valid({ platform: "win32", ...files[0], wrappers: files })).toMatchObject({ ok: true, directory: DIR });
    expect(valid({ platform: "win32", ...inPlace("codex.cmd") }).ok).toBe(true);
    // The first installs wrote codex.cmd beside the original launcher, with or without a list.
    const sideBySide = { wrapperPath: at("codex.cmd"), originalPath: at("codex.EXE"), backupPath: at("codex.opencodex-real.EXE") };
    expect(valid({ platform: "win32", ...sideBySide }).ok).toBe(true);
    expect(valid({ platform: "win32", ...sideBySide, wrappers: [sideBySide] }).ok).toBe(true);
    expect(valid({ platform: "win32", ...files[0], realPath: files[0]!.backupPath, preserveOnly: false }).ok).toBe(true);
  });

  const refusals: Array<[string, unknown]> = [
    ["a backup in another directory", { platform: "win32", ...inPlace("codex.cmd"), backupPath: at("codex.opencodex-real.cmd", "C:\\Windows\\System32") }],
    ["a backup with another name", { platform: "win32", ...inPlace("codex.cmd"), backupPath: at("codex.cmd.opencodex-real") }],
    ["an original in another directory", { platform: "win32", ...inPlace("codex.cmd"), originalPath: at("codex.cmd", "C:\\Tools") }],
    ["a wrapper in another directory", { platform: "win32", ...inPlace("codex.cmd"), wrapperPath: at("codex.cmd", "C:\\Tools") }],
    ["a launcher with another name", { platform: "win32", ...inPlace("notes.cmd") }],
    ["a side-by-side original with another name", { platform: "win32", wrapperPath: at("codex.cmd"), originalPath: at("other.exe"), backupPath: at("other.opencodex-real.exe") }],
    ["a side-by-side entry in a list", { platform: "win32", wrappers: [{ wrapperPath: at("codex.cmd"), originalPath: at("codex.exe"), backupPath: at("codex.opencodex-real.exe") }, inPlace("codex.ps1")] }],
    ["launchers in two directories", { platform: "win32", wrappers: [inPlace("codex.cmd"), inPlace("codex.ps1", "C:\\Tools")] }],
    ["launchers in directories that differ only by case", { platform: "win32", wrappers: [inPlace("codex.cmd"), inPlace("codex.ps1", DIR.toUpperCase())] }],
    ["a launcher listed twice", { platform: "win32", wrappers: [inPlace("codex.cmd"), inPlace("CODEX.cmd")] }],
    ["too many launchers", { platform: "win32", wrappers: [inPlace("codex.cmd"), inPlace("codex.ps1"), inPlace("codex"), inPlace("codex.cmd")] }],
    ["an empty launcher list", { platform: "win32", wrappers: [] }],
    ["a summary that disagrees with the list", { platform: "win32", ...inPlace("codex.ps1"), wrappers: [inPlace("codex.cmd")] }],
    ["a relative path", { platform: "win32", wrapperPath: "npm\\codex.cmd", originalPath: "npm\\codex.cmd", backupPath: "npm\\codex.opencodex-real.cmd" }],
    ["a network path", { platform: "win32", ...inPlace("codex.cmd", "\\\\server\\share\\npm") }],
    ["a parent segment", { platform: "win32", ...inPlace("codex.cmd", "C:\\nodejs\\..\\other") }],
    ["a trailing-dot segment", { platform: "win32", ...inPlace("codex.cmd", "C:\\nodejs\\npm.") }],
    ["a stream name", { platform: "win32", ...inPlace("codex.cmd", "C:\\nodejs\\npm:stream") }],
    ["forward slashes", { platform: "win32", ...inPlace("codex.cmd", "C:/nodejs/npm-global") }],
    ["a control character", { platform: "win32", ...inPlace("codex.cmd", "C:\\nodejs\\np\nm") }],
    ["a missing backup path", { platform: "win32", wrapperPath: at("codex.cmd"), originalPath: at("codex.cmd") }],
    ["a non-string path", { platform: "win32", ...inPlace("codex.cmd"), originalPath: 7 }],
    ["a backing file elsewhere", { platform: "win32", ...inPlace("codex.cmd"), realPath: "C:\\Windows\\System32\\cmd.exe" }],
    ["a preserve-only entry", { platform: "win32", ...inPlace("codex.cmd"), preserveOnly: true }],
    ["another platform", { platform: "linux", ...inPlace("codex.cmd") }],
    ["a schema record", { platform: "win32", schema: 2, ...inPlace("codex.cmd") }],
    ["a non-object", ["codex.cmd"]],
    ["null", null],
  ];
  for (const [name, record] of refusals) {
    test("refuses " + name, () => {
      const verdict = valid(record);
      expect(verdict.ok).toBe(false);
    });
  }
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const previousHome = process.env.OPENCODEX_HOME;
const linkType = process.platform === "win32" ? "junction" : "dir";
const SHIM = (backup: string) => buildWindowsCodexShim(backup, "C:\\bun.exe", "C:\\cli.ts", "process");
const NATIVE = "@echo off\r\nrem native codex launcher\r\n";
let root = "";
let home = "";
let bin = "";
let elsewhere = "";

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "ocx-legacy-shim-record-"));
  home = join(root, "ocx");
  bin = join(root, "npm");
  elsewhere = join(root, "elsewhere");
  for (const dir of [home, bin, elsewhere]) fs.mkdirSync(dir);
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  setLegacyShimUninstallStepHookForTests(null);
  setUninstallElevationProbeForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

function seed(dir: string, record?: (file: { wrapperPath: string; originalPath: string; backupPath: string }) => Record<string, unknown>) {
  const wrapperPath = join(dir, "codex.cmd");
  const backupPath = legacyShimBackupPath(wrapperPath);
  fs.writeFileSync(wrapperPath, SHIM(backupPath));
  fs.writeFileSync(backupPath, NATIVE);
  const file = { wrapperPath, originalPath: wrapperPath, backupPath };
  const statePath = join(home, "codex-shim.json");
  fs.writeFileSync(statePath, JSON.stringify(record ? record(file) : { platform: "win32", ...file, wrappers: [file] }));
  return { ...file, statePath };
}

function asWindows(): void {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
}

/** Every file under root with its bytes, so a refusal can prove nothing moved. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) out[path] = "link:" + fs.readlinkSync(path);
      else if (entry.isDirectory()) walk(path);
      else out[path] = fs.readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}

describe("Windows shim uninstall acts only on a validated record", () => {
  test("a normal record restores the original launcher and removes the record", () => {
    const seeded = seed(bin);
    asWindows();
    const result = uninstallCodexShim();
    expect(result).toMatchObject({ removed: true });
    expect(result.refused).toBeUndefined();
    expect(fs.readFileSync(seeded.wrapperPath, "utf8")).toBe(NATIVE);
    expect(fs.existsSync(seeded.backupPath)).toBe(false);
    expect(fs.existsSync(seeded.statePath)).toBe(false);
  });

  test("a backup recorded in another directory is refused and nothing moves", () => {
    const decoy = join(elsewhere, "codex.opencodex-real.cmd");
    fs.writeFileSync(decoy, "unrelated bytes");
    seed(bin, file => ({ platform: "win32", ...file, backupPath: decoy }));
    fs.unlinkSync(join(bin, "codex.cmd"));
    const before = snapshot();
    asWindows();
    const result = uninstallCodexShim();
    expect(result).toMatchObject({ removed: false, refused: true });
    expect(result.message).toContain("needs manual restore");
    expect(snapshot()).toEqual(before);
  });

  test("an original recorded in another directory is refused and nothing moves", () => {
    const seeded = seed(bin, file => ({ platform: "win32", ...file, originalPath: join(elsewhere, "codex.cmd") }));
    fs.unlinkSync(seeded.wrapperPath);
    const before = snapshot();
    asWindows();
    expect(uninstallCodexShim()).toMatchObject({ removed: false, refused: true });
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(join(elsewhere, "codex.cmd"))).toBe(false);
  });

  test("a wrapper recorded in another directory is refused and that file is kept", () => {
    const foreign = join(elsewhere, "codex.cmd");
    fs.writeFileSync(foreign, SHIM(join(elsewhere, "x")));
    seed(bin, file => ({ platform: "win32", ...file, wrapperPath: foreign }));
    const before = snapshot();
    asWindows();
    expect(uninstallCodexShim()).toMatchObject({ removed: false, refused: true });
    expect(snapshot()).toEqual(before);
  });

  test("a consistent record naming a file that is not a launcher is refused and the file is kept", () => {
    const other = join(elsewhere, "notes.cmd");
    fs.writeFileSync(other, SHIM(join(elsewhere, "x")));
    fs.writeFileSync(join(home, "codex-shim.json"), JSON.stringify({ platform: "win32", wrapperPath: other, originalPath: other, backupPath: legacyShimBackupPath(other) }));
    const before = snapshot();
    asWindows();
    expect(uninstallCodexShim()).toMatchObject({ removed: false, refused: true });
    expect(snapshot()).toEqual(before);
  });

  test("malformed and partial records are refused and kept", () => {
    const statePath = join(home, "codex-shim.json");
    for (const body of ["{broken", JSON.stringify({ platform: "win32", wrapperPath: join(bin, "codex.cmd") }), JSON.stringify({ platform: "win32", wrappers: "codex.cmd" })]) {
      fs.writeFileSync(statePath, body);
      const before = snapshot();
      asWindows();
      expect(uninstallCodexShim()).toMatchObject({ removed: false, refused: true });
      expect(snapshot()).toEqual(before);
      Object.defineProperty(process, "platform", platform);
    }
  });

  test("a backup that is a link or itself a shim is refused and nothing moves", () => {
    const seeded = seed(bin);
    fs.unlinkSync(seeded.wrapperPath);
    fs.writeFileSync(seeded.backupPath, SHIM(seeded.backupPath));
    let before = snapshot();
    asWindows();
    expect(uninstallCodexShim()).toMatchObject({ removed: false, refused: true });
    expect(snapshot()).toEqual(before);
    Object.defineProperty(process, "platform", platform);
    if (process.platform !== "win32") {
      fs.unlinkSync(seeded.backupPath);
      fs.writeFileSync(join(elsewhere, "target"), "unrelated bytes");
      fs.symlinkSync(join(elsewhere, "target"), seeded.backupPath);
      before = snapshot();
      asWindows();
      expect(uninstallCodexShim()).toMatchObject({ removed: false, refused: true });
      expect(snapshot()).toEqual(before);
    }
  });

  test("a record from another platform changes no launcher file", () => {
    const seeded = seed(bin, file => ({ platform: "linux", ...file }));
    const launchers = [seeded.wrapperPath, seeded.backupPath].map(path => fs.readFileSync(path, "utf8"));
    asWindows();
    const result = uninstallCodexShim();
    expect(result.refused).toBeUndefined();
    expect([seeded.wrapperPath, seeded.backupPath].map(path => fs.readFileSync(path, "utf8"))).toEqual(launchers);
  });

  test("an unelevated run validates the record the same way", () => {
    setUninstallElevationProbeForTests(() => false);
    expect(uninstallRunsElevated()).toBe(false);
    const decoy = join(elsewhere, "codex.opencodex-real.cmd");
    fs.writeFileSync(decoy, "unrelated bytes");
    seed(bin, file => ({ platform: "win32", ...file, backupPath: decoy }));
    fs.unlinkSync(join(bin, "codex.cmd"));
    const before = snapshot();
    asWindows();
    expect(uninstallCodexShim()).toMatchObject({ removed: false, refused: true });
    expect(snapshot()).toEqual(before);
  });

  test("a linked launcher directory is resolved and the restore happens in its target", () => {
    const link = join(root, "linked-npm");
    fs.symlinkSync(bin, link, linkType);
    const seeded = seed(link);
    asWindows();
    expect(uninstallCodexShim()).toMatchObject({ removed: true });
    expect(fs.readFileSync(join(bin, "codex.cmd"), "utf8")).toBe(NATIVE);
    expect(fs.existsSync(join(bin, "codex.opencodex-real.cmd"))).toBe(false);
    expect(fs.existsSync(seeded.statePath)).toBe(false);
  });

  test("a linked launcher directory retargeted after validation is refused and nothing moves", () => {
    const link = join(root, "linked-npm");
    fs.symlinkSync(bin, link, linkType);
    seed(link);
    seed(elsewhere);
    fs.writeFileSync(join(home, "codex-shim.json"), JSON.stringify({ platform: "win32", ...{ wrapperPath: join(link, "codex.cmd"), originalPath: join(link, "codex.cmd"), backupPath: join(link, "codex.opencodex-real.cmd") } }));
    let retargeted = false;
    setLegacyShimUninstallStepHookForTests(() => {
      if (retargeted) return;
      retargeted = true;
      fs.rmSync(link, { recursive: false, force: true });
      fs.symlinkSync(elsewhere, link, linkType);
    });
    asWindows();
    const result = uninstallCodexShim();
    Object.defineProperty(process, "platform", platform);
    expect(retargeted).toBe(true);
    expect(result).toMatchObject({ removed: false, refused: true });
    for (const dir of [bin, elsewhere]) {
      expect(fs.readFileSync(join(dir, "codex.cmd"), "utf8")).toContain("opencodex codex autostart shim");
      expect(fs.readFileSync(join(dir, "codex.opencodex-real.cmd"), "utf8")).toBe(NATIVE);
    }
    expect(fs.existsSync(join(home, "codex-shim.json"))).toBe(true);
  });

  test("a missing launcher directory has nothing to restore and removes the record", () => {
    const seeded = seed(bin);
    removeTreeWithRetry(bin);
    asWindows();
    expect(uninstallCodexShim()).toMatchObject({ removed: true });
    expect(fs.existsSync(seeded.statePath)).toBe(false);
  });

  test("a launcher directory replaced at the same path during removal is refused", () => {
    const seeded = seed(bin);
    let replaced = false;
    setLegacyShimUninstallStepHookForTests(() => {
      if (replaced) return;
      replaced = true;
      fs.renameSync(bin, join(root, "npm-aside"));
      fs.mkdirSync(bin);
      for (const name of fs.readdirSync(join(root, "npm-aside"))) fs.copyFileSync(join(root, "npm-aside", name), join(bin, name));
    });
    asWindows();
    const result = uninstallCodexShim();
    Object.defineProperty(process, "platform", platform);
    expect(replaced).toBe(true);
    expect(result).toMatchObject({ removed: false, refused: true });
    for (const dir of [bin, join(root, "npm-aside")]) {
      expect(fs.readFileSync(join(dir, "codex.cmd"), "utf8")).toContain("opencodex codex autostart shim");
      expect(fs.readFileSync(join(dir, "codex.opencodex-real.cmd"), "utf8")).toBe(NATIVE);
    }
    expect(fs.existsSync(seeded.statePath)).toBe(true);
  });
});

describe("other Windows shim consumers refuse an invalid record", () => {
  test("auto-restore, install and diagnostics report manual restore and change nothing", () => {
    const decoy = join(elsewhere, "codex.opencodex-real.cmd");
    fs.writeFileSync(decoy, "unrelated bytes");
    seed(bin, file => ({ platform: "win32", ...file, backupPath: decoy }));
    fs.writeFileSync(join(bin, "codex.cmd"), NATIVE);
    const before = snapshot();
    asWindows();
    const restore = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} });
    expect(restore.status).toBe("ineligible");
    expect("message" in restore ? restore.message : "").toContain("needs manual restore");
    expect(installCodexShim()).toMatchObject({ installed: false, refused: true });
    expect(diagnoseCodexShim()).toMatchObject({ installed: true, healthy: false });
    expect(diagnoseCodexShim().summary).toContain("needs manual restore");
    expect(snapshot()).toEqual(before);
  });

  test("explicit install over an unreadable record is refused and keeps the record", () => {
    const statePath = join(home, "codex-shim.json");
    fs.writeFileSync(statePath, "{broken");
    const before = snapshot();
    asWindows();
    const result = installCodexShim();
    expect(result).toMatchObject({ installed: false, refused: true });
    expect(result.message).toContain("needs manual restore");
    expect(snapshot()).toEqual(before);
  });

  test("a fresh install refuses an empty launcher instead of recording an unusable backup", () => {
    const launcher = join(bin, "codex.cmd");
    fs.writeFileSync(launcher, "");
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    const before = snapshot();
    asWindows();
    try {
      const result = installCodexShim({ assertRuntimeWritable: () => {} });
      expect(result).toMatchObject({ installed: false, refused: true });
      expect(result.message).toContain("empty");
    } finally {
      Object.defineProperty(process, "platform", platform);
      process.env.PATH = previousPath;
    }
    expect(snapshot()).toEqual(before);
  });

  test("auto-restore reports a record that became unreadable under its lock", () => {
    const seeded = seed(bin);
    fs.writeFileSync(seeded.wrapperPath, NATIVE.replace("native", "updated"));
    asWindows();
    const result = autoRestoreCodexShim({
      enabled: () => true, stabilitySleep: () => {}, assertRuntimeWritable: () => {},
      afterRestoreLockAcquired: () => fs.writeFileSync(seeded.statePath, "{broken"),
    });
    expect(result.status).toBe("ineligible");
    expect("message" in result ? result.message : "").toContain("needs manual restore");
    expect(fs.readFileSync(seeded.wrapperPath, "utf8")).toBe(NATIVE.replace("native", "updated"));
    expect(fs.readFileSync(seeded.backupPath, "utf8")).toBe(NATIVE);
  });

  test.skipIf(process.platform === "win32")("a side-by-side launcher that is a hard link to another file is never written through", () => {
    const victim = join(elsewhere, "victim.cmd");
    fs.writeFileSync(victim, SHIM(join(elsewhere, "x")));
    const wrapperPath = join(bin, "codex.cmd"), originalPath = join(bin, "codex.exe");
    fs.linkSync(victim, wrapperPath);
    fs.writeFileSync(originalPath, NATIVE);
    fs.writeFileSync(join(home, "codex-shim.json"), JSON.stringify({ platform: "win32", wrapperPath, originalPath, backupPath: legacyShimBackupPath(originalPath) }));
    const before = snapshot();
    asWindows();
    expect(installCodexShim()).toMatchObject({ installed: false, refused: true });
    expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} }).status).toBe("ineligible");
    expect(snapshot()).toEqual(before);
    // The writer itself refuses a shared or linked wrapper path even without a record.
    expect(() => writeShim(wrapperPath, originalPath)).toThrow("not a private regular file");
    expect(fs.readFileSync(victim, "utf8")).toBe(before[victim]!);
  });
});

describe("mutations after validation stay in the validated directory", () => {
  test("a guarded refresh or write refuses once the recorded directory resolves elsewhere", () => {
    const link = join(root, "linked-npm");
    fs.symlinkSync(bin, link, linkType);
    seed(elsewhere);
    const seeded = seed(link);
    const checked = checkLegacyShimRecord(JSON.parse(fs.readFileSync(seeded.statePath, "utf8")));
    if (!checked.ok) throw new Error(checked.reason);
    const observed = stableShimPathProbe(seeded.wrapperPath)!;
    const release = setLegacyShimMutationGuard(checked);
    try {
      fs.rmSync(link, { force: true });
      fs.symlinkSync(elsewhere, link, linkType);
      const before = snapshot();
      asWindows();
      // The refresh either refuses outright or reports that nothing was published; it never moves a file.
      let published: unknown;
      try { published = refreshObsoleteWindowsShim(seeded.wrapperPath, observed, () => "current wrapper"); } catch (error) { published = error; }
      expect(published).not.toBe(true);
      expect(() => writeShim(join(link, "codex.ps1"), seeded.backupPath)).toThrow("changed after validation");
      Object.defineProperty(process, "platform", platform);
      expect(snapshot()).toEqual(before);
    } finally {
      release();
    }
  });

  test("a directory retargeted between two refresh steps stops the later steps", () => {
    const link = join(root, "linked-npm");
    fs.symlinkSync(bin, link, linkType);
    seed(elsewhere);
    const seeded = seed(link);
    const checked = checkLegacyShimRecord(JSON.parse(fs.readFileSync(seeded.statePath, "utf8")));
    if (!checked.ok) throw new Error(checked.reason);
    const observed = stableShimPathProbe(seeded.wrapperPath)!;
    const decoy = Object.fromEntries(fs.readdirSync(elsewhere).map(name => [name, fs.readFileSync(join(elsewhere, name), "utf8")]));
    const rename = fs.renameSync;
    let retargeted = false;
    const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      rename(from, to);
      if (!retargeted) { retargeted = true; fs.rmSync(link, { force: true }); fs.symlinkSync(elsewhere, link, linkType); }
    }) as typeof fs.renameSync);
    const release = setLegacyShimMutationGuard(checked);
    let published: unknown;
    try {
      asWindows();
      try { published = refreshObsoleteWindowsShim(seeded.wrapperPath, observed, () => "current wrapper"); } catch (error) { published = error; }
    } finally {
      Object.defineProperty(process, "platform", platform);
      release();
      spy.mockRestore();
    }
    expect(retargeted).toBe(true);
    expect(published).not.toBe(true);
    expect(Object.fromEntries(fs.readdirSync(elsewhere).map(name => [name, fs.readFileSync(join(elsewhere, name), "utf8")]))).toEqual(decoy);
  });

  test("the Windows shim modules rename, unlink and link only through the guarded calls", () => {
    for (const file of ["src/codex/shim.ts", "src/codex/shim-windows-refresh.ts"]) {
      const source = fs.readFileSync(repoPath(file), "utf8");
      const fsImport = source.match(/import \{([^}]*)\} from "node:fs";/)?.[1] ?? "";
      for (const call of ["renameSync", "unlinkSync", "linkSync", "rmSync"]) expect(fsImport.split(",").map(name => name.trim())).not.toContain(call);
      expect(source).not.toMatch(/\bfs\.(renameSync|unlinkSync|linkSync|rmSync)\(/);
    }
  });
});

describe("on-disk checks (every OS, host filesystem)", () => {
  test("the resolved directory chain holds only real directories", () => {
    const link = join(root, "linked-npm");
    fs.symlinkSync(bin, link, linkType);
    const resolved = resolveLegacyShimDirectory(link);
    expect(resolved).toMatchObject({ ok: true, resolved: fs.realpathSync.native(bin) });
    expect(resolveLegacyShimDirectory(join(root, "missing"))).toEqual({ ok: true, resolved: null, identity: null });
    // A resolver that reports a link inside the resolved chain is refused.
    const linked = resolveLegacyShimDirectory(bin, undefined, {
      lstat: path => { const entry = fs.lstatSync(path); return path === dirname(fs.realpathSync.native(bin)) ? { ...entry, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true, size: 0 } : entry; },
    });
    expect(linked.ok).toBe(false);
  });

  test("launchers must be regular files and a backup must be a non-empty non-shim file", () => {
    const seeded = seed(bin);
    const files = [{ wrapperPath: seeded.wrapperPath, originalPath: seeded.originalPath, backupPath: seeded.backupPath }];
    const dir = fs.realpathSync.native(bin);
    expect(legacyShimFilesProblem(files, dir)).toBeNull();
    fs.linkSync(seeded.wrapperPath, join(elsewhere, "shared.cmd"));
    expect(legacyShimFilesProblem(files, dir)).toContain("shares its file");
    fs.unlinkSync(join(elsewhere, "shared.cmd"));
    fs.writeFileSync(seeded.backupPath, "");
    expect(legacyShimFilesProblem(files, dir)).toContain("backup");
    fs.unlinkSync(seeded.backupPath);
    expect(legacyShimFilesProblem(files, dir)).toBeNull();
    fs.unlinkSync(seeded.wrapperPath);
    fs.mkdirSync(seeded.wrapperPath);
    expect(legacyShimFilesProblem(files, dir)).toContain("launcher");
  });

  test.skipIf(process.platform !== "win32")("Windows only (NTFS junctions): a junction is resolved and flagged as a link", () => {
    const junction = join(root, "junction-npm");
    fs.symlinkSync(bin, junction, "junction");
    expect(fs.lstatSync(junction).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync.native(junction).toLowerCase()).toBe(fs.realpathSync.native(bin).toLowerCase());
    const seeded = seed(junction);
    const checked = checkLegacyShimRecord(JSON.parse(fs.readFileSync(seeded.statePath, "utf8")));
    expect(checked).toMatchObject({ ok: true, resolvedDirectory: fs.realpathSync.native(bin) });
  });
});

describe("ocx uninstall keeps the config when the shim needs manual restore", () => {
  test("a refused shim step counts as a failure before config removal", () => {
    const cli = fs.readFileSync(repoPath("src/cli/index.ts"), "utf8");
    const body = cli.slice(cli.indexOf("async function handleUninstall()"));
    const shimStep = body.indexOf("const r = await uninstallCodexShimAsync();");
    const refusal = body.indexOf('if (r.refused) {', shimStep);
    const failure = body.indexOf('failures.push("Codex autostart shim removed");', refusal);
    const removal = body.indexOf("if (failures.length === 0) {", shimStep);
    expect(shimStep).toBeGreaterThan(0);
    expect(refusal).toBeGreaterThan(shimStep);
    expect(failure).toBeGreaterThan(refusal);
    expect(removal).toBeGreaterThan(failure);
  });
});
