import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildUnixCodexShim, buildWindowsCodexShim } from "../src/codex-shim";

const SHIM_MARKER = "opencodex codex autostart shim";

describe("Codex autostart shim", () => {
  test("builds a Unix shim that starts ocx before execing Codex", () => {
    const script = buildUnixCodexShim("/usr/local/bin/codex-real", "/usr/local/bin/bun", "/opt/opencodex/src/cli.ts");

    expect(script).toContain(SHIM_MARKER);
    expect(script).toContain("ensure");
    expect(script).not.toContain("sync-cache");
    expect(script).toContain('exec "/usr/local/bin/codex-real" "$@"');
  });

  test("builds a Windows shim that starts ocx before running Codex", () => {
    const script = buildWindowsCodexShim("C:\\Tools\\codex-real.exe", "C:\\Bun\\bun.exe", "C:\\ocx\\cli.ts");

    expect(script).toContain(SHIM_MARKER);
    expect(script).toContain("ensure");
    expect(script).not.toContain("sync-cache");
    expect(script).toContain('"C:\\Tools\\codex-real.exe" %*');
  });

  test("shim builder output contains the marker that isShim() checks", () => {
    const unix = buildUnixCodexShim("/bin/codex", "/bin/bun", "/cli.ts");
    const win = buildWindowsCodexShim("C:\\codex.exe", "C:\\bun.exe", "C:\\cli.ts");

    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-test-"));
    const unixPath = join(dir, "codex-shim");
    const winPath = join(dir, "codex-shim.cmd");

    writeFileSync(unixPath, unix, "utf8");
    writeFileSync(winPath, win, "utf8");

    expect(readFileSync(unixPath, "utf8")).toContain(SHIM_MARKER);
    expect(readFileSync(winPath, "utf8")).toContain(SHIM_MARKER);
  });

  test("non-shim file does not contain the marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-test-"));
    const fakeBinary = join(dir, "codex");
    writeFileSync(fakeBinary, "#!/bin/sh\necho hello\n", "utf8");

    expect(readFileSync(fakeBinary, "utf8")).not.toContain(SHIM_MARKER);
  });

  test("Unix shim uses bypass env var to skip proxy start", () => {
    const script = buildUnixCodexShim("/bin/codex", "/bin/bun", "/cli.ts");
    expect(script).toContain("OCX_SHIM_BYPASS");
  });

  test("Windows shim uses bypass env var to skip proxy start", () => {
    const script = buildWindowsCodexShim("C:\\codex.exe", "C:\\bun.exe", "C:\\cli.ts");
    expect(script).toContain("OCX_SHIM_BYPASS");
  });
});
