import { describe, expect, test } from "bun:test";
import type { RemoteWorkspaceHub } from "../../src/remote-control/workspace-hub";
import {
  RemoteWorkspaceSessionService,
  type RemoteWorkspaceRuntimeFactory,
  type RemoteWorkspaceRuntimeHandle,
  type RemoteWorkspaceSessionEvent,
  type RemoteWorkspaceSessionState,
  type RemoteWorkspaceSessionStateStore,
  type RemoteWorkspaceTransport,
} from "../../src/remote-control";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const ROOT_ID = "22222222-2222-4222-8222-222222222222";

interface Harness {
  service: RemoteWorkspaceSessionService;
  setOnline(value: boolean): void;
  invocations: Array<{ tool: string; rootId: string }>;
  closedSessions: string[];
  stopCalls(): number;
  sessionOpens(): number;
  sessionGrants: string[][];
  runtimeStarts(): Array<string | undefined>;
}

class MemorySessionStore implements RemoteWorkspaceSessionStateStore {
  state: RemoteWorkspaceSessionState | null = null;
  load() { return this.state ? structuredClone(this.state) : null; }
  save(state: RemoteWorkspaceSessionState) { this.state = structuredClone(state); }
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(options: {
  promptGate?: ReturnType<typeof deferred>;
  startGate?: ReturnType<typeof deferred>;
  availableGate?: ReturnType<typeof deferred>;
  onAvailable?: () => void;
  deviceIds?: string[];
  onStart?: () => void;
  onPrompt?: () => void;
  lazyResumable?: boolean;
  eventsAtStart?: number;
  sessionStore?: RemoteWorkspaceSessionStateStore;
  stopError?: Error;
  onStop?: (call: number) => Promise<void>;
  closeError?: Error;
} = {}): Harness {
  const deviceIds = options.deviceIds ?? [DEVICE_ID];
  let online = true;
  let stops = 0;
  let opens = 0;
  let promptStarted = false;
  let runtimeResumable = options.lazyResumable !== true;
  const invocations: Array<{ tool: string; rootId: string }> = [];
  const closedSessions: string[] = [];
  const sessionGrants: string[][] = [];
  const transportStates: Array<{ online: boolean }> = [];
  const runtimeStarts: Array<string | undefined> = [];
  const newTransport = (): RemoteWorkspaceTransport => {
    const state = { online: true };
    transportStates.push(state);
    return {
      isOnline: deviceId => state.online && deviceIds.includes(deviceId),
      async invoke(request) {
        if (!state.online) throw new Error("transport offline");
        invocations.push({ tool: request.tool, rootId: request.rootId });
        return { ok: true, value: { entries: ["src"] } };
      },
    };
  };
  const connection = {
    capabilities: () => ["workspace.read", "workspace.write", "workspace.exec"],
    async openSession(input: { capabilities: string[] }) { sessionGrants.push([...input.capabilities]); opens += 1; return newTransport(); },
    async closeSession(sessionId: string) {
      closedSessions.push(sessionId);
      if (options.closeError) throw options.closeError;
    },
  };
  const hub = {
    listDevices: () => deviceIds.map(id => ({
      id,
      name: "Build box",
      platform: "linux",
      capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
      roots: [{ id: ROOT_ID, label: "Project" }],
      online,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: null,
    })),
    connection: (deviceId: string) => online && deviceIds.includes(deviceId) ? connection : null,
  } as unknown as RemoteWorkspaceHub;

  const factory: RemoteWorkspaceRuntimeFactory = {
    profile: "codex",
    async available() {
      options.onAvailable?.();
      if (options.availableGate) await options.availableGate.promise;
      return { available: true, version: "test" };
    },
    async start({ coordinator, emit, resumeThreadId }) {
      options.onStart?.();
      if (options.startGate) await options.startGate.promise;
      runtimeStarts.push(resumeThreadId);
      for (let index = 0; index < (options.eventsAtStart ?? 0); index += 1) {
        emit("assistant", `event-${index}`);
      }
      const handle: RemoteWorkspaceRuntimeHandle = {
        threadId: resumeThreadId ?? "thread-remote-1",
        canResume: () => runtimeResumable,
        async prompt() {
          promptStarted = true;
          options.onPrompt?.();
          if (options.promptGate) await options.promptGate.promise;
          else {
            const response = await coordinator.handle({
              method: "item/tool/call",
              id: "tool-1",
              params: {
                threadId: "thread-remote-1",
                turnId: "turn-1",
                callId: "call-1",
                namespace: "ocx_remote_workspace",
                tool: "list_directory",
                arguments: { path: "." },
              },
            });
            emit("tool", response.result.contentItems[0]!.text);
          }
          runtimeResumable = true;
        },
        async stop() {
          stops += 1;
          await options.onStop?.(stops);
          if (promptStarted) options.promptGate?.reject(new Error("turn cancelled"));
          if (options.stopError) throw options.stopError;
        },
      };
      return handle;
    },
  };
  return {
    service: new RemoteWorkspaceSessionService(hub, [factory], Date.now, options.sessionStore),
    setOnline(value) {
      online = value;
      if (!value) for (const state of transportStates) state.online = false;
    },
    invocations,
    closedSessions,
    stopCalls: () => stops,
    sessionOpens: () => opens,
    sessionGrants,
    runtimeStarts: () => [...runtimeStarts],
  };
}

describe("Remote Workspace session service", () => {
  test("accepted resumed turns stay busy through reconnect and runtime startup", async () => {
    const store = new MemorySessionStore();
    const first = createHarness({ sessionStore: store });
    const created = await first.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    await first.service.shutdown();
    const startGate = deferred();
    const started = deferred();
    const promptGate = deferred();
    const prompted = deferred();
    const resumed = createHarness({ sessionStore: store, startGate, onStart: started.resolve, promptGate, onPrompt: prompted.resolve });
    const accepted = resumed.service.submitPrompt(created.id, "Long turn");
    expect(["starting", "running"]).toContain(accepted.status);
    expect(accepted.events.at(-1)!.sequence).toBeGreaterThan(created.events.at(-1)!.sequence);
    await started.promise;
    expect(["starting", "running"]).toContain(resumed.service.get(created.id)!.status);
    startGate.resolve();
    await prompted.promise;
    expect(resumed.service.get(created.id)!.status).toBe("running");
    expect(() => resumed.service.submitPrompt(created.id, "Duplicate")).toThrow("active turn");
    await resumed.service.stop(created.id);
    expect(resumed.service.get(created.id)!.status).toBe("stopped");
  });

  test("a rejected accepted turn is observed and publishes a terminal failure", async () => {
    const failed = deferred();
    const store = new class extends MemorySessionStore {
      override save(state: RemoteWorkspaceSessionState) {
        super.save(state);
        if (state.sessions.some(session => session.status === "failed")) failed.resolve();
      }
    }();
    const gate = deferred();
    const entered = deferred();
    const harness = createHarness({ sessionStore: store, promptGate: gate, onPrompt: entered.resolve });
    const created = await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    const accepted = harness.service.submitPrompt(created.id, "Will fail");
    expect(accepted.status).toBe("running");
    await entered.promise;
    gate.reject(new Error("held turn failed"));
    await failed.promise;
    expect(harness.service.get(created.id)!.status).toBe("failed");
    expect(harness.service.get(created.id)!.events.at(-1)!.text).toBe("held turn failed");
    await harness.service.stop(created.id);
  });

  test("Stop immediately after acceptance prevents the model prompt", async () => {
    let prompts = 0;
    const harness = createHarness({ onPrompt: () => { prompts++; } });
    const created = await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    harness.service.submitPrompt(created.id, "Cancel before execution");
    await harness.service.stop(created.id);
    expect(prompts).toBe(0);
    expect(harness.stopCalls()).toBe(1);
    expect(harness.service.get(created.id)!.status).toBe("stopped");
  });

  for (const operation of ["create", "resume"] as const) {
    for (const scope of ["device", "global"] as const) {
      test(`${operation} reserves ${scope} capacity before awaiting runtime availability`, async () => {
        const deviceIds = scope === "device" ? [DEVICE_ID] : [DEVICE_ID, "device-2", "device-3"];
        const limit = scope === "device" ? 4 : 8;
        const store = new MemorySessionStore();
        if (operation === "resume") {
          const seed = createHarness({ sessionStore: store });
          await seed.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
          await seed.service.shutdown();
          const template = store.state!.sessions[0]!;
          store.state!.sessions = Array.from({ length: limit + 1 }, (_, index) => ({
            ...structuredClone(template), id: `resume-${index}`, threadId: `thread-${index}`,
            deviceId: deviceIds[index % deviceIds.length]!,
          }));
        }
        const gate = deferred();
        const entered = deferred();
        let availableCalls = 0;
        const harness = createHarness({
          deviceIds, sessionStore: store, availableGate: gate,
          onAvailable: () => { if (++availableCalls === limit) entered.resolve(); },
        });
        const call = (index: number) => operation === "create"
          ? harness.service.create({ profile: "codex", deviceId: deviceIds[index % deviceIds.length]!, rootId: ROOT_ID })
          : harness.service.prompt(`resume-${index}`, "Resume");
        const admitted = Array.from({ length: limit }, (_, index) => call(index));
        try {
          await entered.promise;
          await expect(call(limit)).rejects.toThrow(scope === "device" ? "executor session limit" : "active session limit");
          expect(availableCalls).toBe(limit);
          gate.resolve();
          await Promise.all(admitted);
          expect(harness.runtimeStarts()).toHaveLength(limit);
        } finally {
          gate.resolve();
          await Promise.allSettled(admitted);
          await harness.service.stopAll();
        }
      });
    }
  }

  test.each(["stop", "shutdown"] as const)("%s reports failed cleanup of a late resumed runtime", async action => {
    const store = new MemorySessionStore();
    const first = createHarness({ sessionStore: store });
    const created = await first.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    await first.service.shutdown();
    const gate = deferred();
    const entered = deferred();
    const cleanupError = new Error("late stop failed");
    let modelPrompts = 0;
    const resumed = createHarness({ sessionStore: store, startGate: gate, onStart: entered.resolve, stopError: cleanupError, onPrompt: () => { modelPrompts += 1; } });
    const prompt = resumed.service.prompt(created.id, "Resume").then(() => "resolved", () => "rejected");
    await entered.promise;
    const stopping = action === "stop" ? resumed.service.stop(created.id) : resumed.service.shutdown();
    const outcome = Promise.allSettled([stopping]);
    gate.resolve();
    const [result] = await outcome;
    expect(result!.status).toBe("rejected");
    if (result!.status !== "rejected") throw new Error("cleanup unexpectedly succeeded");
    expect(result!.reason).toBe(cleanupError);
    expect(modelPrompts).toBe(0);
    expect(resumed.invocations).toEqual([]);
    expect(await prompt).toBe("rejected");
    expect(resumed.stopCalls()).toBe(1);
    expect(resumed.closedSessions).toEqual([created.id]);
    expect(resumed.service.get(created.id)?.status).toBe("failed");
  });

  test("failed availability releases every pending runtime reservation", async () => {
    const gate = deferred();
    const harness = createHarness({ availableGate: gate });
    const calls = Array.from({ length: 4 }, () => harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID }));
    const results = Promise.allSettled(calls);
    await expect(harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID })).rejects.toThrow("executor session limit");
    gate.reject(new Error("availability probe failed"));
    expect((await results).every(result => result.status === "rejected")).toBe(true);
    await expect(harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID })).rejects.toThrow("availability probe failed");
    expect(harness.runtimeStarts()).toHaveLength(0);
  });

  test.each(["stop", "shutdown"] as const)("%s owns a runtime returned after resume cancellation", async action => {
    const store = new MemorySessionStore();
    const first = createHarness({ sessionStore: store });
    const created = await first.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    await first.service.shutdown();
    const gate = deferred();
    const entered = deferred();
    const resumed = createHarness({ sessionStore: store, startGate: gate, onStart: entered.resolve });
    const prompt = resumed.service.prompt(created.id, "Resume").then(() => "resolved", () => "rejected");
    await entered.promise;
    const stopping = action === "stop" ? resumed.service.stop(created.id) : resumed.service.shutdown();
    gate.resolve();
    await stopping;
    expect(await prompt).toBe("rejected");
    expect(resumed.stopCalls()).toBe(1);
    expect(resumed.closedSessions).toEqual([created.id]);
    expect(resumed.invocations).toEqual([]);
    expect(resumed.service.get(created.id)?.status).toBe(action === "stop" ? "stopped" : "waiting_for_executor");
  });

  test("binds one model session to the selected executor root", async () => {
    const harness = createHarness();
    const created = await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    expect(created.status).toBe("ready");
    expect(created.deviceName).toBe("Build box");
    expect(created.rootLabel).toBe("Project");
    expect(created).toMatchObject({
      accessMode: "read-only",
      capabilities: ["workspace.read"],
      tools: ["list_directory", "read_file"],
    });

    const completed = await harness.service.prompt(created.id, "Inspect this project");
    expect(completed.status).toBe("ready");
    expect(harness.invocations).toEqual([{ tool: "list_directory", rootId: ROOT_ID }]);
    expect(completed.events.some(event => event.type === "tool" && event.text.includes("src"))).toBe(true);
  });

  test("exposes write and exec tools only after an explicit workspace access grant", async () => {
    const harness = createHarness();
    const created = await harness.service.create({
      profile: "codex",
      deviceId: DEVICE_ID,
      rootId: ROOT_ID,
      accessMode: "workspace",
    });
    expect(created).toMatchObject({
      accessMode: "workspace",
      capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
      tools: ["list_directory", "read_file", "write_file", "exec"],
    });
  });

  test("fails closed when the selected executor disconnects", async () => {
    const harness = createHarness();
    const created = await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    harness.setOnline(false);
    await expect(harness.service.prompt(created.id, "Do not run locally")).rejects.toThrow("executor is offline");
    expect(harness.invocations).toHaveLength(0);
    expect(harness.service.get(created.id)?.status).toBe("waiting_for_executor");
  });

  test("reopens only the encrypted executor channel after the device reconnects", async () => {
    const harness = createHarness();
    const created = await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    expect(harness.sessionOpens()).toBe(1);
    harness.setOnline(false);
    expect(harness.service.get(created.id)?.status).toBe("waiting_for_executor");
    harness.setOnline(true);
    const completed = await harness.service.prompt(created.id, "Continue remotely");
    expect(completed.status).toBe("ready");
    expect(harness.sessionOpens()).toBe(2);
    expect(harness.invocations).toEqual([{ tool: "list_directory", rootId: ROOT_ID }]);
  });

  test("rejects a second prompt while a turn is active", async () => {
    const gate = deferred();
    const harness = createHarness({ promptGate: gate });
    const created = await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    const first = harness.service.prompt(created.id, "First");
    await Promise.resolve();
    await expect(harness.service.prompt(created.id, "Second")).rejects.toThrow("active turn");
    gate.resolve();
    await first;
  });

  test("a turn that finishes after disconnect stays waiting instead of reporting ready", async () => {
    const gate = deferred();
    const harness = createHarness({ promptGate: gate });
    const created = await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    const running = harness.service.prompt(created.id, "Keep the target binding");
    await Promise.resolve();
    harness.setOnline(false);
    gate.resolve();
    const completed = await running;
    expect(completed.status).toBe("waiting_for_executor");
  });

  test("stop cancels an active turn before waiting for it", async () => {
    const gate = deferred();
    const harness = createHarness({ promptGate: gate });
    const created = await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    const promptOutcome = harness.service.prompt(created.id, "Long turn").then(
      () => "resolved",
      () => "rejected",
    );
    await Promise.resolve();

    expect(await harness.service.stop(created.id)).toBe(true);
    expect(await promptOutcome).toBe("rejected");
    expect(harness.stopCalls()).toBe(1);
    expect(harness.closedSessions).toEqual([created.id]);
    expect(harness.service.get(created.id)?.status).toBe("stopped");
  });

  test("stop cannot be overwritten by a session that finishes starting late", async () => {
    const startGate = deferred();
    const startEntered = deferred();
    const harness = createHarness({ startGate, onStart: startEntered.resolve });
    const creating = harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    await startEntered.promise;
    const starting = harness.service.list()[0];
    if (!starting) throw new Error("starting session was not visible");

    expect(await harness.service.stop(starting.id)).toBe(true);
    startGate.resolve();
    await expect(creating).rejects.toThrow("stopped while starting");
    expect(harness.service.get(starting.id)?.status).toBe("stopped");
    expect(harness.stopCalls()).toBe(1);
  });

  test("attempts every session cleanup owner and reports incomplete teardown", async () => {
    const harness = createHarness({
      stopError: new Error("runtime refused to stop"),
      closeError: new Error("transport refused to close"),
    });
    const created = await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    await expect(harness.service.stop(created.id)).rejects.toThrow("runtime refused to stop");
    expect(harness.stopCalls()).toBe(1);
    expect(harness.closedSessions).toEqual([created.id]);
    expect(harness.service.get(created.id)?.status).toBe("failed");
  });

  test("keeps only a bounded event history", async () => {
    const harness = createHarness({ eventsAtStart: 510 });
    const created = await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    expect(created.events).toHaveLength(100);
    expect(created.events[0]!.sequence).toBeGreaterThan(1);
    const types: RemoteWorkspaceSessionEvent["type"][] = created.events.map(event => event.type);
    expect(types.at(-1)).toBe("status");
  });

  test("restores a persisted Hub session and resumes its original model thread", async () => {
    const store = new MemorySessionStore();
    const first = createHarness({ sessionStore: store });
    const created = await first.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    expect(store.state?.sessions[0]?.threadId).toBe("thread-remote-1");

    const restarted = createHarness({ sessionStore: store });
    expect(restarted.service.get(created.id)?.status).toBe("waiting_for_executor");
    const completed = await restarted.service.prompt(created.id, "Continue after Hub restart");
    expect(completed.status).toBe("ready");
    expect(restarted.runtimeStarts()).toEqual(["thread-remote-1"]);
  });

  test("persists a lazy runtime as resumable only after its first completed turn", async () => {
    const store = new MemorySessionStore();
    const first = createHarness({ sessionStore: store, lazyResumable: true });
    const created = await first.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    expect(created.resumable).toBe(false);
    expect(store.state?.sessions[0]?.resumable).toBe(false);

    const completed = await first.service.prompt(created.id, "Create durable history");
    expect(completed.resumable).toBe(true);
    const restarted = createHarness({ sessionStore: store, lazyResumable: true });
    expect(restarted.service.get(created.id)?.status).toBe("waiting_for_executor");
  });

  test("graceful Hub shutdown cleans runtimes without marking resumable sessions stopped", async () => {
    const store = new MemorySessionStore();
    const first = createHarness({ sessionStore: store });
    const created = await first.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    await first.service.shutdown();
    expect(first.stopCalls()).toBe(1);
    expect(store.state?.sessions[0]?.status).toBe("waiting_for_executor");

    const restarted = createHarness({ sessionStore: store });
    const completed = await restarted.service.prompt(created.id, "Resume after graceful restart");
    expect(completed.status).toBe("ready");
    expect(restarted.runtimeStarts()).toEqual(["thread-remote-1"]);
  });

  test("stops every retained runtime during Hub shutdown", async () => {
    const harness = createHarness();
    await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
    await harness.service.stopAll();
    expect(harness.stopCalls()).toBe(2);
    expect(harness.service.list().every(session => session.status === "stopped")).toBe(true);
  });
});


