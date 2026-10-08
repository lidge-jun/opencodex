import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { messageCodexHome } from "../../src/cli/message-runtime";
import { skipsCodexShimAutoRestore } from "../../src/cli/codex-shim-autorestore";
import { CAPABILITIES } from "../../src/cli/capabilities";
import { LOCAL_TARGET, LocalFixtureRpcError, localMessagingFixture, NO_REPLY } from "../helpers/messaging-local";
import { repoPath } from "../helpers/repo-root";

test("command is local-only in registry and skips global repair even on malformed usage", () => {
  expect(skipsCodexShimAutoRestore("message", ["message", "unknown"])).toBe(true);
  const caps = CAPABILITIES.filter(cap => cap.command[0] === "message");
  expect(caps.map(cap => cap.command[1])).toEqual(["sessions", "send"]);
  expect(caps.every(cap => cap.routes.length === 0)).toBe(true);
  expect(caps[1]!.mutates).toBe(true);
  expect(caps[1]!.flags.map(flag => flag.name)).not.toContain("--host");
});

test("invalid usage allocates no timer, socket, helper or runtime-selection work", async () => {
  const script = `
    const { runMessageCommand } = await import(${JSON.stringify(repoPath("src/cli/message-command.ts"))});
    const fail = () => { throw new Error('Unexpected resource allocation'); };
    globalThis.setTimeout = fail; Bun.spawn = fail; globalThis.WebSocket = class { constructor() { fail(); } };
    process.exitCode = await runMessageCommand(['send', '--host', 'remote', '--stdin'], { CODEX_HOME: '/must-not-read' });
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(64); expect(output).toBe(""); expect(errors).toContain("Usage: ocx message");
  expect(errors).not.toContain("Unexpected resource allocation");
});

test.skipIf(process.platform === "win32")("full CLI uses the daemon directly, emits safe receipts and preserves exit codes", async () => {
  for (const mode of ["queued", "unsupported", "rejected", "unknown", "unloaded"]) {
    let reads = 0;
    const fixture = localMessagingFixture(call => {
      if (call.method === "thread/read" && mode === "unloaded" && ++reads === 2) {
        return { thread: { id: LOCAL_TARGET, name: "recipient", status: { type: "notLoaded" } } };
      }
      if (call.method !== "thread/queue/add") return;
      if (mode === "unsupported") return new LocalFixtureRpcError(-32601, "PRIVATE remote error");
      if (mode === "rejected") return new LocalFixtureRpcError(-32000, "PRIVATE remote error");
      if (mode === "unknown") { fixture.closeConnections(); return NO_REPLY; }
    });
    const preload = join(fixture.root, "no-spawn.ts");
    await Bun.write(preload, `const fail = () => { throw new Error('Unexpected helper spawn'); }; Bun.spawn = fail; Bun.spawnSync = fail;`);
    const env = { PATH: process.env.PATH, HOME: fixture.root, CODEX_HOME: fixture.codexHome,
      OPENCODEX_HOME: join(fixture.root, "ocx"), CODEX_CLI_PATH: "/nonexistent/native", OCX_TEST_HOME_GUARD: "1" };
    const cli = [process.execPath, "--preload", preload, repoPath("src/cli/index.ts"), "message"];
    const run = async (args: string[], stdin = "") => {
      const child = Bun.spawn([...cli, ...args], { env, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill(), 10_000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return { exitCode, stdout, stderr };
      } finally { clearTimeout(timer); }
    };
    try {
      expect(messageCodexHome(env)).toBe(fixture.codexHome);
      if (mode === "queued") {
        const directory = await run(["sessions", "--json"]);
        expect(directory.exitCode).toBe(0); expect(directory.stderr).toBe("");
        expect(JSON.parse(directory.stdout).sessions).toEqual([{ id: LOCAL_TARGET, name: "recipient", status: "idle" }]);
      }
      const result = await run(["send", "--name", "recipient", "--kind", "notification", "--stdin", "--json"], "PRIVATE body from stdin");
      expect(result.exitCode).toBe(mode === "queued" ? 0 : mode === "unknown" ? 3 : 1);
      expect(result.stderr).toBe(""); expect(result.stdout).not.toContain("PRIVATE");
      const receipt = JSON.parse(result.stdout);
      expect(receipt.status).toBe(mode === "queued" ? "queued" : mode === "unknown" ? "unknown" : "not_sent");
      expect(receipt.target.threadId).toBe(LOCAL_TARGET);
      const calls = fixture.calls.filter(call => call.method === "thread/queue/add");
      expect(calls).toHaveLength(mode === "unloaded" ? 0 : 1);
      if (mode !== "unloaded") expect(calls[0]!.params.clientUserMessageId).toBe(receipt.messageId);
      expect(existsSync(join(env.OPENCODEX_HOME, "codex-runtime.json"))).toBe(false);
      expect(fixture.connectionCount).toBe(mode === "queued" ? 2 : 1);
      expect(fixture.failures).toEqual([]);
    } finally { await fixture.close(); }
  }
}, 30_000);
