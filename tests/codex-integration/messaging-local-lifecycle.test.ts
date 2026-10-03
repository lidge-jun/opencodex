import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MessageBudget } from "../../src/messaging/budget";
import { runMessageProcess } from "../../src/messaging/process";
import { LocalMessageRpc } from "../../src/messaging/rpc";
import { localDaemonEndpoint, localSocket } from "../../src/messaging/socket";
import { LOCAL_TARGET, localMessagingFixture, NO_REPLY } from "../helpers/messaging-local";
import { repoPath } from "../helpers/repo-root";

test("transport rejects remote URLs and unsupported platforms without opening a socket", () => {
  for (const url of ["ws://localhost:39175", "wss://example.invalid/", "unix:///tmp/socket", "ws+unix:///tmp/bad%path:/"]) {
    expect(() => localSocket(url)).toThrow("local Unix");
  }
  expect(() => localDaemonEndpoint("relative", "linux")).toThrow("cannot be addressed");
  expect(() => localDaemonEndpoint(resolve("/fixture"), "win32")).toThrow("cannot be addressed");
  expect(() => localDaemonEndpoint("/fixture:bad", "linux")).toThrow("cannot be addressed");
  expect(() => localDaemonEndpoint(`/${"x".repeat(100)}`, "linux")).toThrow("cannot be addressed");
  expect(() => localSocket(`ws+unix:///${"x".repeat(104)}:/`)).toThrow("local Unix");
});

