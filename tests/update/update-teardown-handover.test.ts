import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexNativeRestoreResult } from "../../src/codex/inject";
import { syncCodexOnStartIfEnabled } from "../../src/codex/desired-state";
import { claimPendingTeardown, isUpdateHandoverReceipt, pendingTeardownPathFor, readPendingTeardown } from "../../src/config/pending-teardown";
import { performStopTeardown } from "../../src/server/stop-teardown";
import { runGuiUpdateWorker, updateJobPath } from "../../src/update/job";
import {
  STOP_HISTORY_DEFERRED_EXIT_CODE,
  STOP_HISTORY_INCOMPLETE_EXIT_CODE,
  STOP_TEARDOWN_HANDED_OVER_EXIT_CODE,
} from "../../src/update/stop-contract.mjs";
import { decidePostStopUpdate } from "../../src/update/stop-decision.mjs";
import {
  dischargeUpdateTeardownHandovers,
  forgetUpdateTeardownHandover,
  stopHandsTeardownOver,
  updateTeardownHandoverPending,
  updateTeardownHandoverRequested,
  UPDATE_TEARDOWN_HANDOVER_ENV,
} from "../../src/update/teardown-handover";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fixturePath, repoPath } from "../helpers/repo-root";

/**
 * #7423: an update restart left a window where Codex could load the pristine catalog.
 *
 * The update's `ocx stop` restored native Codex, which removed every routed catalog row,
 * and the new proxy appended them again only after it started. A Codex process that loaded
 * the catalog in between treated routed models as unknown until it was restarted. These
 * cases pin the handover that closes the window: the stop keeps its receipt instead of
 * restoring, the proxy keeps its client config on exit, the updater proceeds past that one
 * receipt, and the replacement releases it after its first successful publication.
 */

const ENDPOINT = { hostname: "127.0.0.1", port: 10100 };
const DEAD = () => false;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-teardown-handover-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

const receiptNames = () => readdirSync(home).filter(name => name.startsWith("pending-teardown"));

