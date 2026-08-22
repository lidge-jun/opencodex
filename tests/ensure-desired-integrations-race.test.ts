import { describe, expect, test } from "bun:test";
import {
  reconcileEnsureDesiredIntegrations,
  type EnsureDesiredIntegrationsDeps,
} from "../src/cli/ensure-desired-integrations";
import type { OcxConfig } from "../src/types";
import type { GrokInjectResult } from "../src/grok/inject";
import type { Desktop3pRemovalResult } from "../src/claude/desktop-3p";

function config(overrides: {
  grok?: boolean;
  desktop?: boolean;
  hostname?: string;
  fingerprint?: string;
} = {}): OcxConfig {
  const clientIntegrations: NonNullable<OcxConfig["clientIntegrations"]> = {};
  if (overrides.grok === false) clientIntegrations.grok = false;
  if (overrides.desktop === false) clientIntegrations["claude-desktop"] = false;
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    hostname: overrides.hostname,
    clientIntegrations: Object.keys(clientIntegrations).length > 0 ? clientIntegrations : undefined,
    claudeCode: {
      desktopProfile: {
        version: 1,
        assignments: {},
        defaults: { opus: null, fable: null, sonnet: null, haiku: null },
        appliedFingerprint: overrides.fingerprint ?? "fp-stale",
      },
    },
  };
}

function okGrok(changed = true): GrokInjectResult {
  return { ok: true, changed, message: changed ? "updated" : "unchanged" };
}

function removedDesktop(): Desktop3pRemovalResult {
  return { ok: true, changed: true, kind: "removed", libraryPath: "/tmp/desktop" };
}

function harness(initial: OcxConfig) {
  let current = initial;
  const grokActions: Array<{ action: "strip" | "sync"; config: OcxConfig; hostname?: string }> = [];
  const desktopActions: Array<{ action: "remove" | "skip"; fingerprint: string | null }> = [];
  const deps: EnsureDesiredIntegrationsDeps = {
    loadConfig: () => current,
    stripGrokConfig: () => {
      grokActions.push({ action: "strip", config: current });
      return okGrok(true);
    },
    syncGrokConfig: async (_port, cfg, opts) => {
      grokActions.push({ action: "sync", config: cfg, hostname: opts?.hostname });
      return okGrok(true);
    },
    removeDesktop3pStandardPivot: options => {
      desktopActions.push({
        action: "remove",
        fingerprint: options.appliedFingerprint ?? null,
      });
      return removedDesktop();
    },
    log: () => {},
    error: () => {},
  };
  return {
    grokActions,
    desktopActions,
    deps,
    flip(next: OcxConfig) {
      current = next;
    },
  };
}

/**
 * Live-proxy branch: snapshot, then model-sync/env (the race window), then mutate.
 * Spawned-proxy branch: snapshot, then waitForProxy, then mutate with the current hostname.
 */
async function runLiveBranch(
  h: ReturnType<typeof harness>,
  next: OcxConfig,
  liveHostname = "127.0.0.1",
): Promise<void> {
  const stale = h.deps.loadConfig();
  void stale;
  h.flip(next);
  await reconcileEnsureDesiredIntegrations(
    10100,
    { kind: "live", hostname: liveHostname },
    h.deps,
  );
}

async function runSpawnedBranch(h: ReturnType<typeof harness>, next: OcxConfig): Promise<void> {
  const stale = h.deps.loadConfig();
  void stale;
  h.flip(next);
  await reconcileEnsureDesiredIntegrations(10100, { kind: "spawned" }, h.deps);
}

describe("ensure desired-state races", () => {
  test("live-proxy OFF→ON uses the current ON snapshot instead of stripping", async () => {
    const staleOff = config({ grok: false, desktop: false, hostname: "stale-host", fingerprint: "fp-off" });
    const currentOn = config({ hostname: "fresh-host", fingerprint: "fp-on" });
    const h = harness(staleOff);
    await runLiveBranch(h, currentOn, "live-bound");
    expect(h.grokActions).toEqual([{ action: "sync", config: currentOn, hostname: "live-bound" }]);
    expect(h.desktopActions).toEqual([]);
  });

  test("live-proxy ON→OFF uses the current OFF snapshot instead of rewriting files", async () => {
    const staleOn = config({ hostname: "stale-host", fingerprint: "fp-on" });
    const currentOff = config({ grok: false, desktop: false, hostname: "fresh-host", fingerprint: "fp-off" });
    const h = harness(staleOn);
    await runLiveBranch(h, currentOff, "live-bound");
    expect(h.grokActions).toEqual([{ action: "strip", config: currentOff }]);
    expect(h.desktopActions).toEqual([{ action: "remove", fingerprint: "fp-off" }]);
  });

  test("spawned-proxy OFF→ON syncs from the current config, including hostname", async () => {
    const staleOff = config({ grok: false, desktop: false, hostname: "stale-host", fingerprint: "fp-off" });
    const currentOn = config({ hostname: "fresh-host", fingerprint: "fp-on" });
    const h = harness(staleOff);
    await runSpawnedBranch(h, currentOn);
    expect(h.grokActions).toEqual([{ action: "sync", config: currentOn, hostname: "fresh-host" }]);
    expect(h.desktopActions).toEqual([]);
  });

  test("spawned-proxy ON→OFF strips and removes from the current OFF snapshot", async () => {
    const staleOn = config({ hostname: "stale-host", fingerprint: "fp-on" });
    const currentOff = config({ grok: false, desktop: false, hostname: "fresh-host", fingerprint: "fp-off" });
    const h = harness(staleOn);
    await runSpawnedBranch(h, currentOff);
    expect(h.grokActions).toEqual([{ action: "strip", config: currentOff }]);
    expect(h.desktopActions).toEqual([{ action: "remove", fingerprint: "fp-off" }]);
  });
});
