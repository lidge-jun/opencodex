/**
 * Frame-log descriptor hardening, split out of server-live.test.ts for the
 * file-size ratchet. These cases exercise the log writer directly; they do not
 * start a server.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TEST_DIR = join(import.meta.dir, ".tmp-server-live-frame-log-test");

beforeEach(() => {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

// appendFileSync's mode option only applies when it creates the file, so an
// existing permissive log would have stayed readable by other local users.
// appendOwnerOnly hardens the opened descriptor instead.
test("frame log hardens a pre-existing permissive file", async () => {
  if (process.platform === "win32") return;
  const { logLiveSidebandStage } = await import("../../src/server/live");
  const frameLogPath = join(TEST_DIR, "frames-permissive.jsonl");
  const previousFrameLog = process.env.OCX_LIVE_FRAME_LOG;
  try {
    writeFileSync(frameLogPath, "", { mode: 0o644 });
    chmodSync(frameLogPath, 0o644);
    process.env.OCX_LIVE_FRAME_LOG = frameLogPath;
    logLiveSidebandStage("relay-attached");
    expect(statSync(frameLogPath).mode & 0o777).toBe(0o600);
    const line = readFileSync(frameLogPath, "utf8").trim();
    expect(JSON.parse(line)).toMatchObject({ stage: "relay-attached" });
  } finally {
    if (previousFrameLog === undefined) delete process.env.OCX_LIVE_FRAME_LOG;
    else process.env.OCX_LIVE_FRAME_LOG = previousFrameLog;
  }
});

// A failed descriptor harden must not leave the record in a permissive file.
test("a failed frame-log harden appends nothing", async () => {
  const { appendOwnerOnly } = await import("../../src/server/live");
  const frameLogPath = join(TEST_DIR, "frames-harden-fail.jsonl");
  writeFileSync(frameLogPath, "", { mode: 0o644 });
  expect(() =>
    appendOwnerOnly(frameLogPath, "{}\n", () => {
      throw new Error("harden denied");
    }),
  ).toThrow("harden denied");
  expect(readFileSync(frameLogPath, "utf8")).toBe("");
});

const windowsTest = process.platform === "win32" ? test : test.skip;
windowsTest("a Windows ACL hardening failure appends nothing", async () => {
  const { appendOwnerOnly } = await import("../../src/server/live");
  const frameLogPath = join(TEST_DIR, "frames-acl-fail.jsonl");
  writeFileSync(frameLogPath, "before\n");
  expect(() => appendOwnerOnly(frameLogPath, "after\n", (_fd, openedPath) => {
    if (openedPath === frameLogPath) throw new Error("ACL hardening failed");
  })).toThrow("ACL hardening failed");
  expect(readFileSync(frameLogPath, "utf8")).toBe("before\n");
});

test("Windows frame-log hardening runs once per file identity, not per frame", async () => {
  const { appendOwnerOnly } = await import("../../src/server/live");
  const frameLogPath = join(TEST_DIR, "frames-memo.jsonl");
  const movedPath = join(TEST_DIR, "frames-memo-moved.jsonl");
  const hardened: string[] = [];
  const harden = (_fd: number, openedPath: string) => { hardened.push(openedPath); };
  appendOwnerOnly(frameLogPath, "one\n", harden, "win32");
  appendOwnerOnly(frameLogPath, "two\n", harden, "win32");
  expect(hardened).toEqual([frameLogPath]);
  renameSync(frameLogPath, movedPath);
  writeFileSync(frameLogPath, "");
  appendOwnerOnly(frameLogPath, "three\n", harden, "win32");
  expect(hardened).toEqual([frameLogPath, frameLogPath]);
  expect(readFileSync(frameLogPath, "utf8")).toBe("three\n");
  expect(readFileSync(movedPath, "utf8")).toBe("one\ntwo\n");
});

test("a path replacement after hardening appends nothing to the held file", async () => {
  if (process.platform === "win32") return;
  const { appendOwnerOnly } = await import("../../src/server/live");
  const frameLogPath = join(TEST_DIR, "frames-replaced.jsonl");
  const movedPath = join(TEST_DIR, "frames-moved.jsonl");
  writeFileSync(frameLogPath, "before\n");
  expect(() => appendOwnerOnly(frameLogPath, "after\n", () => {
    renameSync(frameLogPath, movedPath);
    writeFileSync(frameLogPath, "replacement\n");
  })).toThrow("Frame log path changed during hardening.");
  expect(readFileSync(movedPath, "utf8")).toBe("before\n");
  expect(readFileSync(frameLogPath, "utf8")).toBe("replacement\n");
});

test("frame diagnostics retain only metadata for text, binary, and bounded views", async () => {
  const { logLiveSidebandFrame } = await import("../../src/server/live");
  const previousFrameLog = process.env.OCX_LIVE_FRAME_LOG;
  const frameLogPath = join(TEST_DIR, "frame-metadata.jsonl");
  const damagedText = "private-voice-�";
  const encoded = new TextEncoder().encode(damagedText);
  const padded = new TextEncoder().encode("�safe�");
  const frames: Array<{ data: unknown; kind: string; bytes: number; fffd: boolean }> = [
    { data: damagedText, kind: "text", bytes: 17, fffd: true },
    { data: encoded.buffer, kind: "binary", bytes: 17, fffd: true },
    { data: Buffer.from(encoded), kind: "binary", bytes: 17, fffd: true },
    // Replacement characters outside this view must not affect the flag or byte count.
    { data: new Uint8Array(padded.buffer, 3, 4), kind: "binary", bytes: 4, fffd: false },
    { data: new DataView(padded.buffer, 3, 4), kind: "binary", bytes: 4, fffd: false },
    { data: "한글", kind: "text", bytes: 6, fffd: false },
    { data: new Uint8Array([0xff]), kind: "binary", bytes: 1, fffd: true },
  ];
  try {
    process.env.OCX_LIVE_FRAME_LOG = frameLogPath;
    for (const frame of frames) logLiveSidebandFrame("u2c", frame.data);
    logLiveSidebandFrame("c2u", { privateText: damagedText });
    const raw = readFileSync(frameLogPath, "utf8");
    const records = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(frames.length);
    records.forEach((record, index) => {
      const expected = frames[index]!;
      expect(record).toEqual({
        ts: expect.any(String), dir: "u2c", kind: expected.kind,
        bytes: expected.bytes, fffd: expected.fffd,
      });
      expect(Number.isNaN(Date.parse(record.ts))).toBe(false);
    });
    for (const content of [damagedText, "safe", "한글", "�"]) expect(raw).not.toContain(content);
    delete process.env.OCX_LIVE_FRAME_LOG;
    logLiveSidebandFrame("c2u", damagedText);
    expect(readFileSync(frameLogPath, "utf8")).toBe(raw);
    process.env.OCX_LIVE_FRAME_LOG = TEST_DIR;
    expect(() => logLiveSidebandFrame("c2u", damagedText)).not.toThrow();
  } finally {
    if (previousFrameLog === undefined) delete process.env.OCX_LIVE_FRAME_LOG;
    else process.env.OCX_LIVE_FRAME_LOG = previousFrameLog;
  }
});
