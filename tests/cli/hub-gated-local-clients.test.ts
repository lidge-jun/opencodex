/**
 * Hub-gate honesty (#4236, follow-up 2).
 *
 * `localClientSyncAllowed` refuses to rewrite a hub's OWN Codex/Grok/Claude configs unless the
 * unauthenticated loopback listener is on. The gate is fine; the reporting was not. Every
 * caller printed the *toggle's* message, so on a hub with `clientIntegrations` absent:
 *
 *  - `ocx sync` said "Codex integration is OFF" about a switch the operator never set,
 *  - `ocx restore back` committed ON and then told the operator to "retry after the competing
 *    integration change finishes" — there was no competing writer,
 *  - `ocx ensure` removed the managed Grok block as if Grok had been switched off.
 *
 * These tests pin the distinct reason and its sentence at each of those boundaries.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchCommand, type CliDispatchDeps } from "../../src/cli/dispatch";
import { ensureGrokFenceMatchesDesired, type EnsureDesiredIntegrationsDeps } from "../../src/cli/ensure-desired-integrations";
import { codexInjectLockOutcome } from "../../src/codex/inject-coordination";
import {
  HUB_GATED_SKIP_MESSAGE,
  localClientSkipMessage,
  localClientSkipReason,
  localClientSyncAllowed,
} from "../../src/codex/desired-state";
import { saveConfig } from "../../src/config";
import type { GrokInjectResult } from "../../src/grok/inject";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PHANTOM_CONFLICT = "Retry after the competing integration change finishes";

function hubConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10_100,
    hostname: "100.76.170.81",
    runtimeRole: "hub",
    providers: {},
    defaultProvider: "openai",
    checkForUpdates: false,
    ...overrides,
  } as unknown as OcxConfig;
}

describe("the hub gate has its own reason and its own sentence", () => {
  test("a hub without the listener is gated; a listener or a non-hub role opens it", () => {
    expect(localClientSyncAllowed(hubConfig())).toBe(false);
    expect(localClientSkipReason(hubConfig())).toBe("hub-gated");
    // The companion form counts: it is exactly how a hub becomes its own local client.
    expect(localClientSkipReason(hubConfig({ unauthenticatedLoopbackListener: { enabled: true } })))
      .toBe("desired_disabled");
    expect(localClientSkipReason(hubConfig({ unauthenticatedLoopbackListener: { enabled: true, port: 10_104 } })))
      .toBe("desired_disabled");
    expect(localClientSkipReason(hubConfig({ runtimeRole: undefined }))).toBe("desired_disabled");
  });

  test("a real OFF on a gated hub is reported as the toggle, not the gate", () => {
    // Enabling the listener would not make this sync happen, so naming the gate here would
    // send the operator to the wrong key — the mirror image of the defect the reason fixes.
    const off = hubConfig({ clientIntegrations: { codex: false } });
    expect(localClientSyncAllowed(off)).toBe(false);
    expect(localClientSkipReason(off)).toBe("desired_disabled");
    expect(localClientSkipMessage(off, "Codex integration is OFF")).toBe("Codex integration is OFF");
    // Per-client: a Grok OFF does not silence the Codex gate and vice versa.
    expect(localClientSkipReason(off, "grok")).toBe("hub-gated");
    expect(localClientSkipReason(hubConfig({ clientIntegrations: { grok: false } }))).toBe("hub-gated");
  });

  test("the message names the hub and the key that opens the gate", () => {
    expect(HUB_GATED_SKIP_MESSAGE).toContain("This machine is a hub");
    expect(HUB_GATED_SKIP_MESSAGE).toContain("unauthenticatedLoopbackListener");
    // And it must not borrow the toggle's wording, which is the whole defect.
    expect(HUB_GATED_SKIP_MESSAGE).not.toContain("integration is OFF");
  });

  test("localClientSkipMessage keeps the toggle text for a real OFF", () => {
    const off = hubConfig({
      unauthenticatedLoopbackListener: { enabled: true },
      clientIntegrations: { codex: false },
    });
    expect(localClientSkipMessage(off, "Codex integration is OFF; nothing changed."))
      .toBe("Codex integration is OFF; nothing changed.");
    expect(localClientSkipMessage(hubConfig(), "Codex integration is OFF; nothing changed.", "Nothing changed."))
      .toBe(`${HUB_GATED_SKIP_MESSAGE} Nothing changed.`);
  });

  test("the under-lock skip projection reports the gate, not the toggle", () => {
    const gated = codexInjectLockOutcome({ status: "skipped", reason: "hub-gated", waitedMs: 0 });
    expect(gated).toMatchObject({ success: true, status: "skipped", skippedReason: "hub-gated" });
    expect(gated.message).toContain(HUB_GATED_SKIP_MESSAGE);

    // The two pre-existing reasons keep their exact wording.
    const off = codexInjectLockOutcome({ status: "skipped", reason: "desired_disabled", waitedMs: 0 });
    expect(off.message).toBe("Codex integration is OFF; no Codex config, catalog, cache, or history was changed.");
    const reenabled = codexInjectLockOutcome({ status: "skipped", reason: "desired_enabled", waitedMs: 0 });
    expect(reenabled.message).toBe("Codex integration was re-enabled; native restore was skipped.");
  });
});

describe("ocx ensure does not strip a Grok block the operator still wants", () => {
  function harness(config: OcxConfig) {
    const actions: Array<"strip" | "sync"> = [];
    const logs: string[] = [];
    const deps: EnsureDesiredIntegrationsDeps = {
      loadConfig: () => config,
      stripGrokConfig: () => {
        actions.push("strip");
        return { ok: true, changed: true, message: "Removed the opencodex managed block from Grok config." } as GrokInjectResult;
      },
      syncGrokConfig: async () => {
        actions.push("sync");
        return { ok: true, changed: true, message: "updated" } as GrokInjectResult;
      },
      removeDesktop3pStandardPivot: () => ({ ok: true, changed: false, kind: "absent" as const, libraryPath: "/tmp/desktop" }),
      log: message => { logs.push(message); },
      error: message => { logs.push(message); },
    };
    return { actions, logs, deps };
  }

  test("a hub-gated skip leaves ~/.grok/config.toml untouched and says why", async () => {
    // The operator never turned Grok off. Deleting their fence and reporting it as the toggle
    // working is the defect: it destroys a working config on every `ocx ensure`.
    const h = harness(hubConfig());
    await ensureGrokFenceMatchesDesired(10_100, {}, h.deps);
    expect(h.actions).toEqual([]);
    expect(h.logs.join("\n")).toContain(HUB_GATED_SKIP_MESSAGE);
  });

  test("an explicit Grok OFF still strips, because that is the operator's own decision", async () => {
    const h = harness(hubConfig({
      unauthenticatedLoopbackListener: { enabled: true },
      clientIntegrations: { grok: false },
    }));
    await ensureGrokFenceMatchesDesired(10_100, {}, h.deps);
    expect(h.actions).toEqual(["strip"]);
  });

  test("a hub with the listener on syncs the fence like any other host", async () => {
    const h = harness(hubConfig({ unauthenticatedLoopbackListener: { enabled: true } }));
    await ensureGrokFenceMatchesDesired(10_100, {}, h.deps);
    expect(h.actions).toEqual(["sync"]);
  });

  test("an explicit OFF on a GATED hub still strips: the gate never overrides the operator", async () => {
    const h = harness(hubConfig({ clientIntegrations: { grok: false } }));
    await ensureGrokFenceMatchesDesired(10_100, {}, h.deps);
    expect(h.actions).toEqual(["strip"]);
  });
});

describe("CLI output on a hub-gated host", () => {
  /**
   * `tests/preload.ts` sandboxes HOME/OPENCODEX_HOME, but these cases PERSIST a hub config and
   * `restore back` mutates it (`setIntegrationEnabled`), so each gets its own home rather than
   * leaving a hub role behind for the next test in the shard.
   */
  async function runInHubHome(
    command: string,
    args: string[],
    extraDeps: Partial<CliDispatchDeps> = {},
  ): Promise<{ code: number; out: string[]; err: string[] }> {
    const home = mkdtempSync(join(tmpdir(), "ocx-hub-gated-"));
    const previous = process.env.OPENCODEX_HOME;
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    process.env.OPENCODEX_HOME = home;
    console.log = (...values: unknown[]) => { out.push(values.join(" ")); };
    console.error = (...values: unknown[]) => { err.push(values.join(" ")); };
    try {
      saveConfig(hubConfig());
      const deps = {
        args,
        ...extraDeps,
      } as unknown as CliDispatchDeps;
      const code = await dispatchCommand({ kind: "command", command, args }, deps);
      return { code, out, err };
    } finally {
      console.log = log;
      console.error = error;
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(home);
    }
  }

  test("restore back names the gate instead of blaming a competing writer", async () => {
    const result = await runInHubHome("restore", ["restore", "back"], {
      findLiveProxy: async () => ({ pid: 4242, port: 10_100, hostname: "100.76.170.81", source: "config" as const }),
    });
    // Still a refusal — nothing was written — but for the stated reason.
    expect(result.code).toBe(2);
    const combined = [...result.out, ...result.err].join("\n");
    expect(combined).toContain(HUB_GATED_SKIP_MESSAGE);
    expect(combined).toContain("restore back did not change Codex");
    expect(combined).not.toContain(PHANTOM_CONFLICT);
  });

  test("restore back --json carries the same sentence in its envelope", async () => {
    const result = await runInHubHome("restore", ["restore", "back", "--json"], {
      findLiveProxy: async () => ({ pid: 4242, port: 10_100, hostname: "100.76.170.81", source: "config" as const }),
    });
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.out.join("\n")) as { success: boolean; message?: string };
    expect(envelope.success).toBe(false);
    expect(JSON.stringify(envelope)).toContain("This machine is a hub");
    expect(JSON.stringify(envelope)).not.toContain(PHANTOM_CONFLICT);
  });

  test("the sync result every caller prints carries the gate's reason and sentence", async () => {
    // Through `syncModelsToCodex` rather than the `sync` runner: the runner's own output is a
    // pass-through of these two fields, and reaching it for real would drag in the native
    // ownership probe (a launchctl/systemd call) this assertion has nothing to do with.
    const home = mkdtempSync(join(tmpdir(), "ocx-hub-gated-sync-"));
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      saveConfig(hubConfig());
      const { syncModelsToCodex } = await import("../../src/codex/sync");
      const result = await syncModelsToCodex(10_100, hubConfig(), null);
      expect(result.status).toBe("skipped");
      expect(result.skippedReason).toBe("hub-gated");
      expect(result.message).toContain(HUB_GATED_SKIP_MESSAGE);
      expect(result.message).not.toContain("Codex integration is OFF");
      // A skip is still a success: the gate is policy, not a failure.
      expect(result.ok).toBe(true);
      expect(result.catalogWritten).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(home);
    }
  });
});
