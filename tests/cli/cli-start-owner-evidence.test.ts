import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
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

function ipv6Available(): boolean {
  try {
    const socket = Bun.listen({ hostname: "::1", port: 0, socket: { data() {} } });
    socket.stop(); return true;
  } catch (error) {
    if (["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT"].includes((error as { code: string }).code)) return false;
    throw error;
  }
}

for (const scenario of ["F2 mixed-aggregate", "F3 ipv4-owner", "F3 ipv6-owner", "F4 reused-pid", "F5 localhost."] as const) {
  test.skipIf((scenario.startsWith("F3") || scenario.startsWith("F5")) && !ipv6Available())(`journal recovery evidence: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-owner-evidence-")); roots.push(root);
    const home = join(root, "ocx"), codex = join(root, "codex"); mkdirSync(home); mkdirSync(codex);
    const original = '# original\nmodel_provider = "openai"\n';
    const injected = '# injected\nmodel_provider = "opencodex"\n';
    const config = join(codex, "config.toml"), journalPath = join(codex, "opencodex-journal.json"), pidPath = join(home, "ocx.pid");
    const journal = JSON.stringify({ version: 1, originalConfig: Buffer.from(original).toString("base64"), originalProfile: null,
      injectedConfigHash: createHash("sha256").update(injected).digest("hex"), injectedProfileHash: null,
      pid: 999_999, timestamp: new Date().toISOString() });
    writeFileSync(config, injected); writeFileSync(journalPath, journal);
    const fence = readFileSync(repoPath("src/cli/start-owner-fence.ts"), "utf8");
    const recheck = fence.slice(fence.indexOf("export async function recoverStartJournalAfterOwnerRecheck("), fence.indexOf("/** Hold ownership stable"));
    const executable = new Bun.Transpiler({ loader: "ts" }).transformSync(recheck.replace("export ", ""));
    mkdirSync(join(root, "src", "cli"), { recursive: true });
    const script = join(root, "src", "cli", "index.ts");
    writeFileSync(script, `
      import { writeFileSync } from "node:fs";
      import { observeProxyLiveness as observe, START_OWNERSHIP_LIVENESS } from ${JSON.stringify(repoPath("src/server/proxy-liveness.ts"))};
      import { recoverStartJournalAfterOwnerRecheck as actual, recoverStartStateUnderOwnershipLease } from ${JSON.stringify(repoPath("src/cli/start-owner-fence.ts"))};
      import { readPidFileValue, removePidIfValueIs, readProcessCommandLine, verifyPidIdentity } from ${JSON.stringify(repoPath("src/config/process-state.ts"))};
      import { markCrossHomeSibling, reconcileStartupJournal } from ${JSON.stringify(repoPath("src/cli/cross-home-owner.ts"))};
      const scenario = ${JSON.stringify(scenario)}, dotted = scenario.startsWith("F5"), dual = scenario.startsWith("F3") || dotted;
      let foreign, listener, other;
      try {
        const stopped = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" });
        if (await stopped.exited !== 0) throw new Error("dead-owner fixture failed");
        let pid = stopped.pid;
        if (scenario.startsWith("F4")) {
          foreign = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
          pid = foreign.pid;
        }
        const hostname = scenario === "F3 ipv6-owner" ? "::1" : "127.0.0.1";
        listener = Bun.serve({ hostname, port: 0, fetch: () => Response.json({ service: "opencodex", pid: process.pid }) });
        const port = listener.port;
        if (dual) other = Bun.serve({ hostname: hostname === "::1" ? "127.0.0.1" : "::1", port,
          fetch: () => Response.json({ service: "foreign" }) });
        else { await listener.stop(true); listener = undefined; }
        const bindHost = dotted ? "localhost." : dual ? "localhost" : "127.0.0.1";
        writeFileSync(${JSON.stringify(join(home, "config.json"))}, JSON.stringify({ port, hostname: bindHost, providers: {} }));
        if (!dotted) writeFileSync(${JSON.stringify(pidPath)}, String(pid));
        // An orphan listener's runtime PID is independent of the stale PID record.
        writeFileSync(${JSON.stringify(join(home, "runtime-port.json"))}, JSON.stringify({ pid: dual ? process.pid : pid, port, hostname: bindHost }));
        let run = actual;
        if (scenario.startsWith("F2")) {
          const mixed = Object.assign(new AggregateError([
            Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
            Object.assign(new Error("untrusted-secret-detail"), { code: "ETIMEDOUT" }),
          ]), { code: "ECONNREFUSED" });
          run = new Function("observeProxyLiveness", "START_OWNERSHIP_LIVENESS", "removePidIfValueIs", "markCrossHomeSibling", "reconcileStartupJournal",
            ${JSON.stringify(executable)} + "; return recoverStartJournalAfterOwnerRecheck;")(
            budget => observe({ ...budget, sleepFn: async () => {}, fetchFn: async () => { throw mixed; } }),
            START_OWNERSHIP_LIVENESS, removePidIfValueIs, markCrossHomeSibling, reconcileStartupJournal);
        }
        const commandLine = foreign ? readProcessCommandLine(pid) : undefined;
        const verified = foreign ? verifyPidIdentity(pid) : undefined;
        const owner = { live: null, pidSnapshot: readPidFileValue() }, events = [];
        let refusal;
        try { await recoverStartStateUnderOwnershipLease({ supervised: false,
          acquireLease: () => { events.push("lease"); return { release() { events.push("release"); } }; },
          decide: () => ({ kind: "proceed" }), stayOut: () => { throw new Error("unexpected stay-out"); },
          recover: () => run(owner) }); }
        catch (error) { refusal = error.message; }
        const ownerStillLive = dual ? await fetch("http://" + (hostname === "::1" ? "[::1]" : hostname) + ":" + port + "/healthz").then(r => r.json()) : undefined;
        console.log(JSON.stringify({ pid, refusal, live: owner.live, events, verified, ownerStillLive,
          commandLineReadable: typeof commandLine === "string" && commandLine.length > 0,
          foreignAlive: foreign ? foreign.exitCode === null : undefined }));
      } finally {
        await other?.stop(true); await listener?.stop(true);
        if (foreign) { foreign.kill(); await foreign.exited; }
      }
    `);
    const child = Bun.spawn([process.execPath, script, "start"], { env: { HOME: root, USERPROFILE: root, CODEX_HOME: codex,
      OPENCODEX_HOME: home, OCX_OWNER_REGISTRY_DIR: join(root, "registry"), XDG_RUNTIME_DIR: root }, stdout: "pipe", stderr: "pipe" });
    children.push(child);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.events).toEqual(["lease", "release"]);
    if (scenario.startsWith("F4")) {
      expect(result.commandLineReadable).toBe(true); expect(result.verified).toBeNull(); expect(result.foreignAlive).toBe(true);
      expect(result.refusal).toBeUndefined(); expect(result.live).toBeNull();
      expect(readFileSync(config, "utf8")).toBe(original);
      expect(existsSync(journalPath)).toBe(false); expect(existsSync(pidPath)).toBe(false);
    } else {
      expect(readFileSync(config, "utf8")).toBe(injected); expect(readFileSync(journalPath, "utf8")).toBe(journal);
      if (scenario.startsWith("F5")) expect(existsSync(pidPath)).toBe(false);
      else expect(readFileSync(pidPath, "utf8")).toBe(String(result.pid));
      if (scenario.startsWith("F2")) {
        expect(result.refusal).toContain("ownership is unverified"); expect(result.refusal).not.toContain("untrusted-secret");
      } else {
        expect(result.refusal).toBeUndefined(); expect(result.live?.pid).toBeGreaterThan(0);
        expect(result.ownerStillLive).toEqual({ service: "opencodex", pid: result.live.pid });
      }
    }
  }, watchdogMs(60_000));
}