test("read-only capability grant is forwarded on initial open and reconnect", async () => {
  const harness = createHarness();
  const created = await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID, accessMode: "read-only" });
  expect(harness.sessionGrants).toEqual([["workspace.read"]]);
  harness.setOnline(false);
  harness.service.list();
  harness.setOnline(true);
  await harness.service.prompt(created.id, "Read after reconnect");
  expect(harness.sessionGrants).toEqual([["workspace.read"], ["workspace.read"]]);
  await harness.service.stop(created.id);
});


test("availability completing after shutdown cannot create a new session", async () => {
  const gate = deferred();
  let started = false;
  const service = new RemoteWorkspaceSessionService({} as RemoteWorkspaceHub, [{
    profile: "codex",
    async available() { await gate.promise; return { available: true }; },
    async start() { started = true; throw new Error("must not start"); },
  }]);
  const outcome = service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
  const rejection = Promise.allSettled([outcome]);
  const stopping = service.shutdown();
  gate.resolve();
  await stopping;
  const [result] = await rejection;
  expect(result!.status).toBe("rejected");
  if (result!.status !== "rejected") throw new Error("creation unexpectedly succeeded");
  expect(result!.reason.message).toContain("stopping");
  expect(started).toBe(false);
  expect(service.list()).toEqual([]);
});