describe("handover exit code and update decision", () => {
  test("81 is distinct from the history codes and from every literal code the CLI emits", () => {
    expect(STOP_TEARDOWN_HANDED_OVER_EXIT_CODE).toBe(81);
    expect([STOP_HISTORY_INCOMPLETE_EXIT_CODE, STOP_HISTORY_DEFERRED_EXIT_CODE]).not.toContain(81);
    const cli = readFileSync(repoPath("src", "cli", "index.ts"), "utf8");
    const dispatch = readFileSync(repoPath("src", "cli", "dispatch.ts"), "utf8");
    const literal = [...cli.matchAll(/process\.exit(?:Code)?\s*(?:=|\()\s*(\d+)/g), ...dispatch.matchAll(/return (\d+);/g)]
      .map(match => Number(match[1]));
    expect(literal).not.toContain(81);
  });

  test("a handed-over stop proceeds past its own receipt and nothing else", () => {
    const status = STOP_TEARDOWN_HANDED_OVER_EXIT_CODE;
    expect(decidePostStopUpdate({ status, hasRuntimeState: false, liveness: "dead", teardownOutstanding: true }))
      .toEqual({ proceed: true, reason: "handed-over" });
    expect(decidePostStopUpdate({ status, hasRuntimeState: true, liveness: "dead", teardownOutstanding: true }).reason).toBe("runtime-state");
    expect(decidePostStopUpdate({ status, hasRuntimeState: false, liveness: "live", teardownOutstanding: true }).reason).toBe("proxy-live");
    expect(decidePostStopUpdate({ status, hasRuntimeState: false, liveness: "unknown", teardownOutstanding: true }).reason).toBe("proxy-unknown");
    // An ordinary stop that leaves a receipt behind still aborts, exactly as before.
    expect(decidePostStopUpdate({ status: 0, hasRuntimeState: false, liveness: "dead", teardownOutstanding: true }).reason)
      .toBe("teardown-outstanding");
  });
});

describe("stop handover predicate", () => {
  const facts = (nonce: string | undefined) => ({
    requested: true, restoreBlocked: false, nonce, stopFailed: false, recoveredCount: 0, proxy: "stopped", deferralHonored: true,
  });

  test("hands over only this run's own receipt, alone, after a clean stop", () => {
    const own = claimPendingTeardown(ENDPOINT, "exact", process.pid, "update-restart").nonce;
    expect(stopHandsTeardownOver(facts(own))).toBe(true);
    expect(stopHandsTeardownOver({ ...facts(own), proxy: "stopped-orphan" })).toBe(true);
    // A signal fallback ran the proxy's own exit cleanup, which already restored the pristine catalog.
    expect(stopHandsTeardownOver({ ...facts(own), deferralHonored: false })).toBe(false);
    expect(stopHandsTeardownOver({ ...facts(own), proxy: "stopped-orphan", deferralHonored: false })).toBe(false);
    expect(stopHandsTeardownOver({ ...facts(own), requested: false })).toBe(false);
    expect(stopHandsTeardownOver({ ...facts(own), restoreBlocked: true })).toBe(false);
    expect(stopHandsTeardownOver({ ...facts(own), stopFailed: true })).toBe(false);
    expect(stopHandsTeardownOver({ ...facts(own), recoveredCount: 1 })).toBe(false);
    expect(stopHandsTeardownOver({ ...facts(own), proxy: "not-running" })).toBe(false);
    expect(stopHandsTeardownOver(facts(undefined))).toBe(false);
  });

  test("a clean service-manager stop that took the proxy down may hand over", () => {
    const own = claimPendingTeardown(ENDPOINT, "exact", process.pid, "update-restart").nonce;
    expect(stopHandsTeardownOver({ ...facts(own), proxy: "not-running", service: "stopped" })).toBe(true);
    expect(stopHandsTeardownOver({ ...facts(own), proxy: "not-running", service: "stopped-respawnable" })).toBe(true);
    expect(stopHandsTeardownOver({ ...facts(own), proxy: "not-running", service: "absent" })).toBe(false);
    expect(stopHandsTeardownOver({ ...facts(own), proxy: "not-running", service: "failed" })).toBe(false);
  });

  test("another obligation in the home forces the ordinary restore", () => {
    const own = claimPendingTeardown(ENDPOINT, "exact", process.pid, "update-restart").nonce;
    claimPendingTeardown(ENDPOINT, "exact", 999_999);
    expect(stopHandsTeardownOver(facts(own))).toBe(false);
  });

  test("a guessed or unmarked receipt is never handed over", () => {
    // A later ocx stop refuses to finish a guessed receipt, so handing one over could
    // leave Codex routed at a dead proxy with only a manual way out.
    const guessed = claimPendingTeardown(ENDPOINT, "guessed", process.pid, "update-restart").nonce;
    expect(stopHandsTeardownOver(facts(guessed))).toBe(false);
    rmSync(pendingTeardownPathFor(guessed), { force: true });
    const unmarked = claimPendingTeardown(ENDPOINT, "exact", process.pid).nonce;
    expect(stopHandsTeardownOver(facts(unmarked))).toBe(false);
  });
});

describe("handover receipts", () => {
  test("the handover marker round-trips and an unknown marker invalidates the receipt", () => {
    const handover = claimPendingTeardown(ENDPOINT, "exact", 4242, "update-restart");
    const ordinary = claimPendingTeardown(ENDPOINT, "exact", 4242);
    expect(isUpdateHandoverReceipt(handover.nonce)).toBe(true);
    expect(isUpdateHandoverReceipt(ordinary.nonce)).toBe(false);
    expect(isUpdateHandoverReceipt(null)).toBe(false);
    const path = pendingTeardownPathFor(ordinary.nonce);
    writeFileSync(path, JSON.stringify({ ...ordinary, handover: "anything" }));
    expect(readPendingTeardown(ordinary.nonce).state).toBe("invalid");
  });

  test("startup discharge releases only abandoned handover receipts", () => {
    const abandoned = claimPendingTeardown(ENDPOINT, "exact", 4242, "update-restart").nonce;
    const ordinary = claimPendingTeardown(ENDPOINT, "exact", 4243).nonce;
    const running = claimPendingTeardown(ENDPOINT, "exact", 4244, "update-restart").nonce;
    const result = dischargeUpdateTeardownHandovers(pid => pid === 4244);
    expect(result).toEqual({ discharged: [abandoned], failed: [] });
    expect(existsSync(pendingTeardownPathFor(abandoned))).toBe(false);
    expect(existsSync(pendingTeardownPathFor(ordinary))).toBe(true);
    expect(existsSync(pendingTeardownPathFor(running))).toBe(true);
    expect(dischargeUpdateTeardownHandovers(DEAD).discharged).toEqual([running]);
  });
});

describe("proxy side of the stop", () => {
  const restored: CodexNativeRestoreResult = { success: true, message: "restored" } as CodexNativeRestoreResult;

  for (const handover of [true, false]) {
    test(`a deferred ${handover ? "handover" : "ordinary"} stop ${handover ? "keeps" : "does not keep"} client config on exit`, async () => {
      const nonce = claimPendingTeardown(ENDPOINT, "exact", 4242, handover ? "update-restart" : undefined).nonce;
      let kept = 0;
      let restores = 0;
      const body = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${nonce}`), {
        keepClientConfigOnExit: () => { kept += 1; },
        restoreNativeCodex: async () => { restores += 1; return restored; },
        stripGrok: () => ({ ok: true, changed: false, message: "" }),
      });
      expect(body.sharedTeardown).toBe("deferred");
      expect(kept).toBe(handover ? 1 : 0);
      expect(restores).toBe(0);
    });
  }
});

describe("ocx stop under an update handover", () => {
  const restore = {
    success: true, message: "native Codex restored",
    artifacts: { config: { state: "restored" }, catalog: { state: "restored" }, history: { state: "restored" } },
  };

  function runStop(handover: boolean, extra: Record<string, unknown> = {}) {
    const child = spawnSync(process.execPath, [fixturePath("parent-stop-runner.ts")], {
      cwd: repoPath(),
      env: { ...process.env, OPENCODEX_HOME: home },
      input: JSON.stringify({ receipt: true, serverTeardown: true, json: true, response: null, restore, handover, ...extra }),
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    expect(child.error, child.stderr).toBeUndefined();
    const report = JSON.parse(readFileSync(join(home, "parent-stop-result.json"), "utf8")) as {
      calls: { native: number; grok: number; cleared: number; service: number };
      nonce?: string; receiptExists: boolean; unexpectedIo: string[];
    };
    expect(report.unexpectedIo, child.stderr).toEqual([]);
    return { ...report, exitCode: child.status, stdout: child.stdout, stderr: child.stderr };
  }

  test("keeps Codex routing and the catalog for the replacement and exits 81", () => {
    const run = runStop(true);
    expect(run.exitCode, run.stderr).toBe(STOP_TEARDOWN_HANDED_OVER_EXIT_CODE);
    // Boundary one of the issue: nothing restored the pristine catalog after the old proxy stopped.
    expect(run.calls).toMatchObject({ native: 0, grok: 0, cleared: 0 });
    expect(run.receiptExists).toBe(true);
    expect(isUpdateHandoverReceipt(run.nonce ?? null)).toBe(true);
    expect(JSON.parse(run.stdout)).toMatchObject({ proxy: "stopped", sharedTeardown: "skipped", exitCode: 81 });
    expect(decidePostStopUpdate({ status: run.exitCode, hasRuntimeState: false, liveness: "dead", teardownOutstanding: true }))
      .toEqual({ proceed: true, reason: "handed-over" });
  });

  test("an ordinary stop still restores native Codex and releases its receipt", () => {
    const run = runStop(false);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.calls).toMatchObject({ native: 1, grok: 1, cleared: 1 });
    expect(run.receiptExists).toBe(false);
    expect(receiptNames()).toEqual([]);
  });

  test("hands over when the service manager stops the proxy itself", () => {
    const run = runStop(true, { managerCascades: true, deadPidReadsNull: true });
    expect(run.exitCode, run.stderr).toBe(STOP_TEARDOWN_HANDED_OVER_EXIT_CODE);
    expect(run.calls).toMatchObject({ native: 0, grok: 0, cleared: 0, service: 1 });
    expect(isUpdateHandoverReceipt(run.nonce ?? null)).toBe(true);
  });

  test("a manager-stopped ordinary stop still restores", () => {
    const run = runStop(false, { managerCascades: true, deadPidReadsNull: true });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.calls).toMatchObject({ native: 1, grok: 1 });
    expect(receiptNames()).toEqual([]);
  });

  test("without a runtime record the stop restores instead of handing over a guessed receipt", () => {
    const run = runStop(true, { noRuntimeRecord: true, nativeSignal: true });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.calls).toMatchObject({ native: 1, grok: 1 });
    expect(receiptNames()).toEqual([]);
  });

  test("a failed /api/stop that falls back to a signal restores instead of claiming a handover", () => {
    // Exact runtime endpoint, but the proxy answers 503 before honoring the deferral, so the
    // stop falls back to a signal and the proxy's own exit cleanup is what ran.
    const run = runStop(true, { apiFailure: true, status: 503, response: { error: "unavailable" }, nativeSignal: true });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.calls).toMatchObject({ native: 1, grok: 1 });
    expect(receiptNames()).toEqual([]);
  });
});

describe("startup journal recovery under a handover", () => {
  test("a pending handover is a valid, exact, abandoned handover receipt", () => {
    expect(updateTeardownHandoverPending(DEAD)).toBe(false);
    claimPendingTeardown(ENDPOINT, "exact", 4242);
    expect(updateTeardownHandoverPending(DEAD)).toBe(false);
    const guessed = claimPendingTeardown(ENDPOINT, "guessed", 4242, "update-restart").nonce;
    expect(updateTeardownHandoverPending(DEAD)).toBe(false);
    rmSync(pendingTeardownPathFor(guessed), { force: true });
    claimPendingTeardown(ENDPOINT, "exact", 4242, "update-restart");
    expect(updateTeardownHandoverPending(() => true)).toBe(false);
    expect(updateTeardownHandoverPending(DEAD)).toBe(true);
  });

  test("the stop asks for a handover only when the replacement will run its startup sync", () => {
    const env = { [UPDATE_TEARDOWN_HANDOVER_ENV]: "1" };
    expect(updateTeardownHandoverRequested(env, () => true)).toBe(true);
    expect(updateTeardownHandoverRequested(env, () => false)).toBe(false);
    expect(updateTeardownHandoverRequested(env, () => { throw new Error("unreadable config"); })).toBe(false);
    expect(updateTeardownHandoverRequested({}, () => true)).toBe(false);
  });

  // The restarted proxy reconciles the previous proxy's journal before its first sync. Its
  // owner PID is dead, so without adoption it restores native config for that interval.
  for (const handover of [true, false]) {
    test(`startup ${handover ? "adopts" : "restores"} a dead proxy's journal ${handover ? "with" : "without"} a pending handover`, () => {
      const codexHome = mkdtempSync(join(tmpdir(), "ocx-handover-codex-"));
      try {
        const configPath = join(codexHome, "config.toml");
        const journalPath = join(codexHome, "opencodex-journal.json");
        const original = '# original\nmodel_provider = "openai"\n';
        const injected = '# injected\nmodel_provider = "opencodex"\n';
        writeFileSync(configPath, injected);
        writeFileSync(journalPath, JSON.stringify({
          version: 1,
          originalConfig: Buffer.from(original).toString("base64"),
          originalProfile: null,
          injectedConfigHash: createHash("sha256").update(injected).digest("hex"),
          injectedProfileHash: null,
          owner: { kind: "process", pid: 999_999 },
          pid: 999_999,
          timestamp: new Date().toISOString(),
        }));
        if (handover) claimPendingTeardown(ENDPOINT, "exact", 999_998, "update-restart");
        const child = spawnSync(process.execPath, ["--eval",
          'const { reconcileStartupJournal } = require("./src/cli/cross-home-owner"); reconcileStartupJournal(); console.log(JSON.stringify({ pid: process.pid }));'], {
          cwd: repoPath(),
          env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: home },
          encoding: "utf8",
          timeout: 60_000,
          windowsHide: true,
        });
        expect(child.status, child.stderr).toBe(0);
        const childPid = (JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { pid: number }).pid;
        if (handover) {
          expect(readFileSync(configPath, "utf8")).toBe(injected);
          const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { pid: number; owner: { pid: number }; originalConfig: string };
          expect(journal.pid).toBe(childPid);
          expect(journal.owner.pid).toBe(childPid);
          // The user's baseline survives the ownership change, so a later stop restores it.
          expect(Buffer.from(journal.originalConfig, "base64").toString("utf8")).toBe(original);
        } else {
          expect(readFileSync(configPath, "utf8")).toBe(original);
        }
      } finally {
        removeTreeWithRetry(codexHome);
      }
    });
  }

  function probe(mode: "swap" | "off"): Record<string, unknown> {
    const root = mkdtempSync(join(tmpdir(), `ocx-handover-probe-${mode}-`));
    try {
      const child = spawnSync(process.execPath, [fixturePath("handover-journal-probe.ts"), mode, root], {
        cwd: repoPath(), env: { ...process.env }, encoding: "utf8", timeout: 60_000, windowsHide: true,
      });
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
    } finally {
      removeTreeWithRetry(root);
    }
  }

  test("adoption never overwrites a Codex home replaced during recovery", () => {
    expect(probe("swap")).toEqual({ replacementPreserved: true });
  });

  test("a stale handover receipt does not keep routing once the Codex integration is off", () => {
    expect(probe("off")).toEqual({ config: '# original\nmodel_provider = "openai"\n', journalExists: false });
  });
});

