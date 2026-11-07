import { expect, test } from "bun:test";
import { join } from "node:path";
import { reserveRemotePort } from "../../src/messaging/remote-ports";
import { RemoteCapacity, remoteError } from "../../src/messaging/remote-contract";
import { MessageBudget } from "../../src/messaging/budget";
import { startRemoteForwardPair, type RemoteTunnelDeps } from "../../src/messaging/remote-tunnels";
import { remoteForwardFailure } from "../../src/messaging/remote-forward-failure";
import { spawnRemoteHelper } from "../../src/messaging/remote-process";

test("a pending exclusive reservation physically excludes another listener", () => {
  const first = reserveRemotePort();
  let second: ReturnType<typeof reserveRemotePort> | undefined;
  try {
    expect(() => Bun.listen({ hostname: "127.0.0.1", port: first.port, exclusive: true,
      socket: { data(socket) { socket.end(); } } })).toThrow();
    second = reserveRemotePort();
    expect(second.port).not.toBe(first.port);
  } finally { first.release(); second?.release(); }
});

test("only post-bind SSH receipts confirm forwards, including byte-split remote confirmations", () => {
  for (const direction of ["L", "R"] as const) {
    let ready = 0;
    const state = remoteForwardFailure(["ssh", "-o", "ExitOnForwardFailure=yes", `-${direction}`,
      "127.0.0.1:23456:127.0.0.1:34567"], () => { ready++; });
    state.write(new TextEncoder().encode("debug1: Local forwarding listening on 127.0.0.1 port 23456.\n"));
    state.write(new TextEncoder().encode("debug1: remote forward success for: listen 127.0.0.1:234560, connect 127.0.0.1:34567\n"));
    state.write(new TextEncoder().encode("debug1: remote forward success for: listen 127.0.0.1:23456, connect 127.0.0.1:345670\n"));
    expect(state.ready).toBe(false); expect(ready).toBe(0);
    const success = direction === "L" ? "debug1: Entering interactive session.\r\n"
      : "debug1: remote forward success for: listen 127.0.0.1:23456, connect 127.0.0.1:34567\r\n";
    for (const byte of new TextEncoder().encode(success)) state.write(Uint8Array.of(byte));
    expect(state.ready).toBe(true); expect(ready).toBe(1); expect(state.failed).toBe(false);
  }
});

test("owned SSH forwards request diagnostic receipts without returning their diagnostic output", async () => {
  const capacity = new RemoteCapacity();
  let spawned: readonly string[] = [];
  const helper = spawnRemoteHelper(["ssh", "-o", "LogLevel=ERROR", "-o", "ExitOnForwardFailure=yes", "-L",
    "127.0.0.1:23456:127.0.0.1:34567"], capacity, undefined, undefined, {}, {
    spawn(argv) {
      spawned = argv;
      return { pid: 12345, exitCode: 0, exited: Promise.resolve(0),
        stdout: new ReadableStream({ start(controller) { controller.close(); } }),
        stderr: new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode("private fixture diagnostic\ndebug1: Entering interactive session.\n"));
          controller.close();
        } }), stdin: { write: () => 0, end: () => 0 } };
    }, signalGroup() { throw new Error("exited process"); },
  });
  try {
    expect(spawned.slice(0, 3)).toEqual(["ssh", "-o", "LogLevel=DEBUG1"]);
    await helper.forwardReady;
    expect(await helper.output).toBe("");
  } finally { await helper.close(); }
  expect(capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
});

test("pending local reservations stay distinct through socket handoff and release exactly once", () => {
  const stopped: number[] = [], ports = [23456, 23456, 23457];
  const allocate = () => {
    const port = ports.shift()!;
    return { port, stop() { stopped.push(port); } };
  };
  const first = reserveRemotePort(allocate);
  expect(stopped).toEqual([]);
  first.handoff();
  const second = reserveRemotePort(allocate);
  try {
    expect(first.port).not.toBe(second.port);
    expect(stopped).toEqual([23456, 23456]);
    first.release(); first.release(); second.release(); second.release();
    expect(stopped).toEqual([23456, 23456, 23457]);
    const reused = reserveRemotePort(() => ({ port: 23456, stop() {} }));
    reused.release();
  } finally { first.release(); second.release(); }
});

