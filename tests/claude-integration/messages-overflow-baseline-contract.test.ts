import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { collectOverflowChild, finishOverflowScratch, overflowScratchBase, type OverflowChild } from "../helpers/messages-overflow-child";
import { TEST_TEMP_OWNER_FILE } from "../../scripts/test-temp";
import { trackOverflowAsyncSpawns } from "../helpers/messages-overflow-spawn-tracker";
import { setWindowsOwnerAclAsyncRunnerForTests, verifyWindowsEntriesAclAsync } from "../../src/lib/windows-owner-acl";

const digest = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
test("#8128 shared overflow predicate changes only in the documented 5xx and conditional cases", () => {
  const source = readFileSync(repoPath("src/claude/outbound.ts"), "utf8");
  const start = source.indexOf("const GENERIC_FAILURE_CODES");
  const end = source.indexOf("export function anthropicErrorBody", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const predicate = source.slice(start, end);
  const addition = '"upstream_server_error", ';
  const currentExceeds = '  for (const exceeds of text.matchAll(new RegExp(EXCEEDS_TEXT_RE, "gi"))) {\n    if (!NEGATION_RE.test(exceeds[0]) && !CONDITIONAL_LEAD_RE.test(text.slice(0, exceeds.index))) return true;\n  }\n  return false;';
  const baselineExceeds = '  const exceeds = EXCEEDS_TEXT_RE.exec(text);\n  return exceeds !== null && !NEGATION_RE.test(exceeds[0]);';
  expect(predicate.split(addition)).toHaveLength(2);
  expect(predicate.split(currentExceeds)).toHaveLength(2);
  expect(digest(predicate.replace(addition, "").replace(currentExceeds, baselineExceeds))).toBe("d1d3fd370bcc625c9638f63ff57498456e66b58cf1e258be028bc4d3318493fa");
});
test("#8128 behavior suite retains origin/dev source", () => {
  const source = readFileSync(repoPath("tests/claude-integration/claude-uncoded-context-overflow.test.ts"));
  expect(source.length).toBeGreaterThan(0);
  expect(digest(source)).toBe("d5d0573f377c5d7894bff343a0bd9cebec46df5bc405b112238862479a3e7328");
});

test("retained overflow scratch is outside nested test sandboxes and junction aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-overflow-location-"));
  try {
    const nested = join(root, "nested");
    const inner = join(nested, "tmp");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(root, TEST_TEMP_OWNER_FILE), "{}");
    writeFileSync(join(nested, TEST_TEMP_OWNER_FILE), "{}");
    const alias = join(root, "alias");
    symlinkSync(inner, alias, process.platform === "win32" ? "junction" : "dir");
    const base = overflowScratchBase(alias);
    const rel = relative(realpathSync.native(root), base);
    expect(rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)).toBe(true);
    expect(base).toBe(overflowScratchBase(inner));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("overflow child drains both streams before returning its exit", async () => {
  const child = Bun.spawn([process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err');"], { stdout: "pipe", stderr: "pipe" });
  const result = await collectOverflowChild(child, performance.now() + 25_000);
  expect(result).toEqual({ exit: 0, stdout: "out", stderr: "err" });
  expect(child.exitCode).toBe(0);
}, 30_000);

test("overflow deadline kills and joins the owned real child", async () => {
  const child = Bun.spawn([process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err'); setInterval(() => {}, 1000);"], { stdout: "pipe", stderr: "pipe" });
  let joined = false;
  try {
    await expect(collectOverflowChild(child, performance.now() + 500)).rejects.toThrow("internal deadline");
    const exit = await child.exited;
    joined = true;
    expect(exit).not.toBe(0);
  } finally {
    if (!joined) { try { child.kill(); } finally { await child.exited; } }
  }
}, 30_000);

test("a pipe failure kills and joins the still-live owned child", async () => {
  let code: number | null = null;
  let resolveExit!: (value: number) => void;
  let kills = 0;
  const child: OverflowChild = {
    pid: 42,
    get exitCode() { return code; },
    exited: new Promise(resolve => { resolveExit = resolve; }),
    stdout: new ReadableStream({ start(controller) { controller.error(new Error("fixture pipe failure")); } }),
    stderr: new ReadableStream({ start(controller) { controller.close(); } }),
    kill() { kills++; code = 143; resolveExit(143); },
  };
  await expect(collectOverflowChild(child, performance.now() + 2_000)).rejects.toThrow("cleanup incomplete");
  expect(kills).toBe(1);
  expect(await child.exited).toBe(143);
});

test("expired deadline is not accepted when a delayed timer loses the race", async () => {
  const closed = () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  const child: OverflowChild = { pid: 42, exitCode: 0, exited: Promise.resolve(0), stdout: closed(), stderr: closed(), kill() { throw new Error("already exited"); } };
  await expect(collectOverflowChild(child, performance.now() - 1)).rejects.toThrow("internal deadline");
});

test("unconfirmed termination and a held pipe are reported without waiting forever", async () => {
  let kills = 0;
  const child: OverflowChild = {
    pid: 42, exitCode: null, exited: new Promise(() => {}),
    stdout: new ReadableStream({ start(controller) { controller.close(); } }),
    stderr: new ReadableStream({}), kill() { kills++; },
  };
  await expect(collectOverflowChild(child, performance.now() + 10, 30)).rejects.toThrow("cleanup incomplete");
  expect(kills).toBe(1);
});

test("overflow child preserves a pipe failure and its cleanup failures", async () => {
  const child: OverflowChild = {
    pid: 42, exitCode: null, exited: new Promise(() => {}),
    stdout: new ReadableStream({ start(controller) { controller.error(new Error("fixture pipe failure")); } }),
    stderr: new ReadableStream({}), kill() { throw new Error("fixture kill failure"); },
  };
  let caught: unknown;
  try { await collectOverflowChild(child, performance.now() + 1_000, 30); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AggregateError);
  const details = (caught as AggregateError).errors.map(String).join("\n");
  expect(details).toContain("fixture pipe failure");
  expect(details).toContain("fixture kill failure");
  expect(details).toContain("exit or output drain was not confirmed");
});

test("overflow cleanup retains unverified scratch and preserves a primary failure", () => {
  const primary = new Error("primary fixture failure");
  let removed = false;
  expect(() => finishOverflowScratch("fixture-scratch", false, { error: primary }, () => { removed = true; })).toThrow("primary fixture failure");
  expect(removed).toBe(false);
});

test("overflow cleanup reports both the primary and removal failures", () => {
  const primary = new Error("primary fixture failure");
  const cleanup = new Error("fixture removal failure");
  let caught: unknown;
  try { finishOverflowScratch("fixture-scratch", true, { error: primary }, () => { throw cleanup; }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([primary, cleanup]);
});

test("overflow subprocess tracker waits for a real child after its caller returns", async () => {
  const tracker = trackOverflowAsyncSpawns();
  let child: ReturnType<typeof Bun.spawn<{ stdin: "pipe"; stdout: "pipe"; stderr: "pipe" }>> | undefined;
  let exited = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text();"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const owned = child;
    watchdog = setTimeout(() => { if (!exited) owned.kill(); }, 5_000);
    let drained = false;
    const draining = tracker.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    owned.stdin.end();
    await draining;
    const exit = await owned.exited;
    exited = true;
    expect(exit).toBe(0);
    expect(drained).toBe(true);
  } finally {
    clearTimeout(watchdog);
    if (child && !exited) { try { child.kill(); } catch { /* already exited */ } await child.exited; }
    tracker.restore();
  }
}, 30_000);

test("overflow tracker joins an ACL verifier child after the verifier reports timeout", async () => {
  const tracker = trackOverflowAsyncSpawns();
  let child: ReturnType<typeof Bun.spawn<{ stdin: "pipe"; stdout: "pipe"; stderr: "pipe" }>> | undefined;
  let joined = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  setWindowsOwnerAclAsyncRunnerForTests(async () => {
    child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text();"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const owned = child;
    watchdog = setTimeout(() => { if (!joined) owned.kill(); }, 5_000);
    return { success: false, timedOut: true, stdout: new Uint8Array() };
  });
  try {
    expect(await verifyWindowsEntriesAclAsync([{ path: "fixture", directory: true }], 1_000)).toBe(false);
    if (!child) throw new Error("ACL fixture did not spawn its child");
    let drained = false;
    const draining = tracker.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    child.stdin.end();
    await draining;
    expect(await child.exited).toBe(0);
    joined = true;
  } finally {
    clearTimeout(watchdog);
    setWindowsOwnerAclAsyncRunnerForTests(null);
    if (child && !joined) { try { child.kill(); } catch { /* already exited */ } await child.exited; }
    tracker.restore();
  }
}, 30_000);