describe("startup publication", () => {
  const config = { providers: {} } as unknown as OcxConfig;
  const cases: Array<[string, Record<string, unknown> | undefined, boolean]> = [
    ["applied", { ok: true, status: "applied" }, true],
    ["catalog-only", { ok: true, status: "catalog-only" }, true],
    ["skipped", { ok: true, status: "skipped" }, false],
    ["failed", { ok: false, status: "applied" }, false],
    ["thrown", undefined, false],
  ];
  for (const [name, outcome, published] of cases) {
    test(`a ${name} startup sync ${published ? "publishes" : "does not publish"}`, async () => {
      const result = await syncCodexOnStartIfEnabled(10100, config, async () => {
        if (!outcome) throw new Error("sync failed");
        return outcome as never;
      });
      expect(result.published).toBe(published);
    });
  }
});

describe("dashboard update job", () => {
  for (const restart of [true, false]) {
    test(`${restart ? "requests" : "does not request"} the handover when restart=${restart}`, async () => {
      let updateEnv: NodeJS.ProcessEnv | undefined;
      // A worker launched by a recovery-started proxy could have inherited the marker.
      process.env[UPDATE_TEARDOWN_HANDOVER_ENV] = "1";
      try {
        await runGuiUpdateWorker(`handover-${restart}`, "latest", restart, {
        checkForUpdateFn: () => ({
          currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest", installer: "pnpm",
          updateAvailable: true, canUpdate: true, command: "node /old/bin/ocx.mjs update --tag latest",
          releaseNotesUrl: "https://github.com/lidge-jun/opencodex/releases/latest",
        }),
        resolvePnpmOwnerFn: () => ({ ok: true as const, owner: {
          commandPath: "/pnpm/owner/bin/pnpm", packagePath: "/pnpm/owner/global/v11/node_modules/@bitkyc08/opencodex",
          globalDir: "/pnpm/owner/global", globalRoot: "/pnpm/owner/global/v11", globalBinDir: "/pnpm/owner/bin",
        } }),
        resolvePnpmActiveLauncherFn: () => "/pnpm/owner/global/v11/node_modules/@bitkyc08/opencodex/bin/ocx.mjs",
        integrityFn: () => ({ ok: true as const, integrity: "sha512-testfixturevalue000000000" }),
        // Only the environment handed to the update child matters here; failing the command
        // ends the job before any restart work, which other suites already cover.
        runCommandFn: (_job, _bin, _args, _timeout, env) => { updateEnv = env; return { status: 1, signal: null }; },
        });
      } finally {
        // The marker lives in this worker's shared environment; never let it reach a later test.
        delete process.env[UPDATE_TEARDOWN_HANDOVER_ENV];
        rmSync(updateJobPath(), { force: true });
      }
      expect(updateEnv).toBeDefined();
      expect(updateEnv?.[UPDATE_TEARDOWN_HANDOVER_ENV]).toBe(restart ? "1" : undefined);
    });
  }

  test("a starting proxy forgets an inherited marker", () => {
    const env: NodeJS.ProcessEnv = { [UPDATE_TEARDOWN_HANDOVER_ENV]: "1", KEEP: "x" };
    forgetUpdateTeardownHandover(env);
    expect(env).toEqual({ KEEP: "x" });
  });
});

