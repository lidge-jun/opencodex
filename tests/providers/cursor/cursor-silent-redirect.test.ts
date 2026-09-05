import { describe, expect, test } from "bun:test";
import { nativeShellDisabledMessage } from "../../../src/adapters/cursor/native-exec-shell";

/**
 * Devlog 260826 gap-8: native-tool denial payloads must read as silent redirects.
 * Denial framing ("blocked", "disabled", "not executed", "denied") makes cursor
 * models narrate a surface switch and re-announce the task, burning turns.
 */
const FORBIDDEN = [/blocked/i, /\bdisabled\b/i, /not executed/i, /\bdenied\b/i, /cannot execute/i, /차단/];

describe("cursor native-denial silent-redirect framing (gap-8)", () => {
  test("shell denial has no denial framing and forbids narration", () => {
    const msg = nativeShellDisabledMessage();
    for (const pattern of FORBIDDEN) expect(msg).not.toMatch(pattern);
    expect(msg).toContain("Do NOT narrate");
    expect(msg).toContain("Re-issue this command NOW");
  });

  test("fs denial constant has no denial framing", async () => {
    const src = await Bun.file("src/adapters/cursor/native-exec-fs.ts").text();
    const constant = src.match(/NATIVE_LOCAL_EXEC_DISABLED =\s*"([^"]+)"/)?.[1] ?? "";
    expect(constant.length).toBeGreaterThan(0);
    for (const pattern of FORBIDDEN) expect(constant).not.toMatch(pattern);
    expect(constant).toContain("Do NOT narrate");
  });

  test("network denial constant has no denial framing", async () => {
    const src = await Bun.file("src/adapters/cursor/native-exec-network.ts").text();
    for (const pattern of FORBIDDEN) expect(src.split("\n").slice(0, 15).join("\n")).not.toMatch(pattern);
  });
});
