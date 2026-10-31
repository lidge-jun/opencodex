import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseQueueMcpArgs } from "../../src/cli/message-mcp-command";
import { QUEUE_MCP_TARGET, queueMcpFixture } from "../helpers/messaging-mcp-queue";
import { repoPath } from "../helpers/repo-root";

test("message mcp requires exactly one explicit absolute CLI and home", () => {
  expect(parseQueueMcpArgs(["--codex", "/fixture/codex", "--codex-home", "/fixture/home"]))
    .toEqual({ codex: "/fixture/codex", codexHome: "/fixture/home" });
  for (const args of [[], ["--codex", "relative", "--codex-home", "/home"], ["--codex", "/bin/codex"],
    ["--codex", "/a", "--codex", "/b"], ["--codex", "/a", "--codex-home", "/b", "--json"],
    ["--remote", "/a", "--codex-home", "/b"], ["--codex", "/a\0b", "--codex-home", "/b"]]) {
    expect(parseQueueMcpArgs(args)).toBeNull();
  }
});

describe.skipIf(process.platform === "win32")("message MCP CLI", () => {
  test("malformed invocation writes no protocol bytes and creates no home", async () => {
    const child = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "message", "mcp"], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(64); expect(out).toBe(""); expect(err).toContain("Usage: ocx message mcp");
  });

  test("real MCP handshake advertises only explicit queue tools, starts no helper until called", async () => {
    const f = queueMcpFixture();
    const client = new Client({ name: "fixture", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [repoPath("src/cli/index.ts"), "message", "mcp", "--codex", f.options.codex, "--codex-home", f.options.codexHome], stderr: "pipe" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(t => t.name).sort()).toEqual(["codex_queue_message", "codex_threads"]);
      expect(f.calls()).toHaveLength(0);
      const listed = await client.callTool({ name: "codex_threads", arguments: {} });
      const payload = JSON.parse((listed.content as { text: string }[])[0]!.text);
      expect(payload.scope).toBe("stored_threads"); expect(payload.liveStateVerified).toBe(false);
      const sent = await client.callTool({ name: "codex_queue_message", arguments: { threadId: QUEUE_MCP_TARGET, message: "PRIVATE_MCP_BODY" } });
      const receipt = JSON.parse((sent.content as { text: string }[])[0]!.text);
      expect(receipt.status).toBe("queued"); expect(receipt.processed).toBe(false);
      expect(JSON.stringify(sent)).not.toContain("PRIVATE_MCP_BODY");
    } finally { await client.close(); await f.close(); }
  }, 15000);

  test("four-helper bound and MCP disconnect cancel and reap pending work", async () => {
    const f = queueMcpFixture("hang");
    const client = new Client({ name: "fixture", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [repoPath("src/cli/index.ts"), "message", "mcp", "--codex", f.options.codex, "--codex-home", f.options.codexHome], stderr: "pipe" });
    const pending: Promise<unknown>[] = [];
    try {
      await client.connect(transport);
      for (let i = 0; i < 4; i++) pending.push(client.callTool({ name: "codex_queue_message", arguments: { threadId: QUEUE_MCP_TARGET, message: "fixture" } }).catch(error => error));
      const until = performance.now() + 5000;
      while (f.calls().filter(c => c.frame.method === "thread/queue/add").length < 4 && performance.now() < until) await Bun.sleep(10);
      expect(f.calls().filter(c => c.frame.method === "thread/queue/add")).toHaveLength(4);
      const refused = await client.callTool({ name: "codex_threads", arguments: {} });
      expect(refused.isError).toBe(true);
      const pids = [...new Set(f.calls().map(c => c.pid))];
      expect(pids).toHaveLength(4);
      await client.close(); await Promise.allSettled(pending);
      const stoppedBy = performance.now() + 2500;
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      while (pids.some(alive) && performance.now() < stoppedBy) await Bun.sleep(10);
      expect(pids.some(alive)).toBe(false);
      expect(f.calls().filter(c => c.frame.method === "thread/queue/add")).toHaveLength(4);
    } finally { await client.close(); await Promise.allSettled(pending); await f.close(); }
  }, 20000);
});
