import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeRemoteWorkspaceRuntimeFactory,
  RemoteWorkspaceCoordinator,
  RemoteWorkspaceExecutor,
} from "../src/remote-control";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function sse(events: Array<{ event: string; data: unknown }>): Response {
  return new Response(events.map(item => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

function messageStart(id: string): { event: string; data: unknown } {
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
      },
    },
  };
}

const claudePath = process.env.OCX_CLAUDE_BIN;
const claudeTest = claudePath ? test : test.skip;

claudeTest("real Claude Code uses only the selected remote executor MCP tools", async () => {
  if (!claudePath) return;
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-claude-real-"));
  roots.push(root);
  const workspace = join(root, "executor");
  const home = join(root, "home");
  mkdirSync(workspace);
  mkdirSync(home);
  writeFileSync(join(workspace, "marker.txt"), "only-on-computer-2");
  const requestBodies: Array<Record<string, unknown>> = [];
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 8 });
      if (!url.pathname.endsWith("/messages")) return Response.json({ error: { message: "not found" } }, { status: 404 });
      const body = await req.json() as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        return sse([
          messageStart("msg_remote_tool"),
          { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_remote_read", name: "mcp__ocx_remote_workspace__read_file", input: {} } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"marker.txt\"}" } } },
          { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
          { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } } },
          { event: "message_stop", data: { type: "message_stop" } },
        ]);
      }
      return sse([
        messageStart("msg_remote_answer"),
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Read only-on-computer-2 from the executor." } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    },
  });
  const deviceId = crypto.randomUUID();
  const executor = new RemoteWorkspaceExecutor({ deviceId, roots: [{ id: "root", path: workspace }] });
  const coordinator = new RemoteWorkspaceCoordinator({
    isOnline: candidate => candidate === deviceId,
    invoke: request => executor.invoke(request),
  });
  const events: string[] = [];
  const factory = new ClaudeRemoteWorkspaceRuntimeFactory({
    command: [claudePath],
    version: "real-smoke",
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ANTHROPIC_BASE_URL: model.url.toString().replace(/\/$/, ""),
      ANTHROPIC_AUTH_TOKEN: "test-only-token",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  });
  const handle = await factory.start({
    sessionId: "session-1",
    deviceId,
    deviceName: "Computer 2",
    rootId: "root",
    rootLabel: "Project",
    capabilities: ["workspace.read", "workspace.write"],
    tools: ["list_directory", "read_file", "write_file"],
    coordinator,
    emit: (type, text) => events.push(`${type}:${text}`),
  });
  const unregister = coordinator.register({
    sessionId: "session-1",
    threadId: handle.threadId,
    executorDeviceId: deviceId,
    executorName: "Computer 2",
    rootId: "root",
    capabilities: ["workspace.read", "workspace.write"],
    tools: ["list_directory", "read_file", "write_file"],
  });
  try {
    await handle.prompt("Read marker.txt from the remote workspace.");
    expect(events.some(event => event.includes("Read only-on-computer-2 from the executor."))).toBe(true);
    expect(JSON.stringify(requestBodies.at(-1))).toContain("only-on-computer-2");
    expect(JSON.stringify(requestBodies)).not.toContain("remote_exec");
    const persistedThreadId = handle.threadId;
    unregister();
    await handle.stop();
    const resumed = await factory.start({
      sessionId: "session-1",
      deviceId,
      deviceName: "Computer 2",
      rootId: "root",
      rootLabel: "Project",
      capabilities: ["workspace.read", "workspace.write"],
      tools: ["list_directory", "read_file", "write_file"],
      resumeThreadId: persistedThreadId,
      coordinator,
      emit: (type, text) => events.push(`${type}:${text}`),
    });
    const unregisterResumed = coordinator.register({
      sessionId: "session-1",
      threadId: resumed.threadId,
      executorDeviceId: deviceId,
      executorName: "Computer 2",
      rootId: "root",
      capabilities: ["workspace.read", "workspace.write"],
      tools: ["list_directory", "read_file", "write_file"],
    });
    try {
      await resumed.prompt("Continue the same remote session.");
      expect(resumed.threadId).toBe(persistedThreadId);
      expect(JSON.stringify(requestBodies.at(-1))).toContain("Continue the same remote session.");
    } finally {
      unregisterResumed();
      await resumed.stop();
    }
  } finally {
    unregister();
    await handle.stop();
    await model.stop(true);
  }
}, 30_000);
