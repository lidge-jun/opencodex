import { describe, expect, test } from "bun:test";
import { buildUnixCodexShim, buildWindowsCodexShim } from "../src/codex-shim";

describe("Codex autostart shim", () => {
  test("builds a Unix shim that starts ocx before execing Codex", () => {
    const script = buildUnixCodexShim("/usr/local/bin/codex-real", "/usr/local/bin/bun", "/opt/opencodex/src/cli.ts");

    expect(script).toContain("opencodex codex autostart shim");
    expect(script).toContain("status");
    expect(script).toContain("OCX_SERVICE=1");
    expect(script).toContain("start");
    expect(script).toContain('exec "/usr/local/bin/codex-real" "$@"');
  });

  test("builds a Windows shim that starts ocx before running Codex", () => {
    const script = buildWindowsCodexShim("C:\\Tools\\codex-real.exe", "C:\\Bun\\bun.exe", "C:\\ocx\\cli.ts");

    expect(script).toContain("opencodex codex autostart shim");
    expect(script).toContain("findstr");
    expect(script).toContain("OCX_SERVICE=1");
    expect(script).toContain('"C:\\Tools\\codex-real.exe" %*');
  });
});
