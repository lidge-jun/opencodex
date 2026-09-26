import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * The routing healer against the REAL injector in a throwaway CODEX_HOME.
 *
 * A dead instance on 10199 left marker-owned routing, the journal and the catalog line behind; the
 * live owner serves 10100. The probe is stubbed (nothing listens in a test), everything else is the
 * production path: the file read, the read-only journal, the gates' config, `injectCodexConfig`
 * with the healer's guard. Each case runs in its own process because CODEX_HOME is resolved at
 * module load.
 */
const SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { injectCodexConfig } = require("./src/codex/inject");
const { startCodexRoutingHealer } = require("./src/codex/routing-healer");
const home = process.env.CODEX_HOME;
const mode = process.env.OCX_HEAL_SCENARIO;
const configPath = path.join(home, "config.toml");
const journalPath = path.join(home, "opencodex-journal.json");
const catalogPath = path.join(home, "opencodex-catalog.json");
const config = { port: 10100, providers: {}, defaultProvider: "openai", syncResumeHistory: false };
const marker = "# Auto-injected by opencodex (undo: ocx restore)";
const routedAt = port => marker + "\nopenai_base_url = \"http://127.0.0.1:" + port + "/v1\"\n"
  + marker + "\nexperimental_realtime_ws_base_url = \"http://127.0.0.1:" + port + "/v1\"\nmodel = \"gpt-5.5\"\n";