test("an allocator repeatedly offering a pending port is bounded and cannot steal the claim", () => {
  const first = reserveRemotePort(() => ({ port: 23456, stop() {} }));
  let allocations = 0, stops = 0;
  try {
    expect(() => reserveRemotePort(() => { allocations++; return { port: first.port, stop() { stops++; } }; }))
      .toThrow("distinct");
    expect(allocations).toBe(8); expect(stops).toBe(8);
  } finally { first.release(); }
});

const options = { ssh: "fixture", knownHosts: join(process.cwd(), ".tmp", "fixture.known_hosts"), peerPort: 34567, ownerPort: 45678 };
function forwardFixture(direction: "L" | "R", failures: number, forwardFailed = true) {
  const events: string[] = [], localPorts: number[] = [], remotePorts: number[] = [];
  let runs = 0, allocated = 0, closed = 0, handedOff = false;
  const deps: RemoteTunnelDeps = {
    async run() { runs++; return JSON.stringify({ port: 25000 + runs }); },
    allocatePort() {
      const port = 24000 + ++allocated;
      handedOff = false; localPorts.push(port);
      return { port, stop() { handedOff = true; events.push(`handoff:${port}`); } };
    },
    spawn(argv) {
      const kind = argv.includes("-L") ? "L" : "R";
      expect(handedOff).toBe(true);
      expect(argv).toContain("ExitOnForwardFailure=yes");
      if (kind === "R") remotePorts.push(Number(argv[argv.indexOf("-R") + 1]!.split(":")[1]));
      events.push(`spawn:${runs}:${kind}`);
      const failed = kind === direction && runs <= failures;
      let finish!: (code: number) => void, closing = false;
      const exited = failed ? Promise.resolve(255) : new Promise<number>(resolve => { finish = resolve; });
      const forwardReady = failed ? Promise.reject(remoteError(forwardFailed ? "forward_port_lost" : "ssh_failed", "fixture forward failed")) : Promise.resolve();
      return { pid: 0, exited, output: Promise.resolve(""), forwardReady, forwardFailed: failed && forwardFailed, async close() {
        if (closing) return;
        closing = true; closed++; events.push(`close:${runs}:${kind}`);
        if (!failed) finish(0);
      } };
    },
    async inspect() { return true; },
  };
  return { deps, events, localPorts, remotePorts, get runs() { return runs; }, get closed() { return closed; } };
}

for (const direction of ["L", "R"] as const) {
  test(`lost ${direction} candidate reselects both ports only after joining the failed pair`, async () => {
    const fixture = forwardFixture(direction, 1), budget = new MessageBudget(), capacity = new RemoteCapacity();
    try {
      const pair = await startRemoteForwardPair(options, budget, capacity, new AbortController().signal, fixture.deps);
      try {
        expect(fixture.runs).toBe(2); expect(fixture.closed).toBe(2);
        expect(fixture.localPorts).toEqual([24001, 24002]); expect(fixture.remotePorts).toEqual([25001, 25002]);
        expect(fixture.events.indexOf("close:1:R")).toBeLessThan(fixture.events.indexOf("spawn:2:L"));
        expect(pair.localPort).toBe(24002); expect(pair.returnPort).toBe(25002); expect(pair.alive).toBe(true);
      } finally { await pair.close(); }
      expect(fixture.closed).toBe(4);
    } finally { budget.dispose(); }
  });
}

