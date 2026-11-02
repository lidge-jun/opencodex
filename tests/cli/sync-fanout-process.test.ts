import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { runFanoutProcess, FanoutProcessError } from "../../src/cli/sync-fanout-process";

describe.skipIf(process.platform === "win32")("fanout process ownership", () => {
  test("returns a child exit code", async () => {
    expect(await runFanoutProcess(["sh", "-c", "exit 255"], { timeoutMs: 1000 })).toEqual({ code: 255, stdout: "", stderr: "" });
  });
  test("escalates and waits for a child that ignores TERM", async () => {
    let pid = 0;
    try {
      await runFanoutProcess(["sh", "-c", "trap '' TERM; printf '%s' $$; while :; do :; done"], { timeoutMs: 200, onSpawn: value => { pid = value; } });
      throw new Error("expected deadline");
    } catch (error) {
      expect(error).toBeInstanceOf(FanoutProcessError);
      expect((error as FanoutProcessError).reason).toBe("deadline-exceeded");
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 6000);
  test("rejects output above the cap", async () => {
    await expect(runFanoutProcess(["sh", "-c", "printf 123456789"], { timeoutMs: 1000, maxOutputBytes: 4 })).rejects.toMatchObject({ reason: "ssh-output" });
  });
  test("an elapsed deadline does not spawn a process", async () => {
    let spawned = false;
    await expect(runFanoutProcess(["sh", "-c", "exit 0"], { timeoutMs: 0, onSpawn: () => { spawned = true; } })).rejects.toMatchObject({ reason: "deadline-exceeded" });
    expect(spawned).toBe(false);
  });
});

test.skipIf(process.platform !== "linux")("a pipe held by a descendant fails closed and the descendant is reaped", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-fanout-pipe-"));
  const fixture = join(home, "subreaper.ts"), pidPath = join(home, "writer.pid");
  writeFileSync(fixture, String.raw`
import { dlopen, FFIType, ptr } from "bun:ffi";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spyOn } from "bun:test";
const libc = dlopen("libc.so.6", {
  prctl: { args: [FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i32 },
  waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});
if (libc.symbols.prctl(36, 1, 0, 0, 0) !== 0) throw new Error("subreaper setup failed");
const commandApi = await import(process.argv[2]);
const processApi = await import(process.argv[3]);
const codexSync = await import(process.argv[4]);
const statusApi = await import(process.argv[5]);
const shell = "(sleep 0.8; printf '%s\\n' 'Home unavailable; retained and applied the last-known-good remote catalog (stale).') 2>/dev/null & echo $! > \"$1\"; printf '%s\\n' 'ocx-fanout:stdout-begin' 'Remote Link Home catalog synchronized.'; printf '%s\\n' 'ocx-fanout:selected:2.93.0' >&2; exit 0";
const home = process.env.OPENCODEX_HOME, linkDir = join(home, "link");
mkdirSync(linkDir, { recursive: true });
const link = { id: "lnk_0123456789abcdef", alias: "fake", direction: "hub-initiated", hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 27001, apiKeyId: "test", createdAt: "2026-01-01T00:00:00Z", remotePlatform: "posix" };
writeFileSync(join(home, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai" }));
writeFileSync(join(linkDir, "links.json"), JSON.stringify({ version: 1, listenerPort: 27000, links: [link] }));
spyOn(codexSync, "syncModelsToCodex").mockResolvedValue({ status: "catalog-only", ok: true, added: 0, catalogPath: "fixture", catalogExists: true, catalogWritten: false, cacheSynced: false, message: "done", refreshOutcome: "committed" });
spyOn(statusApi, "readHomeLinkStatus").mockResolvedValue({ role: "home", listener: { state: "listening", port: 27000 }, child: null, links: [{ ...link, state: "connected", since: link.createdAt, reason: null, lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null }] });
const realRun = processApi.runFanoutProcess;
spyOn(processApi, "runFanoutProcess").mockImplementation(() => realRun(["sh", "-c", shell, "fixture", process.argv[6]], { timeoutMs: 3000 }));
const savedLog = console.log, output = [];
console.log = (...parts) => { output.push(parts.map(String).join(" ")); };
console.error = () => {};
console.warn = () => {};
const code = await commandApi.runSyncCommand({ args: ["sync", "--json"], findLiveProxy: async () => null });
const document = JSON.parse(output[0]);
const { reason, state } = document.children[0];
const pid = Number(readFileSync(process.argv[6], "utf8"));
const status = new Int32Array(1), deadline = Date.now() + 2500;
let reaped = false;
while (Date.now() < deadline) {
  const result = libc.symbols.waitpid(pid, ptr(status), 1);
  if (result === pid) { reaped = true; break; }
  if (result < 0) break;
  await Bun.sleep(20);
}
libc.close();
savedLog(JSON.stringify({ code, reason, state, reaped }));
`);
  try {
    const child = Bun.spawn([process.execPath, "run", fixture, repoPath("src/cli/sync-command.ts"), repoPath("src/cli/sync-fanout-process.ts"), repoPath("src/codex/sync.ts"), repoPath("src/cli/sync-link-status.ts"), pidPath], {
      env: { HOME: home, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex"), PATH: "/usr/bin:/bin" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ code: 6, reason: "ssh-output", state: "failed", reaped: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 6000);