let now = 1000;
const queue = [];
const warnings = [];
function run(probeAnswer, injectWrapper) {
  return startCodexRoutingHealer({
    port: 10100,
    config,
    deps: {
      scheduleFn: (fn, ms) => { const entry = { fn, ms }; queue.push(entry); return { cancel: () => { const at = queue.indexOf(entry); if (at !== -1) queue.splice(at, 1); } }; },
      now: () => now,
      probe: async () => probeAnswer,
      ...(injectWrapper ? { inject: injectWrapper } : {}),
      gates: {
        siblingOfLivePort: () => null,
        exiting: () => false,
        runtimePortOfThisProcess: () => 10100,
        loadConfig: () => config,
        clientConnected: () => false,
      },
      log: { warn: line => warnings.push(line) },
      debugLine: () => {},
    },
  });
}
async function ticks(count) {
  for (let i = 0; i < count; i++) {
    const entry = queue.shift();
    if (!entry) return;
    now += entry.ms;
    entry.fn();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function waitForHeal(handle) {
  for (let i = 0; i < 40 && !handle.lastHeal(); i++) await ticks(1);
  // The write itself is async (lock + history job); let it settle.
  for (let i = 0; i < 100 && !handle.lastHeal(); i++) await new Promise(resolve => setTimeout(resolve, 50));
}
(async () => {
  if (mode === "corrupt") {
    fs.writeFileSync(configPath, routedAt(10199));
    fs.writeFileSync(journalPath, "{not json");
    const configBefore = fs.readFileSync(configPath, "utf8");
    const journalBefore = fs.readFileSync(journalPath);
    const unknown = run("unknown");
    await ticks(15);
    unknown.stop();
    queue.length = 0;
    const live = run("live");
    await ticks(15);
    live.stop();
    console.log(JSON.stringify({
      journalIdentical: fs.existsSync(journalPath) && Buffer.compare(journalBefore, fs.readFileSync(journalPath)) === 0,
      configIdentical: fs.readFileSync(configPath, "utf8") === configBefore,
      warnings,
    }));
    return;
  }

  fs.writeFileSync(configPath, "# user config\nmodel = \"gpt-5.5\"\n");
  fs.writeFileSync(catalogPath, JSON.stringify({ models: [] }));
  const seeded = await injectCodexConfig(10199, { ...config, port: 10199 }, { catalogPath });
  if (!seeded.success) throw new Error(seeded.message);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  journal.pid = 424242;
  journal.owner = { kind: "process", pid: 424242 };
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  const before = fs.readFileSync(configPath, "utf8");

  if (mode === "guard") {
    const moved = before.split("10199").join("10300");
    let guardRan = false;
    const handle = run("dead", (port, cfg, options) => injectCodexConfig(port, cfg, {
      ...options,
      beforeClientWrite: () => {
        guardRan = true;
        fs.writeFileSync(configPath, moved); // another writer lands between the probe and the lock
        options.beforeClientWrite();
      },
    }));
    await ticks(3);
    for (let i = 0; i < 100 && !guardRan; i++) await new Promise(resolve => setTimeout(resolve, 50));
    await new Promise(resolve => setTimeout(resolve, 200));
    handle.stop();
    console.log(JSON.stringify({ guardRan, unchanged: fs.readFileSync(configPath, "utf8") === moved, healed: handle.lastHeal() }));
    return;
  }

  if (mode === "raced") {
    // injectCodexConfig reads config.toml before its first await. The Codex app rewrites the file
    // right after that read, so the coordinated write lock finds the admitted state stale before the
    // healer's guard ever runs. Routing still names the dead port.
    const rewritten = before + "# rewritten by the Codex app\n";
    const results = [];
    const handle = run("dead", async (port, cfg, options) => {
      const pending = injectCodexConfig(port, cfg, options);
      if (results.length === 0) fs.writeFileSync(configPath, rewritten);
      const result = await pending;
      results.push(result);
      return result;
    });
    // Tick whenever the loop has re-armed; a write in flight leaves the queue empty until it settles.
    for (let i = 0; i < 20 && !handle.lastHeal(); i++) {
      for (let wait = 0; wait < 200 && queue.length === 0 && !handle.lastHeal(); wait++) await new Promise(resolve => setTimeout(resolve, 25));
      if (!handle.lastHeal()) await ticks(1);
    }
    handle.stop();
    console.log(JSON.stringify({
      first: results[0] ?? null,
      attempts: results.length,
      healed: handle.lastHeal(),
      warnings,
      after: fs.readFileSync(configPath, "utf8"),
    }));
    return;
  }

  const handle = run("dead");
  await waitForHeal(handle);
  handle.stop();
  const after = fs.readFileSync(configPath, "utf8");
  const journalAfter = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const catalogLine = text => (text.split("\n").find(line => line.startsWith("model_catalog_json")) ?? null);
  console.log(JSON.stringify({
    healed: handle.lastHeal(),
    warnings,
    after,
    journalPid: journalAfter.pid,
    journalOwnerPid: journalAfter.owner && journalAfter.owner.pid,
    originalConfigKept: journalAfter.originalConfig === journal.originalConfig,
    injectedOpenaiBaseUrl: journalAfter.injectedOpenaiBaseUrl,
    injectedRealtimeWsBaseUrl: journalAfter.injectedRealtimeWsBaseUrl,
    catalogBefore: catalogLine(before),
    catalogAfter: catalogLine(after),
  }));
})().catch(error => { console.error(error && error.stack || String(error)); process.exit(1); });
`;

function runScenario(root: string, scenario: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, ["--eval", SCRIPT], {
    cwd: repoRoot(),
    env: { ...process.env, CODEX_HOME: join(root, "codex"), OPENCODEX_HOME: join(root, "ocx"), OCX_HEAL_SCENARIO: scenario },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });
  const stdout = result.stdout?.trim() ?? "";
  if (result.error || result.status !== 0) {
    throw new Error(`heal child failed: status=${result.status} error=${result.error?.message ?? "none"}\nstdout=${stdout.slice(-4096)}\nstderr=${(result.stderr ?? "").slice(-4096)}`);
  }
  return JSON.parse(stdout.split("\n").at(-1)!) as Record<string, unknown>;
}

describe("codex routing heal against the real injector", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-routing-heal-"));
    mkdirSync(join(root, "codex"));
    mkdirSync(join(root, "ocx"));
  });

  afterEach(() => {
    removeTreeWithRetry(root);
  });

  test("re-points both routing keys at the live port and keeps the journal's recovery evidence", () => {
    const out = runScenario(root, "heal");
    const after = String(out.after);
    expect(out.healed).toMatchObject({ toPort: 10100 });
    expect(after).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');
    expect(after).toContain('experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"');
    expect(after).not.toContain("10199");
    expect(out.journalPid).toBe(424242);
    expect(out.journalOwnerPid).toBe(424242);
    expect(out.originalConfigKept).toBe(true);
    expect(out.injectedOpenaiBaseUrl).toBe("http://127.0.0.1:10100/v1");
    expect(out.injectedRealtimeWsBaseUrl).toBe("http://127.0.0.1:10100/v1");
    expect(out.catalogBefore).not.toBeNull();
    expect(out.catalogAfter).toBe(out.catalogBefore);
    expect(out.warnings).toEqual([
      "Codex routing pointed at 127.0.0.1:10199, where no opencodex answers; re-pointed it at this proxy on port 10100. Codex threads opened meanwhile keep the old address until you reopen them.",
    ]);
  }, 2 * SPAWN_BUDGET_MS);

  test("the under-lock guard leaves config bytes alone when routing moved after the probe", () => {
    const out = runScenario(root, "guard");
    expect(out.guardRan).toBe(true);
    expect(out.unchanged).toBe(true);
    expect(out.healed).toBeNull();
  }, 2 * SPAWN_BUDGET_MS);

  test("a stale admission from a rewrite before the lock is a race, not a 10-minute refusal", () => {
    const out = runScenario(root, "raced");
    const first = out.first as { success?: boolean; retryable?: boolean; message?: string } | null;
    // The first write really hit the coordinated lock's stale-admission refusal.
    expect(first?.success).toBe(false);
    expect(first?.retryable).not.toBe(true);
    expect(String(first?.message)).toContain("The admitted state changed before the commit could be made under the lock.");
    // No backoff: a fresh dead streak over the rewritten bytes heals it on the next attempt.
    expect(out.attempts).toBe(2);
    expect(out.healed).toMatchObject({ toPort: 10100 });
    const after = String(out.after);
    expect(after).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');
    expect(after).not.toContain("10199");
    expect(after).toContain("# rewritten by the Codex app");
    expect(out.warnings).toEqual([
      "Codex routing pointed at 127.0.0.1:10199, where no opencodex answers; re-pointed it at this proxy on port 10100. Codex threads opened meanwhile keep the old address until you reopen them.",
    ]);
  }, 2 * SPAWN_BUDGET_MS);

  test("an unreadable journal is byte-identical after many unknown and live ticks", () => {
    const out = runScenario(root, "corrupt");
    expect(out.journalIdentical).toBe(true);
    expect(out.configIdentical).toBe(true);
    expect(out.warnings).toEqual(["Codex routing points at another running opencodex on port 10199; leaving it."]);
  }, 2 * SPAWN_BUDGET_MS);
});
