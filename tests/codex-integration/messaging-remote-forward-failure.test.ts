import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { remotePortCandidate } from "../../src/messaging/remote-ports";
import { RemoteCapacity } from "../../src/messaging/remote-contract";
import { spawnRemoteHelper } from "../../src/messaging/remote-process";
import { MessageBudget } from "../../src/messaging/budget";
import { remoteError } from "../../src/messaging/remote-contract";
import { startRemoteForwardPair, type RemoteTunnelDeps } from "../../src/messaging/remote-tunnels";

test("remote candidate allocation requests an exclusive listener", () => {
  const listen = spyOn(Bun, "listen");
  try {
    remotePortCandidate();
    expect(listen.mock.calls[0]![0]).toMatchObject({ hostname: "127.0.0.1", port: 0, exclusive: true });
  } finally { listen.mockRestore(); }
});

for (const [direction, diagnostic, detected] of [
  ["L", "channel_setup_fwd_listener_tcpip: cannot listen to port: 23456\r\nCould not request local forwarding.\r\n", true],
  ["R", "Error: remote port forwarding failed for listen port 23456\r\n", true],
  ["R", "Error: remote port forwarding failed for listen port 23456\n", true],
  ["R", "Error: remote port forwarding failed for listen port 234560\n", false],
  ["R", "Permission denied (publickey).\n", false],
] as const) {
  test(`SSH ${direction} diagnostic ${JSON.stringify(diagnostic)} is classified without returning stderr`, async () => {
    const capacity = new RemoteCapacity();
    const helper = spawnRemoteHelper(["ssh", "-o", "ExitOnForwardFailure=yes", `-${direction}`,
      "127.0.0.1:23456:127.0.0.1:34567"], capacity, undefined, undefined, {}, {
      spawn: () => ({ pid: 12345, exitCode: 255, exited: Promise.resolve(255),
        stdout: new ReadableStream({ start(controller) { controller.close(); } }),
        stderr: new ReadableStream({ start(controller) {
          for (const byte of new TextEncoder().encode(`private diagnostic\n${diagnostic}`)) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        } }), stdin: { write: () => 0, end: () => 0 } }),
      signalGroup() { throw new Error("an exited helper must not be signalled"); },
    });
    try {
      expect(await helper.output).toBe("");
      expect((helper as typeof helper & { forwardFailed?: boolean }).forwardFailed === true).toBe(detected);
    } finally { await helper.close(); }
    expect(capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
  });
}

type RaceMode = "recover" | "exhaust" | "input" | "independent" | "cleanup" | "cancel" | "missing-marker";
const forwardOptions = { ssh: "fixture", knownHosts: join(process.cwd(), ".tmp", "fixture.known_hosts"), peerPort: 34567, ownerPort: 45678 };
function delayedBindFixture(failedDirection: "L" | "R", mode: RaceMode) {
  let runs = 0, allocations = 0, inspections = 0, siblingRejections = 0;
  let finishDiagnostic!: () => void;
  const events: string[] = [], capacity = new RemoteCapacity(), owner = new AbortController();
  const deps: RemoteTunnelDeps = {
    async run() {
      if (runs) expect(capacity.snapshot().helpers).toBe(0);
      return JSON.stringify({ port: 25000 + ++runs });
    },
    allocatePort() { return { port: 24000 + ++allocations, stop() {} }; },
    async inspect() { inspections++; expect(runs).toBe(2); return true; },
    spawn(argv, caps, signal) {
      const direction = argv.includes("-L") ? "L" : "R", attempt = runs;
      const failingAttempt = attempt === 1 || mode === "exhaust";
      const initiating = failingAttempt && direction === failedDirection;
      const sibling = failingAttempt && !initiating;
      let code: number | null = initiating || (sibling && mode === "independent") ? 255 : null;
      let finish!: (value: number) => void;
      const exited = new Promise<number>(resolve => { finish = resolve; });
      if (code !== null) finish(code);
      let stdout!: ReadableStreamDefaultController<Uint8Array>, stderr!: ReadableStreamDefaultController<Uint8Array>;
      const port = argv[argv.indexOf(`-${direction}`) + 1]!.split(":")[1];
      const helper = spawnRemoteHelper(argv, caps, signal, undefined, {}, {
        spawn() { return { pid: direction === "L" ? 12345 : 12346, get exitCode() { return code; }, exited,
          stdout: new ReadableStream({ start(controller) { stdout = controller; } }),
          stderr: new ReadableStream({ start(controller) {
            stderr = controller;
            if (!failingAttempt) controller.enqueue(new TextEncoder().encode(direction === "L"
              ? "debug1: Entering interactive session.\r\n"
              : `debug1: remote forward success for: listen 127.0.0.1:${port}, connect 127.0.0.1:45678\r\n`));
          } }),
          stdin: { write() { return 0; }, end() {
            if (sibling && mode === "input") throw new Error("private fixture input failure");
            return 0;
          } },
        }; },
        signalGroup() { code = 143; stdout.close(); stderr.close(); finish(143); },
      });
      if (initiating) finishDiagnostic = () => {
        events.push(`diagnostic:${attempt}`);
        if (mode !== "missing-marker") stderr.enqueue(new TextEncoder().encode(direction === "L"
          ? "Could not request local forwarding.\r\n"
          : `Error: remote port forwarding failed for listen port ${port}\r\n`));
        stderr.close(); stdout.close();
      };
      if (sibling) {
        if (code !== null) { stdout.close(); stderr.close(); }
        void helper.forwardReady.catch(() => {
          siblingRejections++; events.push(`sibling-rejected:${attempt}`);
          if (mode === "cancel") owner.abort();
          finishDiagnostic();
        });
      }
      const close = helper.close;
      helper.close = async () => {
        await close(); events.push(`closed:${attempt}:${direction}`);
        if (sibling && mode === "cleanup") throw remoteError("cleanup_incomplete", "fixture cleanup failed");
      };
      return helper;
    },
  };
  return { deps, capacity, owner, events, get runs() { return runs; }, get inspections() { return inspections; },
    get siblingRejections() { return siblingRejections; } };
}

for (const direction of ["L", "R"] as const) for (const mode of ["recover", "exhaust"] as const) {
  test(`delayed ${direction} bind diagnostic survives sibling rejection (${mode})`, async () => {
    const fixture = delayedBindFixture(direction, mode), budget = new MessageBudget();
    try {
      const pending = startRemoteForwardPair(forwardOptions,
        budget, fixture.capacity, fixture.owner.signal, fixture.deps);
      if (mode === "recover") {
        const pair = await pending;
        try {
          expect(pair.alive).toBe(true); expect(pair.localPort).toBe(24002); expect(pair.returnPort).toBe(25002);
          expect(fixture.runs).toBe(2); expect(fixture.inspections).toBe(1);
        } finally { await pair.close(); }
      } else {
        await expect(pending).rejects.toMatchObject({ code: "forward_port_lost" });
        expect(fixture.runs).toBe(3); expect(fixture.inspections).toBe(0);
      }
      expect(fixture.siblingRejections).toBe(mode === "recover" ? 1 : 3);
      expect(fixture.events.indexOf("sibling-rejected:1")).toBeLessThan(fixture.events.indexOf("diagnostic:1"));
      expect(fixture.capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
    } finally { budget.dispose(); }
  });
}

for (const [mode, code] of [["input", "ssh_incomplete"], ["independent", "ssh_failed"],
  ["cleanup", "cleanup_incomplete"], ["cancel", "cancelled"], ["missing-marker", "ssh_failed"]] as const) {
  test(`a delayed bind marker cannot hide ${mode} failure`, async () => {
    const fixture = delayedBindFixture("L", mode), budget = new MessageBudget();
    try {
      await expect(startRemoteForwardPair(forwardOptions,
        budget, fixture.capacity, fixture.owner.signal, fixture.deps)).rejects.toMatchObject({ code });
      expect(fixture.runs).toBe(1); expect(fixture.inspections).toBe(0); expect(fixture.siblingRejections).toBe(1);
      expect(fixture.capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
    } finally { budget.dispose(); }
  });
}
