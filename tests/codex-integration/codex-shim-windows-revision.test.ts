/**
 * An installed Windows CMD or PowerShell wrapper from before the bypass-token fix loads the
 * service token before honoring OCX_SHIM_BYPASS. Those wrappers carry the shim marker but no
 * Windows revision, so explicit install and auto-restore must rewrite them in place over the same
 * backing launcher, never report them healthy or "already installed". No Windows shell runs here:
 * process.platform is overridden and the wrappers are only written and read.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { autoRestoreCodexShim, installCodexShim } from "../../src/codex/shim";
import { stableShimPathProbe } from "../../src/codex/shim-fingerprint";
import { refreshObsoleteWindowsShim } from "../../src/codex/shim-windows-refresh";
import { buildWindowsCodexShim, buildWindowsPowerShellCodexShim, WINDOWS_SHIM_REVISION_MARKER } from "../../src/codex/shim-templates";
import { isolateCodexShimEnvironment } from "../helpers/codex-shim-install-fixture";
import { removeTreeWithRetry } from "../helpers/remove-tree";

isolateCodexShimEnvironment();

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const previousHome = process.env.OPENCODEX_HOME;
let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "ocx-win-shim-revision-"));
  process.env.OPENCODEX_HOME = dir;
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(dir);
});

/** The pre-fix template: no Windows revision line, and the token load ahead of the bypass check. */
function previousTemplate(flavor: "cmd" | "ps1", backing: string): string {
  const current = flavor === "cmd"
    ? buildWindowsCodexShim(backing, "C:\\bun.exe", "C:\\cli.ts", "process")
    : buildWindowsPowerShellCodexShim(backing, "C:\\bun.exe", "C:\\cli.ts", "process");
  const lines = current.split("\n").filter(line => !line.includes(WINDOWS_SHIM_REVISION_MARKER));
  if (flavor === "cmd") {
    const bypass = lines.findIndex(line => line.includes('if not "%OCX_SHIM_BYPASS%"=="" goto run_codex'));
    const load = lines.findIndex(line => line.includes("set /p OPENCODEX_API_AUTH_TOKEN="));
    [lines[bypass], lines[load]] = [lines[load]!, lines[bypass]!];
    return lines.join("\n");
  }
  return lines.join("\n").replace("-not $env:OCX_SHIM_BYPASS -and ", "");
}

function seed(flavor: "cmd" | "ps1"): { wrapper: string; backing: string; previous: string } {
  const wrapper = join(dir, `codex.${flavor}`), backing = `${wrapper}.opencodex-real`;
  const previous = previousTemplate(flavor, backing);
  fs.writeFileSync(wrapper, previous);
  fs.writeFileSync(backing, "native fixture launcher");
  fs.writeFileSync(join(dir, "codex-shim.json"), JSON.stringify({ platform: "win32", originalPath: wrapper, wrapperPath: wrapper, backupPath: backing }));
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  return { wrapper, backing, previous };
}

function expectCurrent(flavor: "cmd" | "ps1", wrapper: string, backing: string): void {
  const text = fs.readFileSync(wrapper, "utf8");
  expect(text).toContain(WINDOWS_SHIM_REVISION_MARKER);
  if (flavor === "cmd") {
    expect(text.indexOf("set /p OPENCODEX_API_AUTH_TOKEN=")).toBeGreaterThan(text.indexOf('if not "%OCX_SHIM_BYPASS%"=="" goto run_codex'));
  } else {
    expect(text).toContain("-not $env:OCX_SHIM_BYPASS -and -not $env:OPENCODEX_API_AUTH_TOKEN");
  }
  expect(fs.readFileSync(backing, "utf8")).toBe("native fixture launcher");
}

