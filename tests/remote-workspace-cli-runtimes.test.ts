import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  ClaudeRemoteWorkspaceRuntimeFactory,
  PiRemoteWorkspaceRuntimeFactory,
  RemoteWorkspaceCoordinator,
  type RemoteWorkspaceSessionEvent,
} from "../src/remote-control";

function coordinator(): RemoteWorkspaceCoordinator {
  return new RemoteWorkspaceCoordinator({
    isOnline: () => true,
    async invoke() { return { ok: true, value: null }; },
  });
}

test("Claude runtime keeps the CLI on the Hub and emits its answer", async () => {
  const events: Array<{ type: RemoteWorkspaceSessionEvent["type"]; text: string }> = [];
  const factory = new ClaudeRemoteWorkspaceRuntimeFactory({
    command: [process.execPath, resolve("tests/fixtures/fake-claude-stream.ts")],
    version: "test",
  });
  const handle = await factory.start({
    sessionId: "session-1",
    deviceId: "device-2",
    deviceName: "Computer 2",
    rootId: "root-2",
    rootLabel: "Project",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    tools: ["list_directory", "read_file", "write_file", "exec"],
    coordinator: coordinator(),
    emit: (type, text) => events.push({ type, text }),
  });
  try {
    await handle.prompt("hello remote");
    expect(events).toEqual([{ type: "assistant", text: "Hub answer: hello remote" }]);
  } finally {
    await handle.stop();
  }
});

const piPath = process.env.OCX_PI_BIN;
const piTest = piPath ? test : test.skip;

piTest("real Pi RPC starts with only the explicit Remote Workspace extension", async () => {
  if (!piPath) return;
  const factory = new PiRemoteWorkspaceRuntimeFactory({ command: [piPath], version: "test" });
  const startOptions = {
    sessionId: "session-1",
    deviceId: "device-2",
    deviceName: "Computer 2",
    rootId: "root-2",
    rootLabel: "Project",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    tools: ["list_directory", "read_file", "write_file", "exec"],
    coordinator: coordinator(),
    emit: () => {},
  } as const;
  const handle = await factory.start(startOptions);
  expect(handle.threadId).toMatch(/^[0-9a-f-]{36}$/);
  const threadId = handle.threadId;
  await handle.stop();
  const resumed = await factory.start({ ...startOptions, resumeThreadId: threadId });
  expect(resumed.threadId).toBe(threadId);
  await resumed.stop();
});
