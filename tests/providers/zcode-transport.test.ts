import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { ZcodeClient, type ZcodeSpawn } from "../../src/adapters/zcode/client";
import type { JsonObject, ZcodeSettings } from "../../src/adapters/zcode/settings";

const settings: ZcodeSettings = { command: ["/isolated/launcher", "argument with spaces"], home: "/isolated/home",
  workspace: "/workspace", settingsPath: "/isolated/config.json", scope: "test" };
function fixture() {
  const child = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
  const writes: JsonObject[] = [];
  child.stdin = new Writable({ write(chunk, _encoding, callback) { writes.push(JSON.parse(chunk.toString())); callback(); } });
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.stdout.end(); child.stderr.end(); queueMicrotask(() => child.emit("exit", 0)); return true; };
  let invocation: unknown[] = [];
  const spawn = ((...args: unknown[]) => { invocation = args; return child; }) as ZcodeSpawn;
  const client = new ZcodeClient(settings, spawn);
  return { child, client, writes, invocation: () => invocation };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe("ZCode NDJSON transport", () => {
  test("uses argv without shell and does not inherit provider secrets", async () => {
    const f = fixture(); const invocation = f.invocation();
    expect(invocation[0]).toBe("/isolated/launcher");
    expect(invocation[1]).toEqual(["argument with spaces", "app-server"]);
    const options = invocation[2] as { shell: boolean; env: Record<string, string> };
    expect(options.shell).toBe(false);
    expect(Object.keys(options.env).sort()).toEqual(["HOME", "PATH", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]);
    await f.client.close();
  });
  test("correlates fragmented Unicode responses and services runtime preferences", async () => {
    const f = fixture(); const pending = f.client.request("session/create", {});
    const bytes = Buffer.from(JSON.stringify({ id: 1, result: { text: "世界" } }) + "\n");
    for (const byte of bytes) f.child.stdout.write(Buffer.from([byte]));
    expect(await pending).toEqual({ text: "世界" });
    f.child.stdout.write(JSON.stringify({ id: "server-1", method: "session/requestRuntimePreferences", params: {} }) + "\n");
    await tick();
    expect(f.writes.at(-1)).toMatchObject({ id: "server-1", result: { askUserQuestionAutoResolutionEnabled: false } });
    await f.client.close();
  });
  test("denies interactive permissions rather than silently auto-approving", async () => {
    const f = fixture();
    f.child.stdout.write(JSON.stringify({ id: "server-2", method: "interaction/requestPermission", params: {} }) + "\n");
    await tick(); expect(f.writes.at(-1)).toMatchObject({ result: { decision: "deny" } });
    await f.client.close();
  });
  test("malformed protocol rejects pending requests without exposing payload", async () => {
    const f = fixture(); const pending = f.client.request("session/create", {});
    f.child.stdout.write("secret-value-not-json\n");
    await expect(pending).rejects.toThrow("invalid or oversized");
    await expect(f.client.request("session/create", {})).rejects.not.toThrow("secret-value");
    await f.client.close();
  });
  test("vendor errors never leak raw messages or stack traces", async () => {
    const f = fixture(); const pending = f.client.request("session/create", {});
    f.child.stdout.write(JSON.stringify({ id: 1, error: { message: "secret", data: { stack: "private" } } }) + "\n");
    await expect(pending).rejects.toThrow("ZCode rejected");
    await f.client.close();
  });
  test("EOF and request deadlines cannot leave promises pending", async () => {
    const f = fixture(); const pending = f.client.request("session/create", {});
    f.child.stdout.end(); await expect(pending).rejects.toThrow("closed"); await f.client.close();
    const timed = fixture(); await expect(timed.client.request("session/create", {}, 10)).rejects.toThrow("timed out");
    await timed.client.close();
  });
});
