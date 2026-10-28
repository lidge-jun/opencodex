import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createLocalAttestationSecret } from "../../src/lib/local-management-attestation";
import { removeRuntimePort, writeRuntimePort } from "../../src/config/process-state";
import { markSiblingStart, resetSiblingStartForTests, withSiblingMarker } from "../../src/codex/sibling-start";
import { issueSiblingHandoff } from "../../src/codex/sibling-handoff";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { watchdogMs } from "../helpers/ci-watchdog";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import {
  inspectServiceStateRecords,
  selectAuthoritativeServiceState,
  serviceStatePathsForHomes,
} from "../../src/service/state-record.mjs";

// Every wait here is bounded by a real `ocx start` child coming up: spawning Bun,
// binding a port, and writing its runtime record. That is intrinsic to the
// assertion, so the bound stays -- but a fixed 10s is a latency assertion on the
// Windows leg, where four Bun pools share one runner. "timed out waiting for
// owner runtime record" at 10.2s was that, not a journal-ownership defect.
const OWNER_WAIT_MS = watchdogMs(10_000);

// The surrounding budget has to clear the internal deadline, or the test dies on a
// timeout before its own wait can report which step stalled -- the failure mode
// test-budget.ts warns about. Each case performs up to four sequential bounded
// waits (owner runtime record, owner health, and two CLI children), so the budget
// is derived from the deadline rather than pinned next to it.
const JOURNAL_OWNERSHIP_BUDGET_MS = Math.max(30_000, OWNER_WAIT_MS * 4);

const cliPath = repoPath("src/cli/index.ts");
const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];

type Fixture = {
  root: string;
  codexHome: string;
  ocxHome: string;
  configPath: string;
  journalPath: string;
  pidPath: string;
  env: Record<string, string>;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ocx-start-owner-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const ocxHome = join(root, "ocx");
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  for (const path of [codexHome, ocxHome, home, runtime]) mkdirSync(path, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  const journalPath = join(codexHome, "opencodex-journal.json");
  const pidPath = join(ocxHome, "ocx.pid");
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
    port: 0,
    hostname: "127.0.0.1",
    codexAutoStart: false,
    syncResumeHistory: false,
    clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
    claudeCode: { systemEnv: false },
    providers: {},
    defaultProvider: "openai",
  }));
  return {
    root,
    codexHome,
    ocxHome,
    configPath,
    journalPath,
    pidPath,
    env: {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: ocxHome,
      XDG_RUNTIME_DIR: runtime,
      NO_PROXY: "127.0.0.1,localhost",
    },
  };
}

function arrangeRecoverableJournal(fx: Fixture): { original: string; injected: string } {
  const original = '# original\nmodel_provider = "openai"\n';
  const injected = '# injected\nmodel_provider = "opencodex"\n';
  writeFileSync(fx.configPath, injected);
  writeFileSync(fx.journalPath, JSON.stringify({
    version: 1,
    originalConfig: Buffer.from(original).toString("base64"),
    originalProfile: null,
    injectedConfigHash: createHash("sha256").update(injected).digest("hex"),
    injectedProfileHash: null,
    pid: 999_999,
    timestamp: new Date().toISOString(),
  }));
  return { original, injected };
}

