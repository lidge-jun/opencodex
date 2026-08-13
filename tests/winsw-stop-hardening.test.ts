import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("WinSW lifecycle stop hardening", () => {
  test("re-verifies native service state after stopwait before returning", () => {
    const source = readFileSync(join(import.meta.dir, "../src/lib/winsw.ts"), "utf8");
    const start = source.indexOf("export function stopWinswService");
    const end = source.indexOf("export function uninstallWinswService", start);
    const stop = source.slice(start, end);

    expect(stop).toContain('runWinsw(["stopwait"])');
    expect(stop).toContain("const status = statusWinswRaw();");
    expect(stop).toContain('status === "stopped" || status === "nonexistent"');
    expect(stop).toContain('status === "unknown"');
    expect(stop).toContain("Native service stop could not be verified.");
    expect(stop).toContain("Native service is still running after stop.");
  });
});
