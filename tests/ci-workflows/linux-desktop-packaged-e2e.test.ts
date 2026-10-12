import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCleanExit,
  assertRuntimeRecordPort,
  locateArtifacts,
  parseArguments,
  processTreeRssKiB,
  readRuntimeRecord,
  selectDebExecutable,
  windowManagerCloseArgs,
} from "../../desktop/scripts/linux-packaged-e2e";
import { repoPath } from "../helpers/repo-root";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "opencodex-linux-e2e-test-"));
}

describe("Linux packaged desktop E2E driver", () => {
  test("requires an explicit bundle root, report and strict version", () => {
    expect(() => parseArguments([])).toThrow("required");
    expect(() => parseArguments([
      "--bundle-root", "/bundles",
      "--report", "/report.json",
      "--version", "latest",
    ])).toThrow("strict semver");
    expect(parseArguments([
      "--bundle-root", "/bundles",
      "--report", "/report.json",
      "--version", "2.61.0-preview.1",
    ]).version).toBe("2.61.0-preview.1");
  });

  test("requires exactly one AppImage and deb from their bundle directories", () => {
    const root = temporaryDirectory();
    try {
      mkdirSync(join(root, "appimage"));
      mkdirSync(join(root, "deb"));
      writeFileSync(join(root, "appimage", "OpenCodex.AppImage"), "appimage");
      writeFileSync(join(root, "deb", "OpenCodex.deb"), "deb");
      expect(locateArtifacts(root)).toEqual({
        appimage: join(root, "appimage", "OpenCodex.AppImage"),
        deb: join(root, "deb", "OpenCodex.deb"),
      });
      writeFileSync(join(root, "deb", "stale.deb"), "deb");
      expect(() => locateArtifacts(root)).toThrow("exactly one deb");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selects the deb desktop host without mistaking the ocx sidecar for the app", () => {
    expect(selectDebExecutable(["/payload/usr/bin/ocx", "/payload/usr/bin/opencodex-desktop"]))
      .toBe("/payload/usr/bin/opencodex-desktop");
    expect(() => selectDebExecutable(["/payload/usr/bin/ocx"]))
      .toThrow("expected exactly one deb desktop executable");
  });

  test("accepts only a complete positive runtime record", () => {
    const root = temporaryDirectory();
    try {
      const record = join(root, "runtime-port.json");
      writeFileSync(record, JSON.stringify({ pid: 42, port: 10100 }));
      expect(readRuntimeRecord(record)).toEqual({ pid: 42, port: 10100 });
      expect(assertRuntimeRecordPort({ pid: 42, port: 10100 }, 10100)).toEqual({
        pid: 42,
        port: 10100,
      });
      expect(() => assertRuntimeRecordPort({ pid: 42, port: 10101 }, 10100))
        .toThrow("recorded port 10101, expected isolated port 10100");
      for (const invalid of [
        { pid: 0, port: 10100 },
        { pid: 42, port: 0 },
        { pid: 42, port: 65_536 },
        { pid: "42", port: 10100 },
      ]) {
        writeFileSync(record, JSON.stringify(invalid));
        expect(readRuntimeRecord(record)).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("measures only the selected process tree", () => {
    const rows = [
      { pid: 10, ppid: 1, rssKiB: 100 },
      { pid: 11, ppid: 10, rssKiB: 50 },
      { pid: 12, ppid: 11, rssKiB: 25 },
      { pid: 20, ppid: 1, rssKiB: 1_000 },
    ];
    expect(processTreeRssKiB(10, rows)).toBe(175);
    expect(processTreeRssKiB(20, rows)).toBe(1_000);
  });

  test("closes through the window manager and accepts only a clean app exit", () => {
    expect(windowManagerCloseArgs("4194310")).toEqual(["-i", "-c", "0x400006"]);
    expect(() => windowManagerCloseArgs("0")).toThrow("invalid X11 window id");
    expect(() => windowManagerCloseArgs("abc")).toThrow("invalid X11 window id");
    expect(assertCleanExit({ code: 0, signal: null })).toEqual({ code: 0, signal: null });
    expect(() => assertCleanExit(undefined)).toThrow("did not exit");
    expect(() => assertCleanExit({ code: null, signal: "SIGKILL" })).toThrow("signal SIGKILL");
    expect(() => assertCleanExit({ code: 1, signal: null })).toThrow("code 1");
  });

  test("the driver isolates each package from a runtime already using the default port", () => {
    const driver = readFileSync(
      repoPath("desktop", "scripts", "linux-packaged-e2e.ts"),
      "utf8",
    );
    expect(driver).toContain('server.listen(0, "127.0.0.1"');
    expect(driver).toContain('join(opencodexHome, "config.json")');
    expect(driver).toContain("JSON.stringify({ port: configuredPort }");
    expect(driver).not.toContain('port: 10100');
    expect(driver).toContain('["search", "--onlyvisible", "--name", "^OpenCodex$"]');
    expect(driver).toContain('command("wmctrl", windowManagerCloseArgs(windowId))');
    expect(driver).not.toContain('"windowclose"');
    expect(driver).toContain("const exit = assertCleanExit(appExit);");
  });
});