test("shutdown owns a runtime that finishes starting late", async () => {
  const startGate = deferred();
  const entered = deferred();
  const harness = createHarness({ startGate, onStart: entered.resolve });
  const creating = harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
  const rejection = Promise.allSettled([creating]);
  await entered.promise;
  let settled = false;
  const stopping = harness.service.shutdown().then(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  startGate.resolve();
  await stopping;
  const [result] = await rejection;
  expect(result!.status).toBe("rejected");
  if (result!.status !== "rejected") throw new Error("creation unexpectedly succeeded");
  expect(result!.reason.message).toContain("stopped while starting");
  expect(harness.stopCalls()).toBe(1);
  expect(settled).toBe(true);
});


test("shutdown settles every session before propagating a cleanup failure", async () => {
  const heldStop = deferred();
  const secondEntered = deferred();
  const harness = createHarness({
    async onStop(call) {
      if (call === 1) throw new Error("first cleanup failed");
      secondEntered.resolve();
      await heldStop.promise;
    },
  });
  await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
  await harness.service.create({ profile: "codex", deviceId: DEVICE_ID, rootId: ROOT_ID });
  let settled = false;
  const stopping = harness.service.shutdown().then(
    () => { settled = true; return "unexpected success"; },
    error => { settled = true; return (error as Error).message; },
  );
  await secondEntered.promise;
  await Promise.resolve();
  expect(settled).toBe(false);
  heldStop.resolve();
  expect(await stopping).toBe("first cleanup failed");
  expect(harness.stopCalls()).toBe(2);
});
