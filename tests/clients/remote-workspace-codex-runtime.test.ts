import { repoPath } from "../helpers/repo-root";
import { expect, spyOn, test } from "bun:test";
import {
  codexCliUpdateSelectionGate,
  beginCodexCliSelectionParentWrite,
  createWorkerCommitWindow, createCodexCliUpdateFence,
} from "../../src/codex/cli-update-selection-gate";
import { resolve } from "node:path";
import {
  CodexRemoteWorkspaceRuntimeFactory,
  RemoteWorkspaceCoordinator,
  type RemoteWorkspaceSessionEvent,
  type RemoteWorkspaceTransport,
} from "../../src/remote-control";

test("Codex Remote Workspace runtime owns the model process on the Hub", async () => {
  const events: Array<{ type: RemoteWorkspaceSessionEvent["type"]; text: string }> = [];
  const transport: RemoteWorkspaceTransport = {
    isOnline: () => true,
    async invoke() { return { ok: true, value: null }; },
  };
  const coordinator = new RemoteWorkspaceCoordinator(transport);
  const factory = new CodexRemoteWorkspaceRuntimeFactory({
    command: [process.execPath, repoPath("tests", "fake-codex-server.ts")],
    version: "0.146.0-test",
    env: {
      FAKE_CODEX_SCRIPT: JSON.stringify({
        turns: [{
          notifications: [{
            method: "item/completed",
            params: { item: { id: "answer-1", type: "agentMessage", text: "Done from Computer 1" } },
          }],
        }],
      }),
    },
  });

  expect(await factory.available()).toEqual({ available: true, version: "0.146.0-test" });
  const handle = await factory.start({
    sessionId: "session-1",
    deviceId: "device-2",
    deviceName: "Computer 2",
    rootId: "root-2",
    rootLabel: "Project",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    tools: ["list_directory", "read_file", "write_file", "exec"],
    coordinator,
    emit: (type, text) => events.push({ type, text }),
  });
  const unregister = coordinator.register({
    sessionId: "session-1",
    threadId: handle.threadId,
    executorDeviceId: "device-2",
    executorName: "Computer 2",
    rootId: "root-2",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    tools: ["list_directory", "read_file", "write_file", "exec"],
  });
  try {
    await handle.prompt("Inspect the remote project");
    expect(events).toContainEqual({ type: "assistant", text: "Done from Computer 1" });
  } finally {
    unregister();
    await handle.stop();
  }
});

test("Codex Remote Workspace stop interrupts a held turn", async () => {
  const coordinator = new RemoteWorkspaceCoordinator({
    isOnline: () => true,
    async invoke() { return { ok: true }; },
  });
  const factory = new CodexRemoteWorkspaceRuntimeFactory({
    command: [process.execPath, repoPath("tests", "fake-codex-server.ts")],
    env: { FAKE_CODEX_SCRIPT: JSON.stringify({ turns: [{ heldUntilInterrupt: true }] }) },
  });
  const handle = await factory.start({
    sessionId: "session-1",
    deviceId: "device-2",
    deviceName: "Computer 2",
    rootId: "root-2",
    rootLabel: "Project",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    tools: ["list_directory", "read_file", "write_file", "exec"],
    coordinator,
    emit: () => {},
  });
  coordinator.register({
    sessionId: "session-1",
    threadId: handle.threadId,
    executorDeviceId: "device-2",
    executorName: "Computer 2",
    rootId: "root-2",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    tools: ["list_directory", "read_file", "write_file", "exec"],
  });
  const turn = handle.prompt("Hold this turn").then(() => "resolved", () => "rejected");
  await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
  await handle.stop();
  expect(await turn).toBe("rejected");
});

test("Codex Remote Workspace resumes the persisted App Server thread ID", async () => {
  const factory = new CodexRemoteWorkspaceRuntimeFactory({
    command: [process.execPath, repoPath("tests", "fake-codex-server.ts")],
  });
  const coordinator = new RemoteWorkspaceCoordinator({
    isOnline: () => true,
    async invoke() { return { ok: true }; },
  });
  const handle = await factory.start({
    sessionId: "session-resume",
    deviceId: "device-2",
    deviceName: "Computer 2",
    rootId: "root-2",
    rootLabel: "Project",
    capabilities: ["workspace.read"],
    tools: ["list_directory", "read_file"],
    resumeThreadId: "thread-persisted",
    coordinator,
    emit: () => {},
  });
  expect(handle.threadId).toBe("thread-persisted");
  await handle.stop();
});