describe("obsolete Windows shims are upgraded", () => {
  for (const flavor of ["cmd", "ps1"] as const) {
    test(`explicit install rewrites a previous ${flavor} wrapper`, () => {
      const { wrapper, backing, previous } = seed(flavor);
      const result = installCodexShim();
      expect(result.installed).toBe(true);
      expect(fs.readFileSync(wrapper, "utf8")).not.toBe(previous);
      expectCurrent(flavor, wrapper, backing);
      // Now current: a second install is a no-op.
      expect(installCodexShim().installed).toBe(false);
    });

    test(`auto-restore rewrites a previous ${flavor} wrapper instead of reporting it healthy`, () => {
      const { wrapper, backing } = seed(flavor);
      expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} }).status).toBe("restored");
      expectCurrent(flavor, wrapper, backing);
      expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} }).status).toBe("healthy");
    });
  }
});

describe("obsolete Windows refresh transaction never clobbers a concurrent replacement", () => {
  const leftovers = (wrapper: string) => fs.readdirSync(dir).filter(name => name.startsWith(`${basename(wrapper)}.ocx-`));

  test("publishes the rendered wrapper and leaves no staging files", () => {
    const wrapper = join(dir, "codex.cmd");
    fs.writeFileSync(wrapper, "@echo off\r\nrem obsolete\r\n");
    const observed = stableShimPathProbe(wrapper)!;
    expect(refreshObsoleteWindowsShim(wrapper, observed, () => "current wrapper")).toBe(true);
    expect(fs.readFileSync(wrapper, "utf8")).toBe("current wrapper");
    expect(leftovers(wrapper)).toEqual([]);
  });

  test("a replacement published after the probe is put back untouched and nothing is rendered", () => {
    const wrapper = join(dir, "codex.cmd");
    fs.writeFileSync(wrapper, "@echo off\r\nrem obsolete\r\n");
    const observed = stableShimPathProbe(wrapper)!;
    fs.unlinkSync(wrapper);
    fs.writeFileSync(wrapper, "replacement native launcher from a concurrent installer");
    let rendered = false;
    expect(refreshObsoleteWindowsShim(wrapper, observed, () => { rendered = true; return "current wrapper"; })).toBe(false);
    expect(rendered).toBe(false);
    expect(fs.readFileSync(wrapper, "utf8")).toBe("replacement native launcher from a concurrent installer");
    expect(leftovers(wrapper)).toEqual([]);
  });

  test("a launcher published while staging keeps the path; only our obsolete copy is discarded", () => {
    const wrapper = join(dir, "codex.ps1");
    fs.writeFileSync(wrapper, "# obsolete");
    const observed = stableShimPathProbe(wrapper)!;
    expect(refreshObsoleteWindowsShim(wrapper, observed, () => {
      fs.writeFileSync(wrapper, "replacement published mid-refresh");
      return "current wrapper";
    })).toBe(false);
    expect(fs.readFileSync(wrapper, "utf8")).toBe("replacement published mid-refresh");
    expect(leftovers(wrapper)).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a link planted at the stage path is never written through", () => {
    const wrapper = join(dir, "codex.cmd");
    fs.writeFileSync(wrapper, "@echo off\r\nrem obsolete\r\n");
    const victim = join(dir, "unrelated-launcher");
    fs.writeFileSync(victim, "unrelated launcher bytes");
    const staged = `${wrapper}.ocx-refresh-planted.cmd`;
    fs.symlinkSync(victim, staged);
    const observed = stableShimPathProbe(wrapper)!;
    expect(refreshObsoleteWindowsShim(wrapper, observed, () => "current wrapper", staged)).toBe(false);
    expect(fs.readFileSync(victim, "utf8")).toBe("unrelated launcher bytes");
    expect(fs.lstatSync(staged).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(wrapper, "utf8")).toBe("@echo off\r\nrem obsolete\r\n");
  });

  test("a partial sibling upgrade resumes automatically instead of deferring forever", () => {
    const cmd = join(dir, "codex.cmd"), ps1 = join(dir, "codex.ps1");
    const wrappers = [cmd, ps1].map(wrapperPath => ({ originalPath: wrapperPath, wrapperPath, backupPath: `${wrapperPath}.opencodex-real` }));
    for (const file of wrappers) fs.writeFileSync(file.backupPath, "native fixture launcher");
    fs.writeFileSync(cmd, buildWindowsCodexShim(wrappers[0]!.backupPath, "C:\\bun.exe", "C:\\cli.ts", "process"));
    fs.writeFileSync(ps1, previousTemplate("ps1", wrappers[1]!.backupPath));
    fs.writeFileSync(join(dir, "codex-shim.json"), JSON.stringify({ platform: "win32", ...wrappers[0], wrappers }));
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} }).status).toBe("restored");
    expectCurrent("ps1", ps1, wrappers[1]!.backupPath);
    expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} }).status).toBe("healthy");
  });
});

