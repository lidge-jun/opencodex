import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  MAX_HOOK_STDIN_BYTES,
  runAntigravityPreToolGuard,
} from "../../../src/adapters/antigravity-cli/pretool-guard";
import { ANTIGRAVITY_CLI_CONTEXT_WINDOW } from "../../../src/adapters/antigravity-cli/profiles";
import { projectedHistoryCharLimit } from "../../../src/adapters/coding-agent/protocol";

const BRIDGED_READ_TOOL = "mcp_ocx_turn_bridge_Read";
const tempDirs: string[] = [];

function createAllowedFile(policy: {
  tools: string[];
  imagePaths?: string[];
  turnDir?: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-agy-pretool-ceiling-"));
  tempDirs.push(dir);
  const allowFile = join(dir, "allowed.json");
  writeFileSync(allowFile, JSON.stringify(policy));
  return allowFile;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("antigravity-cli PreToolUse hook stdin byte ceiling", () => {
  test("MAX_HOOK_STDIN_BYTES matches projectedHistoryCharLimit(ANTIGRAVITY_CLI_CONTEXT_WINDOW) * 4 with 32 MiB floor", () => {
    const expected = Math.max(
      32 * 1024 * 1024,
      projectedHistoryCharLimit(ANTIGRAVITY_CLI_CONTEXT_WINDOW) * 4,
    );
    expect(MAX_HOOK_STDIN_BYTES).toBe(expected);
    expect(MAX_HOOK_STDIN_BYTES).toBeGreaterThanOrEqual(32 * 1024 * 1024);
  });

  test("allows a >300 KiB valid JSON payload calling a declared bridged tool", async () => {
    const allowFile = createAllowedFile({ tools: [BRIDGED_READ_TOOL] });
    const payload = JSON.stringify({
      transcript: "x".repeat(300 * 1024),
      context: "y".repeat(16 * 1024),
      toolCall: {
        name: BRIDGED_READ_TOOL,
        parameters: { path: "a" },
      },
    });
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(300 * 1024);

    const out: string[] = [];
    const exitCode = await runAntigravityPreToolGuard(
      allowFile,
      Readable.from([payload]),
      text => out.push(text),
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ decision: "allow" });
  });

  test("denies a >300 KiB valid JSON payload calling an undeclared tool with normal policy reason", async () => {
    const allowFile = createAllowedFile({ tools: [BRIDGED_READ_TOOL] });
    const payload = JSON.stringify({
      transcript: "x".repeat(300 * 1024),
      toolCall: {
        name: "run_command",
        parameters: { CommandLine: "echo hi" },
      },
    });
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(300 * 1024);

    const out: string[] = [];
    const exitCode = await runAntigravityPreToolGuard(
      allowFile,
      Readable.from([payload]),
      text => out.push(text),
    );
    expect(exitCode).toBe(0);
    const verdict = JSON.parse(out.join("")) as { decision: string; reason?: string };
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toContain("Only the declared turn tool catalog is permitted");
    expect(verdict.reason).not.toContain("byte ceiling");
  });

  test("fails closed when stdin exceeds MAX_HOOK_STDIN_BYTES by 1 KiB", async () => {
    const allowFile = createAllowedFile({ tools: [BRIDGED_READ_TOOL] });
    const oneMiB = Buffer.alloc(1024 * 1024, 0x61);
    const remainderBytes = MAX_HOOK_STDIN_BYTES + 1024;
    async function* oversizedStream(): AsyncGenerator<Uint8Array> {
      let remaining = remainderBytes;
      while (remaining >= oneMiB.byteLength) {
        yield oneMiB;
        remaining -= oneMiB.byteLength;
      }
      if (remaining > 0) {
        yield Buffer.alloc(remaining, 0x61);
      }
    }

    const out: string[] = [];
    const exitCode = await runAntigravityPreToolGuard(
      allowFile,
      oversizedStream(),
      text => out.push(text),
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({
      decision: "deny",
      reason: "PreToolUse payload exceeded the byte ceiling.",
    });
  });

  test("preserves staged .ocx-images/* allow and outside-path deny on >300 KiB payloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-agy-pretool-img-"));
    tempDirs.push(dir);
    const imagesDir = join(dir, ".ocx-images");
    mkdirSync(imagesDir, { recursive: true });
    const stagedImg = join(imagesDir, "img-0.png");
    const outsideFile = join(dir, "secret.txt");
    writeFileSync(stagedImg, Buffer.from([137, 80, 78, 71]));
    writeFileSync(outsideFile, "secret");

    const allowFile = join(dir, "allowed.json");
    writeFileSync(allowFile, JSON.stringify({
      tools: [BRIDGED_READ_TOOL],
      imagePaths: [stagedImg],
      turnDir: dir,
    }));

    const largeAllowPayload = JSON.stringify({
      transcript: "z".repeat(310 * 1024),
      toolCall: {
        name: "view_file",
        args: { Path: stagedImg, toolSummary: "Inspect image" },
      },
    });
    const outAllow: string[] = [];
    await runAntigravityPreToolGuard(
      allowFile,
      Readable.from([largeAllowPayload]),
      text => outAllow.push(text),
    );
    expect(JSON.parse(outAllow.join(""))).toEqual({ decision: "allow" });

    for (const badArgs of [
      { Path: outsideFile },
      { Path: stagedImg, StartLine: 1 },
      { Path: join(dir, ".ocx-images", "..", "secret.txt") },
    ]) {
      const largeDenyPayload = JSON.stringify({
        transcript: "z".repeat(310 * 1024),
        toolCall: {
          name: "view_file",
          args: badArgs,
        },
      });
      const outDeny: string[] = [];
      await runAntigravityPreToolGuard(
        allowFile,
        Readable.from([largeDenyPayload]),
        text => outDeny.push(text),
      );
      const verdict = JSON.parse(outDeny.join("")) as { decision: string; reason?: string };
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toContain("view_file is permitted strictly on exact staged .ocx-images/* paths");
    }
  });
});