test("three explicit forward failures exhaust setup without leaking an owned pair", async () => {
  const fixture = forwardFixture("R", Infinity), budget = new MessageBudget();
  try {
    await expect(startRemoteForwardPair(options, budget, new RemoteCapacity(), new AbortController().signal, fixture.deps))
      .rejects.toMatchObject({ code: "forward_port_lost" });
    expect(fixture.runs).toBe(3); expect(fixture.closed).toBe(6);
  } finally { budget.dispose(); }
});

test("an SSH authentication or generic exit failure does not reselect a port", async () => {
  const fixture = forwardFixture("L", Infinity, false), budget = new MessageBudget();
  try {
    await expect(startRemoteForwardPair(options, budget, new RemoteCapacity(), new AbortController().signal, fixture.deps))
      .rejects.toMatchObject({ code: "ssh_failed" });
    expect(fixture.runs).toBe(1); expect(fixture.closed).toBe(2);
  } finally { budget.dispose(); }
});

test("cancellation after losing a candidate prevents reselection", async () => {
  const fixture = forwardFixture("R", 1), controller = new AbortController(), budget = new MessageBudget();
  const spawn = fixture.deps.spawn!;
  fixture.deps.spawn = (...args) => {
    const helper = spawn(...args), close = helper.close;
    return { ...helper, async close() { await close(); controller.abort(); } };
  };
  try {
    await expect(startRemoteForwardPair(options, budget, new RemoteCapacity(), controller.signal, fixture.deps))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(fixture.runs).toBe(1); expect(fixture.closed).toBe(2);
  } finally { budget.dispose(); }
});

test("an occupied loopback candidate cannot pass inspection before both SSH bind receipts", async () => {
  const fixture = forwardFixture("L", 0), budget = new MessageBudget();
  let release!: () => void, spawned!: () => void, inspections = 0;
  const receipts = new Promise<void>(resolve => { release = resolve; });
  const bothSpawned = new Promise<void>(resolve => { spawned = resolve; });
  const spawn = fixture.deps.spawn!;
  fixture.deps.spawn = (...args) => {
    const helper = spawn(...args);
    if (args[0].includes("-R")) spawned();
    return { ...helper, forwardReady: receipts };
  };
  fixture.deps.inspect = async () => { inspections++; return true; };
  const pending = startRemoteForwardPair(options, budget, new RemoteCapacity(), new AbortController().signal, fixture.deps);
  try {
    await bothSpawned;
    expect(inspections).toBe(0);
    release();
    const pair = await pending;
    try { expect(inspections).toBe(1); } finally { await pair.close(); }
  } finally { release(); budget.dispose(); }
});

test("loopback inspection failure is joined and never treated as a lost candidate", async () => {
  const fixture = forwardFixture("L", 0), budget = new MessageBudget();
  fixture.deps.inspect = async () => { throw remoteError("inspection_failed", "fixture inspection failed"); };
  try {
    await expect(startRemoteForwardPair(options, budget, new RemoteCapacity(), new AbortController().signal, fixture.deps))
      .rejects.toMatchObject({ code: "inspection_failed" });
    expect(fixture.runs).toBe(1); expect(fixture.closed).toBe(2);
  } finally { budget.dispose(); }
});

test("a remote helper repeatedly offering the same lost port is bounded without respawning it", async () => {
  const fixture = forwardFixture("R", 1), budget = new MessageBudget();
  let runs = 0;
  const run = fixture.deps.run!;
  fixture.deps.run = async (...args) => { runs++; await run(...args); return JSON.stringify({ port: 25001 }); };
  // The remote candidate is the same on every offer; only the first pair may be spawned.
  try {
    await expect(startRemoteForwardPair(options, budget, new RemoteCapacity(), new AbortController().signal, fixture.deps))
      .rejects.toMatchObject({ code: "forward_port_lost" });
    expect(runs).toBe(3); expect(fixture.localPorts).toHaveLength(1); expect(fixture.closed).toBe(2);
  } finally { budget.dispose(); }
});