describe("round-4 identity bindings", () => {
  const obsoleteCmd = "@echo off\r\nrem obsolete\r\n";

  test.skipIf(process.platform === "win32")("a stage swapped for a link just before publication is withdrawn", () => {
    const wrapper = join(dir, "codex.cmd"), victim = join(dir, "unrelated-launcher.cmd");
    fs.writeFileSync(wrapper, obsoleteCmd);
    fs.writeFileSync(victim, "unrelated launcher bytes");
    const observed = stableShimPathProbe(wrapper)!;
    const link = fs.linkSync;
    let swapped = false;
    const spy = spyOn(fs, "linkSync").mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
      if (!swapped && String(source).includes(".ocx-refresh-")) {
        fs.unlinkSync(source); fs.symlinkSync(victim, source); swapped = true;
      }
      return link(source, destination);
    }) as typeof fs.linkSync);
    try {
      expect(refreshObsoleteWindowsShim(wrapper, observed, () => "current wrapper")).toBe(false);
    } finally { spy.mockRestore(); }
    expect(swapped).toBe(true);
    expect(fs.readFileSync(victim, "utf8")).toBe("unrelated launcher bytes");
    expect(fs.lstatSync(wrapper).isSymbolicLink()).toBe(false);
    expect(fs.statSync(wrapper).ino).not.toBe(fs.statSync(victim).ino);
    expect(fs.readFileSync(wrapper, "utf8")).toBe(obsoleteCmd);
  });

  test("an aside substituted before a failed publication is never restored as the launcher", () => {
    const wrapper = join(dir, "codex.cmd");
    fs.writeFileSync(wrapper, obsoleteCmd);
    const observed = stableShimPathProbe(wrapper)!;
    const link = fs.linkSync;
    let substituted = "";
    const spy = spyOn(fs, "linkSync").mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
      if (!substituted && String(source).includes(".ocx-refresh-")) {
        substituted = fs.readdirSync(dir).find(name => name.includes(".ocx-obsolete-"))!;
        fs.unlinkSync(join(dir, substituted));
        fs.writeFileSync(join(dir, substituted), "foreign aside bytes");
        throw Object.assign(new Error("transient sharing failure"), { code: "EACCES" });
      }
      return link(source, destination);
    }) as typeof fs.linkSync);
    try {
      expect(refreshObsoleteWindowsShim(wrapper, observed, () => "current wrapper")).toBe(false);
    } finally { spy.mockRestore(); }
    expect(substituted).not.toBe("");
    expect(fs.existsSync(wrapper)).toBe(false);
    expect(fs.readFileSync(join(dir, substituted), "utf8")).toBe("foreign aside bytes");
  });

  test("a current sibling replaced during the stability wait defers without adopting it", () => {
    const cmd = join(dir, "codex.cmd"), ps1 = join(dir, "codex.ps1");
    const wrappers = [cmd, ps1].map(wrapperPath => ({ originalPath: wrapperPath, wrapperPath, backupPath: `${wrapperPath}.opencodex-real` }));
    for (const file of wrappers) fs.writeFileSync(file.backupPath, "native fixture launcher");
    fs.writeFileSync(cmd, buildWindowsCodexShim(wrappers[0]!.backupPath, "C:\\bun.exe", "C:\\cli.ts", "process"));
    const obsolete = previousTemplate("ps1", wrappers[1]!.backupPath);
    fs.writeFileSync(ps1, obsolete);
    fs.writeFileSync(join(dir, "codex-shim.json"), JSON.stringify({ platform: "win32", ...wrappers[0], wrappers }));
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {
      fs.unlinkSync(cmd);
      fs.writeFileSync(cmd, "replacement native launcher");
    } }).status).toBe("deferred");
    expect(fs.readFileSync(cmd, "utf8")).toBe("replacement native launcher");
    expect(fs.readFileSync(wrappers[0]!.backupPath, "utf8")).toBe("native fixture launcher");
    expect(fs.readFileSync(ps1, "utf8")).toBe(obsolete);
  });
});