function launchGateStartOptions(emit: (type: RemoteWorkspaceSessionEvent["type"], text: string) => void = () => {}): Parameters<CodexRemoteWorkspaceRuntimeFactory["start"]>[0] {
  return {
    sessionId: "launch-gate-session",
    deviceId: "launch-gate-device",
    deviceName: "Fixture",
    rootId: "launch-gate-root",
    rootLabel: "Fixture",
    capabilities: ["workspace.read"],
    tools: ["list_directory", "read_file"],
    coordinator: new RemoteWorkspaceCoordinator({
      isOnline: () => true,
      async invoke() { return { ok: true }; },
    }),
    emit,
  };
}

// Uses the REAL factory and its existing explicit command seam. A broken gate
// reaches the spawn spy, which throws; it can never launch a real Codex app.
test("CLI commit window blocks Remote Workspace native spawn and release restores the caller", async () => {
  const factory = new CodexRemoteWorkspaceRuntimeFactory({
    command: [process.execPath, repoPath("tests", "fake-codex-server.ts")],
    env: { FAKE_CODEX_SCRIPT: JSON.stringify({ turns: [{}] }) },
  });
  const options = launchGateStartOptions();
  const window = createWorkerCommitWindow({
    gate: codexCliUpdateSelectionGate(),
    fence: createCodexCliUpdateFence(),
  });
  let held = false;
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("unexpected native spawn while worker holds the gate");
  });
  try {
    held = window.tryEnter();
    expect(held).toBe(true);
    await expect(factory.start(options)).rejects.toThrow("codex_cli_selection_busy");
    expect(spawn).toHaveBeenCalledTimes(0);
  } finally {
    if (held) window.exit();
    spawn.mockRestore();
  }
  // No native Codex fallback: command remains the repository's fake JSON-RPC server.
  const handle = await factory.start(options);
  try {
    await handle.prompt("Complete this fixture turn");
  } finally {
    await handle.stop();
  }
  const parent = beginCodexCliSelectionParentWrite();
  try { expect(parent.entered).toBe(true); }
  finally { if (parent.entered) parent.exit(); }
});

// Unlike a gate-wrapper unit test, this reaches the existing prompt/interrupt/
// close implementation. The emitted marker replaces a scheduling sleep.
test("an existing Remote Workspace turn can interrupt and close while the worker gate is held", async () => {
  let ready!: () => void;
  const sawHeldTurn = new Promise<void>(resolveReady => { ready = resolveReady; });
  const factory = new CodexRemoteWorkspaceRuntimeFactory({
    command: [process.execPath, repoPath("tests", "fake-codex-server.ts")],
    env: {
      FAKE_CODEX_SCRIPT: JSON.stringify({
        turns: [{
          heldUntilInterrupt: true,
          notifications: [{
            method: "item/completed",
            params: { item: { id: "gate-ready", type: "agentMessage", text: "gate-ready" } },
          }],
        }],
      }),
    },
  });
  const handle = await factory.start(launchGateStartOptions((type, text) => {
    if (type === "assistant" && text === "gate-ready") ready();
  }));
  const window = createWorkerCommitWindow({
    gate: codexCliUpdateSelectionGate(),
    fence: createCodexCliUpdateFence(),
  });
  let held = false;
  let stopped = false;
  let turn: Promise<string> | undefined;
  try {
    turn = handle.prompt("Hold until interrupted").then(() => "resolved", () => "rejected");
    await sawHeldTurn;
    held = window.tryEnter();
    expect(held).toBe(true);
    await handle.stop();
    stopped = true;
    expect(await turn).toBe("rejected");
    // The stop path must NOT steal/release the worker's ownership.
    const parent = beginCodexCliSelectionParentWrite();
    try { expect(parent.entered).toBe(false); }
    finally { if (parent.entered) parent.exit(); }
  } finally {
    if (held) window.exit();
    if (!stopped) await handle.stop();
    if (turn) await turn;
  }
});