async function runCli(fx: Fixture, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cliPath, ...argv], {
    cwd: fx.root,
    env: fx.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const completed = await Promise.race([
    Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`CLI watchdog: ocx ${argv.join(" ")}`)), OWNER_WAIT_MS)),
  ]);
  return { exitCode: completed[0], stdout: completed[1], stderr: completed[2] };
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + OWNER_WAIT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startOwner(fx: Fixture): Promise<ReturnType<typeof Bun.spawn>> {
  const child = Bun.spawn([process.execPath, cliPath, "start"], {
    cwd: fx.root,
    env: fx.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const runtimePath = join(fx.ocxHome, "runtime-port.json");
  const runtime = await waitFor(() => {
    if (!existsSync(runtimePath)) return null;
    try {
      const value = JSON.parse(readFileSync(runtimePath, "utf8")) as { pid?: number; port?: number };
      return value.pid === child.pid && typeof value.port === "number" && value.port > 0 ? value : null;
    } catch {
      return null;
    }
  }, "owner runtime record");
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/healthz`, { signal: AbortSignal.timeout(500) });
      const body = await response.json() as { pid?: number };
      return response.ok && body.pid === child.pid ? true : null;
    } catch {
      return null;
    }
  }, "owner health");
  return child;
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  while (children.length) {
    const child = children.pop()!;
    if (child.exitCode === null) await child.exited;
  }
  while (roots.length) removeTreeWithRetry(roots.pop()!);
});

describe("start and ensure journal ownership (#1230)", () => {
  for (const scenario of ["start", "ensure", "service", "supervised", "sibling", "restart-parent"] as const) {
    test(`a missed first owner probe preserves shared state for ${scenario} (#7827)`, async () => {
      const fx = fixture();
      const { injected } = arrangeRecoverableJournal(fx);
      writeFileSync(fx.pidPath, "4242");
      const journal = readFileSync(fx.journalPath, "utf8");
      const cli = readFileSync(cliPath, "utf8");
      // Same command-body injection seam as the ensure integration tests. Only IO is
      // supplied; both command ordering and real journal restoration execute in the child.
      const bodies = cli.slice(cli.indexOf("async function findProxyOwnerBeforeJournalRecovery("), cli.indexOf("function detachedStartEnvironment("))
        + cli.slice(cli.indexOf("async function handleEnsure("), cli.indexOf("async function handleTrayProxyStart("));
      const recovery = readFileSync(repoPath("src/cli/start-owner-fence.ts"), "utf8");
      const recheck = recovery.slice(recovery.indexOf("export async function recoverStartJournalAfterOwnerRecheck("), recovery.indexOf("/** Hold ownership stable"));
      const executable = new Bun.Transpiler({ loader: "ts" }).transformSync(bodies + recheck.replace("export ", ""));
      const script = join(fx.root, "missed-owner.ts");
      writeFileSync(script, `
        import { reconcileStartupJournal } from ${JSON.stringify(repoPath("src/cli/cross-home-owner.ts"))};
        import { recoverStartStateUnderOwnershipLease } from ${JSON.stringify(repoPath("src/cli/start-owner-fence.ts"))};
        import { decideStartWithLiveOwner } from ${JSON.stringify(repoPath("src/cli/dispatch.ts"))};
        import { START_OWNERSHIP_LIVENESS } from ${JSON.stringify(repoPath("src/server/proxy-liveness.ts"))};
        import { readFileSync, existsSync, unlinkSync } from "node:fs";
        const events = [];
        const scenario = ${JSON.stringify(scenario)};
        let probes = 0, leased = false, sibling = false;
        const live = { pid: 4242, port: 10100, hostname: "127.0.0.1" };
        class StartCommandExit extends Error { constructor(readonly exitCode) { super("exit"); } }
        const fakeProcess = { env: { OCX_SERVICE: ["service", "supervised"].includes(scenario) ? "1" : undefined },
          exitCode: 0, exit(code) { throw new StartCommandExit(code); } };
        const deps = {
          process: fakeProcess, console: { log() {}, warn() {}, error() {} }, StartCommandExit,
          START_OWNERSHIP_LIVENESS, decideStartWithLiveOwner, recoverStartStateUnderOwnershipLease,
          findLiveProxy: async budget => {
            if (budget !== START_OWNERSHIP_LIVENESS) throw new Error("changed liveness budget");
            events.push("probe:" + (++probes) + ":" + leased);
            return probes === 1 ? null : live;
          },
          observeProxyLiveness: async budget => {
            if (budget !== START_OWNERSHIP_LIVENESS) throw new Error("changed liveness budget");
            events.push("probe:" + (++probes) + ":" + leased);
            return { kind: "live", live };
          },
          readPidFileValue: () => existsSync(${JSON.stringify(fx.pidPath)}) ? Number(readFileSync(${JSON.stringify(fx.pidPath)}, "utf8")) : null,
          readRuntimePort: () => ({ pid: 4242, port: 10100 }),
          removePidIfValueIs: pid => { events.push("pid-remove"); if (pid === 4242) unlinkSync(${JSON.stringify(fx.pidPath)}); },
          acquireOwnershipMutationLease: () => { leased = true; events.push("lease"); return { release() { leased = false; events.push("release"); } }; },
          serviceStatePaths: () => ({}),
          serviceChildOwnershipDecisionForClassifiedChild: () => ({ kind: "proceed" }),
          isSupervisedServiceChild: () => scenario === "supervised", serviceStayOutExitCode: () => 0,
          forgetUpdateTeardownHandover() {}, updateRestartChild: null,
          startupDataPlaneToken: () => null, isApiAuthRequired: () => false, loadConfig: () => ({}),
          parseStartCliOptions: () => ({ port: scenario === "sibling" ? 10101 : undefined }),
          honorSiblingMarker: () => null, consumeSiblingHandoff() {},
          takeRestartHandoffMarkers: () => scenario === "restart-parent" ? 4242 : null,
          probeOwnerPastRestartParent: probe => probe(),
          duplicateRuntimeMessage: () => "Proxy already running",
          markSiblingStart: () => { sibling = true; events.push("sibling"); },
          markCrossHomeSibling: async () => { events.push("cross-home"); return false; },
          markLiveHomeSibling: async () => { events.push("live-home"); return false; },
          reconcileStartupJournal: () => { events.push("recover"); reconcileStartupJournal(); },
          readClientConnectionState: () => ({ kind: "disconnected" }), inspectClientRotationRecoveryGate: () => ({}),
          deferServiceChildToNewerRuntime: async () => null, packageVersion: () => "test", currentServingCommand: () => [],
          maybeShowUpdatePrompt: async () => {},
          bindAndPublishStartOwnership: async deps => deps.bind(),
          chooseListenPort: () => { throw new Error("sibling reached bind"); },
          codexAutoStartEnabled: () => false,
        };
        const commands = new Function(...Object.keys(deps), ${JSON.stringify(executable)} + "; return { handleStart, handleEnsure };")(...Object.values(deps));
        try { await (scenario === "ensure" ? commands.handleEnsure() : commands.handleStart({ block: false })); }
        catch (error) {
          if (error instanceof StartCommandExit) fakeProcess.exitCode = error.exitCode;
          else if (error.message !== "sibling reached bind") throw error;
        }
        console.log(JSON.stringify({ events, probes, sibling, exitCode: fakeProcess.exitCode }));
      `);
      const child = Bun.spawn([process.execPath, script], { env: fx.env, stdout: "pipe", stderr: "pipe" });
      children.push(child);
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout) as { events: string[]; probes: number; sibling: boolean; exitCode: number };
      expect(readFileSync(fx.configPath, "utf8"), JSON.stringify(result)).toBe(injected);
      expect(existsSync(fx.journalPath)).toBe(true);
      expect(readFileSync(fx.journalPath, "utf8")).toBe(journal);
      expect(readFileSync(fx.pidPath, "utf8")).toBe("4242");
      expect(result.events).not.toContain("recover");
      expect(result.events).not.toContain("pid-remove");
      expect(result.events.slice(0, 4)).toEqual(["probe:1:false", "lease", "probe:2:true", "release"]);
      expect(result.exitCode).toBe(["start", "restart-parent"].includes(scenario) ? 1 : 0);
      expect(result.sibling).toBe(scenario === "sibling");
    }, JOURNAL_OWNERSHIP_BUDGET_MS);
  }

  test("startup preserves only a client journal matching the final committed api key id", async () => {
    for (const matches of [true, false]) {
      const fx = fixture();
      const original = '# original client baseline\nmodel_provider = "openai"\n';
      const injected = '# connected remote routing\nmodel_provider = "opencodex"\n';
      writeFileSync(fx.configPath, injected);
      writeFileSync(join(fx.ocxHome, "config.json"), JSON.stringify({
        port: 0,
        providers: {},
        defaultProvider: "openai",
        runtimeRole: "client",
        client: {
          serverUrl: "https://hub.example.test",
          managementUrl: "https://hub.example.test",
          managementTransport: "direct",
          selectedClients: ["codex"],
          tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
          apiKeyId: matches ? "client-key-1" : "different-key",
          tokenFingerprint: "a".repeat(64),
          protocolVersion: 1,
          connectedAt: "2026-08-28T00:00:00.000Z",
        },
      }));
      writeFileSync(fx.journalPath, JSON.stringify({
        version: 1,
        originalConfig: Buffer.from(original).toString("base64"),
        originalProfile: null,
        injectedConfigHash: createHash("sha256").update(injected).digest("hex"),
        injectedProfileHash: null,
        owner: { kind: "client", apiKeyId: "client-key-1" },
        pid: 999_999,
        timestamp: new Date().toISOString(),
      }));

      const child = Bun.spawn([process.execPath, cliPath, "start"], {
        cwd: fx.root,
        env: fx.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      const runtimePath = join(fx.ocxHome, "runtime-port.json");
      const runtime = await waitFor(async () => {
        if (!existsSync(runtimePath)) {
          if (child.exitCode === null) return null;
          const [stdout, stderr] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          throw new Error(`connected client exited ${child.exitCode}: ${stderr || stdout}`);
        }
        try {
          const value = JSON.parse(readFileSync(runtimePath, "utf8")) as { pid?: number; port?: number; hostname?: string };
          return value.pid === child.pid && typeof value.port === "number" && value.port > 0 ? value : null;
        } catch { return null; }
      }, "connected client runtime record");
      try {
        const health = await fetch(`http://127.0.0.1:${runtime.port}/healthz`).then(response => response.json()) as { role?: string };
        expect(health.role).toBe("client");
        expect(runtime.hostname).toBe("127.0.0.1");
        expect((await fetch(`http://127.0.0.1:${runtime.port}/v1/models`)).status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${runtime.port}/api/config`)).status).toBe(404);
        expect(readFileSync(fx.configPath, "utf8")).toBe(matches ? injected : original);
        expect(existsSync(fx.journalPath)).toBe(matches);
      } finally {
        child.kill("SIGTERM");
        await child.exited;
      }
    }
  }, 30_000);

  test("a healthy proxy owner preserves the journal for both start and ensure", async () => {
    const fx = fixture();
    const owner = await startOwner(fx);
    try {
      const { injected } = arrangeRecoverableJournal(fx);

      const start = await runCli(fx, ["start"]);
      expect(start.exitCode).toBe(1);
      expect(start.stderr).toContain("Proxy already running");
      expect(readFileSync(fx.configPath, "utf8")).toBe(injected);
      expect(existsSync(fx.journalPath)).toBe(true);

      const ensure = await runCli(fx, ["ensure"]);
      expect(ensure.exitCode).toBe(0);
      expect(ensure.stdout).toContain("Codex autostart is disabled");
      expect(readFileSync(fx.configPath, "utf8")).toBe(injected);
      expect(existsSync(fx.journalPath)).toBe(true);
      expect(readFileSync(fx.pidPath, "utf8")).toBe(String(owner.pid));
    } finally {
      owner.kill("SIGTERM");
      await owner.exited;
    }
  }, JOURNAL_OWNERSHIP_BUDGET_MS);

  test("a dead owner is recovered and its stale PID is removed for both start and ensure", async () => {
    for (const command of ["start", "ensure"] as const) {
      const fx = fixture();
      const { original } = arrangeRecoverableJournal(fx);
      writeFileSync(fx.pidPath, "999999");

      if (command === "ensure") {
        const result = await runCli(fx, [command]);
        expect(result.exitCode).toBe(0);
      } else {
        const child = Bun.spawn([process.execPath, cliPath, command], {
          cwd: fx.root,
          env: fx.env,
          stdout: "pipe",
          stderr: "pipe",
        });
        try {
          await waitFor(
            () => !existsSync(fx.journalPath) && existsSync(fx.configPath) && readFileSync(fx.configPath, "utf8") === original ? true : null,
            "dead-owner journal recovery",
          );
        } finally {
          child.kill("SIGTERM");
          await child.exited;
        }
      }

      expect(readFileSync(fx.configPath, "utf8")).toBe(original);
      expect(existsSync(fx.journalPath)).toBe(false);
      expect(existsSync(fx.pidPath)).toBe(false);
    }
  }, JOURNAL_OWNERSHIP_BUDGET_MS);
});

// Owner up, then three sibling starts with readiness, two `ocx stop`s and the exits between them:
// ten bounded waits in series plus the exits, each normally well under a second.
const SIBLING_ROUTING_BUDGET_MS = Math.max(90_000, OWNER_WAIT_MS * 12);

function freeLoopbackPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/**
 * Spawn `ocx start` and wait for its runtime record and settled readiness.
 *
 * `port` pins the listener with `--port`. A pinned port comes from freeLoopbackPort(), which
 * releases its probe before the child binds, so another process on the runner can take it in
 * between; a hard-pinned start then waits out port reclaim (up to 60 s) before it binds and
 * publishes, which outlasts OWNER_WAIT_MS with the child alive and no record. Pass `undefined`
 * when the case does not need a predetermined port: the child keeps config.port and binds its
 * own, and the runtime record supplies the port it chose.
 */
async function startSibling(
  env: Record<string, string>,
  siblingHome: string,
  port: number | undefined,
  cwd: string,
): Promise<{ child: ReturnType<typeof Bun.spawn>; runtime: { pid: number; port: number; siblingOfPort?: number } }> {
  const child = Bun.spawn([process.execPath, cliPath, "start", ...(port === undefined ? [] : ["--port", String(port)])], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const runtimePath = join(siblingHome, "runtime-port.json");
  // Allowlisted fields only: the record also carries the per-process attestationSecret.
  let lastRecord: string | null = null;
  let exitedEarly = false;
  let runtime: { pid: number; port: number; siblingOfPort?: number };
  try {
    runtime = await waitFor(async () => {
      if (child.exitCode !== null) {
        exitedEarly = true;
        throw new Error(`sibling exited ${child.exitCode}: ${await new Response(child.stderr).text()}`);
      }
      if (!existsSync(runtimePath)) return null;
      try {
        const value = JSON.parse(readFileSync(runtimePath, "utf8")) as { pid: number; port: number; hostname?: string; siblingOfPort?: number };
        lastRecord = JSON.stringify({ pid: value.pid, port: value.port, hostname: value.hostname, siblingOfPort: value.siblingOfPort });
        const portOk = Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
          && (port === undefined || value.port === port);
        return value.pid === child.pid && portOk ? value : null;
      } catch {
        return null;
      }
    }, "sibling runtime record");
  } catch (error) {
    // An early exit already reported its stderr and consumed the stream.
    if (exitedEarly) throw error;
    // Report what the child was doing, which the bare deadline message cannot.
    if (child.exitCode === null) child.kill("SIGKILL");
    const tail = async (stream: unknown): Promise<string> => {
      try {
        return await Promise.race([
          new Response(stream as ReadableStream<Uint8Array>).text().then(text => text.slice(-4000)),
          Bun.sleep(2000).then(() => "<no EOF within 2s>"),
        ]);
      } catch {
        return "<unreadable>";
      }
    };
    const [stdout, stderr] = await Promise.all([tail(child.stdout), tail(child.stderr)]);
    throw new Error(
      `${(error as Error).message} (requested port ${port ?? "config"}, pid ${child.pid}, last record ${lastRecord ?? "none"})\n`
        + `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
  const readyPort = runtime.port;
  // /readyz settles after the startup sync. Without the sibling gate that sync is exactly
  // what rewrote the shared config.toml, so the bytes are compared only once it has settled,
  // and it has to settle as "ready": a sibling that wrote nothing has nothing to fail.
  let settled: string | undefined;
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${readyPort}/readyz`, { signal: AbortSignal.timeout(500) });
      const body = await response.json() as { status?: string; pid?: number };
      if (body.pid !== child.pid || body.status === undefined || body.status === "pending") return null;
      settled = body.status;
      return true;
    } catch {
      return null;
    }
  }, "sibling readiness");
  expect(settled).toBe("ready");
  return { child, runtime };
}

/**
 * The 2026-09-26 incident: a second `ocx start --port 10199` beside the user's proxy on 10100
 * (another OPENCODEX_HOME, the same CODEX_HOME) re-pointed Codex's `openai_base_url` at 10199,
 * and once it was killed every Codex thread failed with "Connection refused". A sibling must not
 * write, restore or revert the shared client routing at startup, at exit, or through `ocx stop`.
 *
 * The owner keeps Codex OFF so it never touches the seeded routing itself; the sibling keeps it
 * ON, so without the gate its startup sync injects and both of its shutdown paths replay the
 * journal. HOME, CODEX_HOME and both OPENCODEX_HOMEs are temporary, and no service definition is
 * written, so `ocx stop` has no manager to reach. Every stop runs with a service install recorded
 * from the default home (only its state record, never a plist or unit, so nothing can reach
 * launchctl), and after a hard kill `ocx stop` from the sibling's home must leave the owner running.
 */
describe("a sibling instance leaves the live owner's client routing alone", () => {
  // INV-START-02 (structure/overview.md).
  test("start, ocx stop, SIGTERM and a hard kill of a sibling leave config.toml, the journal and the owner alone", async () => {
    const fx = fixture();
    const owner = await startOwner(fx);
    const ownerRuntime = JSON.parse(readFileSync(join(fx.ocxHome, "runtime-port.json"), "utf8")) as { port: number };
    const injected = `# routed at the live owner\nmodel_provider = "opencodex"\nopenai_base_url = "http://127.0.0.1:${ownerRuntime.port}/v1"\n`;
    writeFileSync(fx.configPath, injected);
    writeFileSync(fx.journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('# original\nmodel_provider = "openai"\n').toString("base64"),
      originalProfile: null,
      injectedConfigHash: createHash("sha256").update(injected).digest("hex"),
      injectedProfileHash: null,
      pid: owner.pid,
      timestamp: new Date().toISOString(),
    }));
    const snapshot = () => ({
      config: readFileSync(fx.configPath, "utf8"),
      journal: existsSync(fx.journalPath) ? readFileSync(fx.journalPath, "utf8") : null,
    });
    const before = snapshot();

    const siblingHome = join(fx.root, "ocx-sibling");
    mkdirSync(siblingHome, { recursive: true });
    // Configured on the owner's port, as a copied home would be; Codex integration left ON.
    writeFileSync(join(siblingHome, "config.json"), JSON.stringify({
      port: ownerRuntime.port,
      hostname: "127.0.0.1",
      codexAutoStart: false,
      syncResumeHistory: false,
      clientIntegrations: { grok: false, "claude-desktop": false },
      claudeCode: { systemEnv: false },
      providers: {},
      defaultProvider: "openai",
    }));
    const siblingEnv = { ...fx.env, OPENCODEX_HOME: siblingHome };

    try {
      const siblingPort = freeLoopbackPort();
      const sibling = await startSibling(siblingEnv, siblingHome, siblingPort, fx.root);
      expect(sibling.runtime.siblingOfPort).toBe(ownerRuntime.port);
      expect(snapshot()).toEqual(before);

      // The live owner's service, recorded as installed from the default home, for the first stop
      // and hard-kill legs
      // below. Its ownership check fails from the sibling's home; a sibling never runs under a
      // service manager, so neither `ocx stop` nor the sibling's own /api/stop may ask one. The
      // record has to be the authority the child resolves, or these legs would prove nothing.
      const defaultHome = join(fx.env.HOME, ".opencodex");
      mkdirSync(defaultHome, { recursive: true });
      const serviceStatePath = join(defaultHome, "service-state.json");
      const serviceState = JSON.stringify({
        version: 1, codexHome: fx.codexHome, opencodexHome: defaultHome,
      });
      writeFileSync(serviceStatePath, serviceState);
      const installed = selectAuthoritativeServiceState(inspectServiceStateRecords(serviceStatePathsForHomes(siblingHome, defaultHome)));
      expect(installed.kind === "state" ? installed.state.opencodexHome : installed.kind).toBe(defaultHome);

      const stop = await runCli({ ...fx, env: siblingEnv }, ["stop"]);
      expect(stop.exitCode, stop.stderr).toBe(0);
      expect(stop.stdout).toContain(`Client routing stays on the proxy at port ${ownerRuntime.port}`);
      await sibling.child.exited;
      expect(await new Response(sibling.child.stdout).text()).toContain(
        `Client routing stays on the proxy at port ${ownerRuntime.port}; this instance serves direct requests on port ${siblingPort} only.`,
      );
      expect(snapshot()).toEqual(before);

      // A signal-driven exit runs the start process's own cleanup rather than `ocx stop`. POSIX
      // only: on win32 a SIGTERM is TerminateProcess, so no cleanup runs and the leg proves nothing.
      if (process.platform !== "win32") {
        const second = await startSibling(siblingEnv, siblingHome, freeLoopbackPort(), fx.root);
        second.child.kill("SIGTERM");
        await second.child.exited;
        expect(snapshot()).toEqual(before);
        // Clean shutdown removed the sibling record. The configured-port fallback now finds
        // the owner, but a healthz identity alone does not prove it belongs to this home. With
        // the unrelated service record absent, no earlier ownership gate masks this bug.
        unlinkSync(serviceStatePath);
        const cleanExitStop = await runCli({ ...fx, env: siblingEnv }, ["stop"]);
        expect(cleanExitStop.exitCode).toBe(1);
        expect(cleanExitStop.stderr).toContain("belongs to this home");
        const ownerHealth = await fetch(`http://127.0.0.1:${ownerRuntime.port}/healthz`)
          .then(response => response.json()) as { pid?: number };
        expect(ownerHealth.pid).toBe(owner.pid);
        expect(snapshot()).toEqual(before);
        writeFileSync(serviceStatePath, serviceState);
      }

      // A hard-killed sibling leaves its records behind with a dead pid. Discovery then falls back
      // to the configured port, where the owner answers; `ocx stop` must not stop it.
      const killed = await startSibling(siblingEnv, siblingHome, freeLoopbackPort(), fx.root);
      killed.child.kill("SIGKILL");
      await killed.child.exited;
      const orphanStop = await runCli({ ...fx, env: siblingEnv }, ["stop"]);
      expect(orphanStop.exitCode, orphanStop.stderr).toBe(0);
      expect(orphanStop.stdout).toContain(`The sibling instance is already gone; the proxy on port ${ownerRuntime.port} was left running.`);
      expect(existsSync(join(siblingHome, "runtime-port.json"))).toBe(false);
      expect(existsSync(join(siblingHome, "ocx.pid"))).toBe(false);
      expect(snapshot()).toEqual(before);

      // The owner never noticed.
      const health = await fetch(`http://127.0.0.1:${ownerRuntime.port}/healthz`).then(response => response.json()) as { pid?: number };
      expect(health.pid).toBe(owner.pid);
    } finally {
      owner.kill("SIGTERM");
      await owner.exited;
    }
  }, SIBLING_ROUTING_BUDGET_MS);

  test("a direct start cannot claim sibling status with only a forged port env", async () => {
    const fx = fixture();
    const forgedOwnerPort = freeLoopbackPort();
    // Sibling admission is the claim here, not a particular listener number, so the child binds
    // its own port (config.port 0) instead of a released probe port another process may take.
    const launched = await startSibling(
      { ...fx.env, OCX_SIBLING_OF_PORT: String(forgedOwnerPort) },
      fx.ocxHome,
      undefined,
      fx.root,
    );
    expect(launched.runtime.siblingOfPort).toBeUndefined();
    launched.child.kill("SIGTERM");
    await launched.child.exited;
  }, JOURNAL_OWNERSHIP_BUDGET_MS);

  test("a sibling's replacement that starts while the owner is down stays a sibling", async () => {
    // A sibling's drain-and-restart or recycle spawns a fresh `ocx start` that re-probes. With the
    // owner down for that moment it used to start as an ordinary owner: it replayed the owner's
    // journal, re-pointed Codex at itself and persisted config.port. The spawn now carries
    // OCX_SIBLING_OF_PORT, which handleStart honors before any probe.
    const fx = fixture();
    const ownerPort = freeLoopbackPort();
    const injected = `# routed at the owner\nmodel_provider = "opencodex"\nopenai_base_url = "http://127.0.0.1:${ownerPort}/v1"\n`;
    writeFileSync(fx.configPath, injected);
    writeFileSync(fx.journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('# original\nmodel_provider = "openai"\n').toString("base64"),
      originalProfile: null,
      injectedConfigHash: createHash("sha256").update(injected).digest("hex"),
      injectedProfileHash: null,
      pid: 999_999,
      timestamp: new Date().toISOString(),
    }));
    const snapshot = () => ({
      config: readFileSync(fx.configPath, "utf8"),
      journal: existsSync(fx.journalPath) ? readFileSync(fx.journalPath, "utf8") : null,
    });
    const before = snapshot();
    const siblingHome = join(fx.root, "ocx-sibling");
    mkdirSync(siblingHome, { recursive: true });
    const siblingConfig = join(siblingHome, "config.json");
    writeFileSync(siblingConfig, JSON.stringify({
      port: ownerPort,
      hostname: "127.0.0.1",
      codexAutoStart: false,
      syncResumeHistory: false,
      clientIntegrations: { grok: false, "claude-desktop": false },
      claudeCode: { systemEnv: false },
      providers: {},
      defaultProvider: "openai",
    }));
    const siblingPort = freeLoopbackPort();
    const previousHome = process.env.OPENCODEX_HOME;
    const replacementEnv = (() => {
      try {
        process.env.OPENCODEX_HOME = siblingHome;
        // Model the previous sibling at the handoff boundary. The issued record is bound to its
        // runtime PID, own port and home, then consumed by the real replacement CLI process.
        writeRuntimePort({ pid: process.pid, port: siblingPort, siblingOfPort: ownerPort,
          attestationSecret: createLocalAttestationSecret() });
        markSiblingStart(ownerPort);
        return withSiblingMarker({ ...fx.env, OPENCODEX_HOME: siblingHome }, issueSiblingHandoff);
      } finally {
        resetSiblingStartForTests();
        removeRuntimePort(process.pid);
        if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = previousHome;
      }
    })();
    const replacement = await startSibling(replacementEnv, siblingHome, siblingPort, fx.root);
    expect(replacement.runtime.siblingOfPort).toBe(ownerPort);
    expect(existsSync(join(siblingHome, `sibling-handoff-${replacementEnv.OCX_SIBLING_HANDOFF_NONCE}.json`))).toBe(false);
    expect(snapshot()).toEqual(before);
    expect((JSON.parse(readFileSync(siblingConfig, "utf8")) as { port?: number }).port).toBe(ownerPort);

    const stop = await runCli({ ...fx, env: { ...fx.env, OPENCODEX_HOME: siblingHome } }, ["stop"]);
    expect(stop.exitCode, stop.stderr).toBe(0);
    await replacement.child.exited;
    expect(await new Response(replacement.child.stdout).text()).toContain(
      `Client routing stays on the proxy at port ${ownerPort}; this instance serves direct requests on port ${siblingPort} only.`,
    );
    expect(snapshot()).toEqual(before);
    expect((JSON.parse(readFileSync(siblingConfig, "utf8")) as { port?: number }).port).toBe(ownerPort);
  }, JOURNAL_OWNERSHIP_BUDGET_MS);
});