describe("round-5 availability", () => {
  test("no hard-link support leaves the wrapper in place and untouched", () => {
    const wrapper = join(dir, "codex.cmd");
    fs.writeFileSync(wrapper, "@echo off\r\nrem obsolete\r\n");
    const before = fs.statSync(wrapper, { bigint: true }).ino;
    const observed = stableShimPathProbe(wrapper)!;
    const spy = spyOn(fs, "linkSync").mockImplementation((() => { throw Object.assign(new Error("no links"), { code: "EPERM" }); }) as typeof fs.linkSync);
    try {
      expect(refreshObsoleteWindowsShim(wrapper, observed, () => "current wrapper")).toBe(false);
    } finally { spy.mockRestore(); }
    expect(fs.statSync(wrapper, { bigint: true }).ino).toBe(before);
    expect(fs.readdirSync(dir).filter(name => name.includes(".ocx-"))).toEqual([]);
  });

  test("links failing after displacement still restore the launcher", () => {
    const wrapper = join(dir, "codex.cmd");
    const obsolete = "@echo off\r\nrem obsolete\r\n";
    fs.writeFileSync(wrapper, obsolete);
    const observed = stableShimPathProbe(wrapper)!;
    const link = fs.linkSync;
    const spy = spyOn(fs, "linkSync").mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
      if (String(source).includes(".ocx-link-probe-")) return link(source, destination);
      throw Object.assign(new Error("links became unavailable"), { code: "EPERM" });
    }) as typeof fs.linkSync);
    try {
      expect(refreshObsoleteWindowsShim(wrapper, observed, () => "current wrapper")).toBe(false);
    } finally { spy.mockRestore(); }
    expect(fs.readFileSync(wrapper, "utf8")).toBe(obsolete);
    expect(fs.readdirSync(dir).filter(name => name.includes(".ocx-"))).toEqual([]);
  });
});

describe("descriptor hygiene", () => {
  test("a failing stat of the moved wrapper closes its descriptor and restores the launcher", () => {
    const wrapper = join(dir, "codex.cmd");
    const obsolete = "@echo off\r\nrem obsolete\r\n";
    fs.writeFileSync(wrapper, obsolete);
    const observed = stableShimPathProbe(wrapper)!;
    const open = fs.openSync, close = fs.closeSync, fstat = fs.fstatSync;
    const opened = new Set<number>();
    const opening = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args); opened.add(fd); return fd;
    }) as typeof fs.openSync);
    const closing = spyOn(fs, "closeSync").mockImplementation(((fd: number) => { opened.delete(fd); return close(fd); }) as typeof fs.closeSync);
    let injected = false;
    const stating = spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
      if (!injected && fs.readdirSync(dir).some(name => name.includes(".ocx-obsolete-"))) {
        injected = true;
        throw Object.assign(new Error("injected fstat failure"), { code: "EIO" });
      }
      return (fstat as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.fstatSync);
    try {
      expect(refreshObsoleteWindowsShim(wrapper, observed, () => "current wrapper")).toBe(false);
    } finally { stating.mockRestore(); closing.mockRestore(); opening.mockRestore(); }
    expect(injected).toBe(true);
    expect(opened.size).toBe(0);
    expect(fs.readFileSync(wrapper, "utf8")).toBe(obsolete);
    expect(fs.readdirSync(dir).filter(name => name.includes(".ocx-"))).toEqual([]);
  });
});
