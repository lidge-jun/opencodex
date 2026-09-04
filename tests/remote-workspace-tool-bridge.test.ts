import { expect, test } from "bun:test";
import { RemoteWorkspaceCoordinator, startRemoteWorkspaceToolBridge } from "../src/remote-control";

test("loopback CLI bridge accepts only its bearer and delegates to the E2EE coordinator", async () => {
  const invocations: string[] = [];
  const coordinator = new RemoteWorkspaceCoordinator({
    isOnline: () => true,
    async invoke(request) {
      invocations.push(request.tool);
      return { ok: true, value: { entries: ["src"] } };
    },
  });
  coordinator.register({
    sessionId: "session-1",
    threadId: "thread-1",
    executorDeviceId: "device-2",
    executorName: "Computer 2",
    rootId: "root-2",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    tools: ["list_directory", "read_file", "write_file", "exec"],
  });
  const bridge = startRemoteWorkspaceToolBridge({
    coordinator,
    threadId: "thread-1",
    tools: ["list_directory", "read_file", "write_file", "exec"],
  });
  try {
    const denied = await fetch(`${bridge.url}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "list_directory", arguments: { path: "." } }),
    });
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${bridge.url}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ tool: "list_directory", arguments: { path: "." } }),
    });
    expect(allowed.status).toBe(200);
    const body = await allowed.json() as { success: boolean; text: string };
    expect(body.success).toBe(true);
    expect(body.text).toContain("src");
    expect(invocations).toEqual(["list_directory"]);
  } finally {
    await bridge.stop();
  }
});

test("loopback CLI bridge rejects excess work before buffering another request", async () => {
  const releases: Array<() => void> = [];
  const coordinator = new RemoteWorkspaceCoordinator({
    isOnline: () => true,
    invoke: async () => await new Promise<{ ok: true; value: null }>(resolve => {
      releases.push(() => resolve({ ok: true, value: null }));
    }),
  });
  coordinator.register({
    sessionId: "session-1",
    threadId: "thread-1",
    executorDeviceId: "device-2",
    executorName: "Computer 2",
    rootId: "root-2",
    capabilities: ["workspace.read"],
    tools: ["list_directory", "read_file"],
  });
  const bridge = startRemoteWorkspaceToolBridge({
    coordinator,
    threadId: "thread-1",
    tools: ["list_directory"],
  });
  const request = () => fetch(`${bridge.url}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
    body: JSON.stringify({ tool: "list_directory", arguments: { path: "." } }),
  });
  try {
    const active = Array.from({ length: 8 }, request);
    for (let count = 0; count < 100 && releases.length < 8; count += 1) await Bun.sleep(1);
    expect(releases).toHaveLength(8);
    expect((await request()).status).toBe(429);
    for (const release of releases) release();
    expect((await Promise.all(active)).every(response => response.status === 200)).toBe(true);
  } finally {
    for (const release of releases) release();
    await bridge.stop();
  }
});
