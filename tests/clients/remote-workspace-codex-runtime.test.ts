import { repoPath } from "../helpers/repo-root";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireCodexCliUpdateLease } from "../../src/codex/cli-update-lease";
import {
  CodexRemoteWorkspaceRuntimeFactory,
  RemoteWorkspaceCoordinator,
  type RemoteWorkspaceSessionEvent,
  type RemoteWorkspaceTransport,
} from "../../src/remote-control";

function startOptions(coordinator: RemoteWorkspaceCoordinator) {
  return {
    sessionId: "session-lease",
    deviceId: "device-2",
    deviceName: "Computer 2",
    rootId: "root-2",
    rootLabel: "Project",
    capabilities: ["workspace.read"],
    tools: ["list_directory", "read_file"],
    coordinator,
    emit: () => {},
  };
}

function leaseCoordinator(): RemoteWorkspaceCoordinator {
  return new RemoteWorkspaceCoordinator({
    isOnline: () => true,
    async invoke() { return { ok: true }; },
  });
}

test("a held Codex CLI update lease refuses the app-server start before spawn", async () => {
  // The lease is the mutual exclusion the process scan cannot give: an app-server
  // that starts while an apply holds it would load a half-replaced global install.
  const dir = mkdtempSync(join(tmpdir(), "ocx-update-lease-"));
  const lockPath = join(dir, "codex-cli-update.lock");
  const held = acquireCodexCliUpdateLease({ lockPath, pid: 4_242, planId: "a".repeat(32) });
  expect(held.acquired).toBe(true);

  const factory = new CodexRemoteWorkspaceRuntimeFactory({
    command: [process.execPath, repoPath("tests", "fake-codex-server.ts")],
    updateLease: { lockPath, isAlive: () => true, timeoutMs: 0 },
  });
  await expect(factory.start(startOptions(leaseCoordinator())))
    .rejects.toThrow("Codex CLI update is in progress");
});

test("the app-server start waits out the lease and proceeds once it clears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-update-lease-"));
  const lockPath = join(dir, "codex-cli-update.lock");
  const held = acquireCodexCliUpdateLease({ lockPath, pid: 4_242, planId: "a".repeat(32) });
  expect(held.acquired).toBe(true);

  // The owner is alive on the first observation and gone by the second — the tail
  // of an install releasing, which a startup may wait out rather than refuse.
  let livenessChecks = 0;
  const factory = new CodexRemoteWorkspaceRuntimeFactory({
    command: [process.execPath, repoPath("tests", "fake-codex-server.ts")],
    env: { FAKE_CODEX_SCRIPT: JSON.stringify({ turns: [] }) },
    updateLease: {
      lockPath,
      isAlive: () => livenessChecks++ === 0,
      sleep: async () => {},
      timeoutMs: 1_000,
    },
  });
  const handle = await factory.start(startOptions(leaseCoordinator()));
  await handle.stop();
});

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