test("importing the unactivated subsystem allocates no listener, timer, child or socket", async () => {
  const modules = ["types", "budget", "socket", "rpc", "discovery", "process", "envelope", "input", "native", "send"].map(name => repoPath("src", "messaging", `${name}.ts`));
  const script = `
    const forbidden = () => { throw new Error("unexpected messaging resource allocation"); };
    globalThis.setTimeout = forbidden;
    Bun.serve = forbidden;
    Bun.spawn = forbidden;
    globalThis.WebSocket = class { constructor() { forbidden(); } };
    for (const path of JSON.parse(process.argv[1])) await import(path);
  `;
  const child = Bun.spawn([process.execPath, "-e", script, JSON.stringify(modules)], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(errors).toBe(""); expect(output).toBe(""); expect(exitCode).toBe(0);
});

test("messaging activation is command-local, never on an ordinary proxy startup path", async () => {
  // Native parser inventory, not graph completeness: catches static/dynamic literal imports.
  const allowed = new Set(["src/cli/message-args.ts", "src/cli/message-command.ts"]);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for await (const path of new Bun.Glob("src/**/*.{ts,mts}").scan({ cwd: repoPath() })) {
    if (path.startsWith("src/messaging/") || /\.d\.(?:ts|mts)$/.test(path)) continue;
    const imports = transpiler.scanImports(readFileSync(repoPath(path), "utf8").replace(/^#![^\n]*\n/, ""));
    const incoming = imports.filter(entry => /(?:^|\/)messaging(?:\/|$)/.test(entry.path));
    if (!allowed.has(path)) expect(incoming, path).toEqual([]);
    for (const entry of imports.filter(entry => /(?:^|\/)message-(?:command|args|runtime)$/.test(entry.path))) {
      expect(["src/cli/dispatch.ts", "src/cli/message-command.ts"], path).toContain(path);
      if (path === "src/cli/dispatch.ts") {
        expect(entry.path).toBe("./message-command"); expect(entry.kind).toBe("dynamic-import");
      }
    }
  }
  expect(readFileSync(repoPath("src/cli/dispatch.ts"), "utf8")).toContain('message: async deps => (await import("./message-command")).runMessageCommand(deps.args.slice(1))');
});

describe.skipIf(process.platform === "win32")("local RPC lifecycle", () => {
  test("pending requests are capped independently of discovery's worker pool", async () => {
    const fixture = localMessagingFixture(call => call.method === "thread/read" ? NO_REPLY : undefined);
    const budget = new MessageBudget();
    const rpc = await LocalMessageRpc.connect(fixture.url, budget);
    const reads = Promise.allSettled(Array.from({ length: 4 }, () => rpc.readThread(LOCAL_TARGET)));
    try {
      await expect(rpc.readThread(LOCAL_TARGET)).rejects.toThrow("concurrency limit");
      rpc.close();
      expect((await reads).every(result => result.status === "rejected")).toBe(true);
    } finally { rpc.close(); budget.dispose(); await reads; await fixture.close(); }
  });

  test("cancellation rejects all pending requests and closes the command socket", async () => {
    const controller = new AbortController();
    const fixture = localMessagingFixture(call => call.method === "thread/read" ? NO_REPLY : undefined);
    const budget = new MessageBudget(30_000, controller.signal);
    const rpc = await LocalMessageRpc.connect(fixture.url, budget);
    try {
      const reads = Promise.allSettled([rpc.readThread(LOCAL_TARGET), rpc.readThread(LOCAL_TARGET)]);
      controller.abort();
      expect((await reads).every(result => result.status === "rejected" && result.reason.code === "cancelled")).toBe(true);
      for (let i = 0; fixture.activeConnections && i < 100; i++) await Bun.sleep(5);
      expect(fixture.activeConnections).toBe(0);
      await expect(rpc.readThread(LOCAL_TARGET)).rejects.toThrow("cancelled");
      rpc.close(); rpc.close();
    } finally { rpc.close(); budget.dispose(); await fixture.close(); }
  });

  test("an RPC timeout also rejects its pending siblings and closes the socket", async () => {
    const fixture = localMessagingFixture(call => call.method === "thread/read" ? NO_REPLY : undefined);
    const budget = new MessageBudget();
    const rpc = await LocalMessageRpc.connect(fixture.url, budget, 100);
    try {
      const settled = await Promise.allSettled([rpc.readThread(LOCAL_TARGET), rpc.readThread(LOCAL_TARGET)]);
      expect(settled.every(result => result.status === "rejected" && result.reason.code === "rpc_timeout")).toBe(true);
      for (let i = 0; fixture.activeConnections && i < 100; i++) await Bun.sleep(5);
      expect(fixture.activeConnections).toBe(0);
    } finally { rpc.close(); budget.dispose(); await fixture.close(); }
  });

  test("whole-operation deadline applies across requests and initialization", async () => {
    const fixture = localMessagingFixture(call => call.method === "initialize" ? NO_REPLY : undefined);
    const budget = new MessageBudget(150);
    try { await expect(LocalMessageRpc.connect(fixture.url, budget)).rejects.toThrow("deadline"); }
    finally { budget.dispose(); await fixture.close(); }
  });

  test("invalid JSON, binary frames and oversized frames reject all pending reads", async () => {
    for (const frame of ["not-json", new Uint8Array([1, 2]), "x".repeat(1024 * 1024 + 1)]) {
      const fixture = localMessagingFixture(call => call.method === "thread/read" ? NO_REPLY : undefined);
      const budget = new MessageBudget();
      const rpc = await LocalMessageRpc.connect(fixture.url, budget);
      try {
        const reads = Promise.allSettled([rpc.readThread(LOCAL_TARGET), rpc.readThread(LOCAL_TARGET)]);
        fixture.broadcast(frame);
        expect((await reads).every(result => result.status === "rejected" && result.reason.code === "invalid_metadata")).toBe(true);
      } finally { rpc.close(); budget.dispose(); await fixture.close(); }
    }
  });

  test("connection failure never starts a daemon or creates an absent home", async () => {
    const fixture = localMessagingFixture();
    const url = `${fixture.url.slice(0, -2)}.absent:/`;
    const budget = new MessageBudget();
    try { await expect(LocalMessageRpc.connect(url, budget)).rejects.toThrow("existing local Codex"); }
    finally { budget.dispose(); await fixture.close(); }
  });
});

describe("command-owned child runner", () => {
  test("deadline inputs are finite bounded integer milliseconds before any spawn", async () => {
    for (const timeout of [0, -1, 0.5, Infinity, NaN, 30_001]) {
      expect(() => new MessageBudget(timeout)).toThrow("deadline");
    }
    const budget = new MessageBudget();
    try {
      await expect(runMessageProcess([process.execPath, "-e", "throw new Error('must not run')"], budget,
        { timeoutMs: 20_001 })).rejects.toThrow("Helper timeout");
    } finally { budget.dispose(); }
  });

  test("bounded stdout is captured, stderr is not returned and nonzero exits are not retried", async () => {
    const budget = new MessageBudget();
    try {
      const result = await runMessageProcess([process.execPath, "-e", "console.log('once'); console.error('private fixture stderr'); process.exit(7)"], budget);
      expect(result).toEqual({ exitCode: 7, stdout: "once\n" });
    } finally { budget.dispose(); }
  });

  test("already-cancelled operations do not spawn a helper", async () => {
    const controller = new AbortController(); controller.abort();
    const budget = new MessageBudget(30_000, controller.signal);
    try { await expect(runMessageProcess([process.execPath, "-e", "throw new Error('must not run')"], budget)).rejects.toThrow("cancelled"); }
    finally { budget.dispose(); }
  });

  test.skipIf(process.platform === "win32")("timeout cleans up launcher descendants that retain inherited pipes", async () => {
    const fixture = localMessagingFixture();
    const budget = new MessageBudget();
    const pidFile = resolve(fixture.root, "helper-pid");
    const script = `
      const child = Bun.spawn([process.execPath, '-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
        { stdout: 'inherit', stderr: 'inherit' });
      await Bun.write(process.argv[1], String(child.pid));
      setInterval(()=>{},1000);
    `;
    const operation = runMessageProcess([process.execPath, "-e", script, pidFile], budget, { timeoutMs: 1000 }).catch(error => error);
    try {
      for (let i = 0; !existsSync(pidFile) && i < 100; i++) await Bun.sleep(5);
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect((await operation).code).toBe("process_incomplete");
      let live = true;
      for (let i = 0; live && i < 100; i++) {
        try {
          process.kill(pid, 0);
          // A dead orphan awaiting init's reap is terminated, not a running helper.
          if (process.platform === "linux" && /^\S+\s+\([^]*\)\s+Z\s/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))) live = false;
        } catch { live = false; }
        if (live) await Bun.sleep(5);
      }
      expect(live).toBe(false);
    } finally { budget.dispose(); await operation; await fixture.close(); }
  }, 5000);

  test("timeout joins the helper and output overflow never leaks child text in errors", async () => {
    for (const script of ["setInterval(()=>{},1000)", "process.stdout.write('x'.repeat(70000))", "process.stderr.write('x'.repeat(70000))"]) {
      const budget = new MessageBudget();
      try {
        await expect(runMessageProcess([process.execPath, "-e", script], budget, { timeoutMs: 150 })).rejects.toThrow("did not complete");
      } finally { budget.dispose(); }
    }
  });

  test.skipIf(process.platform === "win32")("timeout, cancellation and overflow bound detached descendant pipes", async () => {
    for (const cause of ["timeout", "cancel", "overflow"] as const) {
      const fixture = localMessagingFixture();
      const controller = new AbortController();
      const budget = new MessageBudget(3000, controller.signal);
      const pidFile = resolve(fixture.root, "detached-pid");
      // This fixture belongs to the test, not the runner's original process group.
      // A finite lifetime also makes the pre-fix red run safe to complete.
      const script = `
        const child = Bun.spawn([process.execPath, '-e',
          "process.on('SIGTERM',()=>{}); setTimeout(()=>process.exit(0),4000)"],
          { detached: true, stdout: 'inherit', stderr: 'inherit' });
        await Bun.write(process.argv[1], String(child.pid));
        ${cause === "overflow" ? "process.stdout.write('x'.repeat(70000));" : ""}
        setInterval(()=>{},1000);
      `;
      const started = performance.now();
      const operation = runMessageProcess([process.execPath, "-e", script, pidFile], budget,
        { timeoutMs: cause === "timeout" ? 500 : 2500 }).catch(error => error);
      let pid: number | undefined;
      try {
        for (let i = 0; !existsSync(pidFile) && i < 100; i++) await Bun.sleep(5);
        expect(existsSync(pidFile)).toBe(true);
        pid = Number(readFileSync(pidFile, "utf8"));
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        if (cause === "cancel") controller.abort();
        expect((await operation).code).toBe("process_incomplete");
        expect(performance.now() - started).toBeLessThan(2500);
        // The wrapper must not signal a detached group it does not own.
        expect(() => process.kill(pid!, 0)).not.toThrow();
      } finally {
        budget.dispose();
        await operation;
        if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, "SIGKILL"); } catch { /* Self-expiring fixture already exited. */ }
        }
        await fixture.close();
      }
    }
  }, 20_000);
});
