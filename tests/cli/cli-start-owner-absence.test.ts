import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { watchdogMs } from "../helpers/ci-watchdog";

const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(async () => {
  while (children.length) {
    const child = children.pop()!;
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  while (roots.length) removeTreeWithRetry(roots.pop()!);
});

// Exercise the real command bodies, lease wrapper, liveness retries, cross-home
// discovery and journal recovery. Only command IO and probe transport are supplied.
for (const scenario of ["start", "ensure", "service", "supervised", "sibling", "restart-parent", "connected-client"] as const) {
  test(`consecutive transport misses preserve PID and journal for ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-absence-"));
    roots.push(root);
    const codex = join(root, "codex"), home = join(root, "ocx");
    mkdirSync(codex); mkdirSync(home);
    const configPath = join(codex, "config.toml");
    const journalPath = join(codex, "opencodex-journal.json");
    const pidPath = join(home, "ocx.pid");
    const injected = '# injected\nmodel_provider = "opencodex"\n';
    writeFileSync(configPath, injected);
    writeFileSync(pidPath, String(process.pid));
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 0, providers: {} }));
    const journal = JSON.stringify({ version: 1,
      originalConfig: Buffer.from('# original\nmodel_provider = "openai"\n').toString("base64"),
      originalProfile: null, injectedConfigHash: createHash("sha256").update(injected).digest("hex"),
      injectedProfileHash: null, pid: 999_999, timestamp: new Date().toISOString(),
    });
    writeFileSync(journalPath, journal);
    const cli = readFileSync(repoPath("src/cli/index.ts"), "utf8");
    const fence = readFileSync(repoPath("src/cli/start-owner-fence.ts"), "utf8");
    const commands = cli.slice(cli.indexOf("async function findProxyOwnerBeforeJournalRecovery("), cli.indexOf("function detachedStartEnvironment("))
      + cli.slice(cli.indexOf("async function handleEnsure("), cli.indexOf("async function handleTrayProxyStart("));
    const recheck = fence.slice(fence.indexOf("export async function recoverStartJournalAfterOwnerRecheck("), fence.indexOf("/** Hold ownership stable"));
    const executable = new Bun.Transpiler({ loader: "ts" }).transformSync(commands + recheck.replace("export ", ""));
    const script = join(root, "consecutive-misses.ts");
    writeFileSync(script, `
      import * as liveness from ${JSON.stringify(repoPath("src/server/proxy-liveness.ts"))};
      import { readAlivePid, readPidFileValue, removePidIfValueIs } from ${JSON.stringify(repoPath("src/config/process-state.ts"))};
      import { reconcileStartupJournal, markCrossHomeSibling } from ${JSON.stringify(repoPath("src/cli/cross-home-owner.ts"))};
      import { recoverStartStateUnderOwnershipLease } from ${JSON.stringify(repoPath("src/cli/start-owner-fence.ts"))};
      import { decideStartWithLiveOwner } from ${JSON.stringify(repoPath("src/cli/dispatch.ts"))};
      const events = [], messages = [];
      let probes = 0, attempts = 0, leased = false;
      const scenario = ${JSON.stringify(scenario)}, pid = ${process.pid};
      class StartCommandExit extends Error { constructor(readonly exitCode) { super("exit"); } }
      const fakeProcess = { env: { OCX_SERVICE: ["service", "supervised"].includes(scenario) ? "1" : undefined },
        exitCode: 0, exit(code) { throw new StartCommandExit(code); } };
      const probeIo = budget => {
        if (budget !== liveness.START_OWNERSHIP_LIVENESS) throw new Error("changed liveness budget");
        events.push("probe:" + (++probes) + ":" + leased);
        return { ...budget, readPidFn: readAlivePid,
          readRuntimeFn: () => ({ pid, port: 10100, hostname: "127.0.0.1" }), verifyPidFn: candidate => candidate,
          configFn: () => ({ port: 10100, hostname: "127.0.0.1" }), sleepFn: async () => {},
          loopbackAvailabilityFn: () => "available",
          fetchFn: async () => {
            attempts++;
            if (probes <= 2) throw Object.assign(new Error("untrusted-secret-transport-detail"), { code: "ETIMEDOUT" });
            return Response.json({ service: "opencodex", status: "ok", pid });
          },
        };
      };
      const deps = {
        process: fakeProcess, console: { log() {}, warn() {}, error: message => messages.push(message) }, StartCommandExit,
        START_OWNERSHIP_LIVENESS: liveness.START_OWNERSHIP_LIVENESS,
        findLiveProxy: budget => liveness.findLiveProxy(probeIo(budget)),
        observeProxyLiveness: budget => liveness.observeProxyLiveness(probeIo(budget)),
        readPidFileValue, readRuntimePort: () => ({ pid, port: 10100 }),
        removePidIfValueIs: value => { events.push("pid-remove"); removePidIfValueIs(value); },
        acquireOwnershipMutationLease: () => { leased = true; events.push("lease"); return { release() { leased = false; events.push("release"); } }; },
        recoverStartStateUnderOwnershipLease, decideStartWithLiveOwner,
        serviceStatePaths: () => ({}), serviceChildOwnershipDecisionForClassifiedChild: () => ({ kind: "proceed" }),
        isSupervisedServiceChild: () => scenario === "supervised", serviceStayOutExitCode: () => 0,
        forgetUpdateTeardownHandover() {}, updateRestartChild: null,
        startupDataPlaneToken: () => null, isApiAuthRequired: () => false, loadConfig: () => ({}),
        parseStartCliOptions: () => ({ port: scenario === "sibling" ? 10101 : undefined }),
        honorSiblingMarker: () => null, consumeSiblingHandoff() {},
        takeRestartHandoffMarkers: () => scenario === "restart-parent" ? pid : null,
        probeOwnerPastRestartParent: probe => probe(), duplicateRuntimeMessage: () => "Proxy already running",
        markSiblingStart: () => events.push("sibling"),
        markCrossHomeSibling: async () => { events.push("cross-home"); return markCrossHomeSibling(); },
        markLiveHomeSibling: async () => false,
        reconcileStartupJournal: () => { events.push("recover"); reconcileStartupJournal(); },
        readClientConnectionState: () => ({ kind: scenario === "connected-client" ? "connected" : "disconnected" }),
        inspectClientRotationRecoveryGate: () => ({}),
        startClientRuntimeUnderOwnershipLease: () => { throw new Error("unexpected client bind"); },
        deferServiceChildToNewerRuntime: async () => null, packageVersion: () => "test", currentServingCommand: () => [],
        maybeShowUpdatePrompt: async () => {}, bindAndPublishStartOwnership: async deps => deps.bind(),
        chooseListenPort: () => { throw new Error("unexpected bind"); }, codexAutoStartEnabled: () => false,
      };
      const api = new Function(...Object.keys(deps), ${JSON.stringify(executable)} + "; return { handleStart, handleEnsure };")(...Object.values(deps));
      let refusal;
      try { await (scenario === "ensure" ? api.handleEnsure() : api.handleStart({ block: false })); }
      catch (error) {
        if (error instanceof StartCommandExit) fakeProcess.exitCode = error.exitCode;
        else { refusal = error.message; fakeProcess.exitCode = 1; }
      }
      console.log(JSON.stringify({ events, probes, attempts, exitCode: fakeProcess.exitCode, refusal, messages }));
    `);
    const child = Bun.spawn([process.execPath, script], { env: {
      HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: codex,
      OCX_OWNER_REGISTRY_DIR: join(root, "registry"), XDG_RUNTIME_DIR: root,
    }, stdout: "pipe", stderr: "pipe" });
    children.push(child);
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(readFileSync(configPath, "utf8"), stdout).toBe(injected);
    expect(existsSync(journalPath), stdout).toBe(true);
    expect(readFileSync(journalPath, "utf8")).toBe(journal);
    expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid));
    expect(result.events).toEqual(["probe:1:false", "lease", "probe:2:true", "release"]);
    expect(result.probes).toBe(2);
    expect(result.attempts).toBe(18); // Two endpoints: early single-family + leased two-family, three attempts each.
    expect(result.exitCode).toBe(1);
    expect(result.refusal).toMatch(/ownership.*unverified/i);
    expect(result.refusal).not.toContain("untrusted-secret");
  }, watchdogMs(30_000));
}

test("an exited recorded owner on a refused port still recovers its journal and stale PID", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-dead-owner-"));
  roots.push(root);
  const home = join(root, "ocx"), codex = join(root, "codex");
  mkdirSync(home); mkdirSync(codex);
  const original = '# original\nmodel_provider = "openai"\n';
  const injected = '# injected\nmodel_provider = "opencodex"\n';
  const configPath = join(codex, "config.toml"), journalPath = join(codex, "opencodex-journal.json");
  writeFileSync(configPath, injected);
  writeFileSync(journalPath, JSON.stringify({ version: 1,
    originalConfig: Buffer.from(original).toString("base64"), originalProfile: null,
    injectedConfigHash: createHash("sha256").update(injected).digest("hex"), injectedProfileHash: null,
    pid: 999_999, timestamp: new Date().toISOString(),
  }));
  const script = join(root, "dead-owner.ts");
  writeFileSync(script, `
    import { writeFileSync } from "node:fs";
    import { readAlivePid } from ${JSON.stringify(repoPath("src/config/process-state.ts"))};
    import { recoverStartJournalAfterOwnerRecheck, recoverStartStateUnderOwnershipLease } from ${JSON.stringify(repoPath("src/cli/start-owner-fence.ts"))};
    const dead = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" });
    if (await dead.exited !== 0) throw new Error("fixture child failed");
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const port = listener.port;
    await listener.stop(true);
    writeFileSync(${JSON.stringify(join(home, "config.json"))}, JSON.stringify({ port, hostname: "127.0.0.1", providers: {} }));
    writeFileSync(${JSON.stringify(join(home, "ocx.pid"))}, String(dead.pid));
    writeFileSync(${JSON.stringify(join(home, "runtime-port.json"))}, JSON.stringify({ pid: dead.pid, port, hostname: "127.0.0.1" }));
    if (readAlivePid() !== null) throw new Error("fixture owner is still alive");
    const events = [], owner = { live: null, pidSnapshot: dead.pid };
    const sibling = await recoverStartStateUnderOwnershipLease({ supervised: false,
      acquireLease: () => { events.push("lease"); return { release() { events.push("release"); } }; },
      decide: () => ({ kind: "proceed" }), stayOut: () => { throw new Error("unexpected stay-out"); },
      recover: () => recoverStartJournalAfterOwnerRecheck(owner),
    });
    console.log(JSON.stringify({ sibling, live: owner.live, events }));
  `);
  const child = Bun.spawn([process.execPath, script], { env: {
    HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: codex,
    OCX_OWNER_REGISTRY_DIR: join(root, "registry"), XDG_RUNTIME_DIR: root,
  }, stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exitCode, stderr).toBe(0);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({ sibling: false, live: null, events: ["lease", "release"] });
  expect(readFileSync(configPath, "utf8")).toBe(original);
  expect(existsSync(journalPath)).toBe(false);
  expect(existsSync(join(home, "ocx.pid"))).toBe(false);
}, watchdogMs(30_000));
