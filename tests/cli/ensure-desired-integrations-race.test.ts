import { describe, expect, test } from "bun:test";
import {
  reconcileEnsureDesiredIntegrations,
  type EnsureDesiredIntegrationsDeps,
} from "../../src/cli/ensure-desired-integrations";
import type { OcxConfig } from "../../src/types";
import type { GrokInjectResult } from "../../src/grok/inject";
import type { Desktop3pRemovalResult } from "../../src/claude/desktop-3p";

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

for (const [kind, stale, shouldRefresh] of [
  ["absent", false, true], ["stale", true, true], ["applied", false, false], ["foreign", false, false],
] as const) {
  test(`CLI-only ${kind} env refreshes before Desktop-off cleanup when needed`, async () => {
    const current = config({ desktop: false });
    current.claudeCode = { ...current.claudeCode, cliFirstParty: true, desktopMode: "gateway" };
    const h = harness(current);
    const calls: string[] = [];
    h.deps.inspectDesktopFirstParty = () => ({
      interceptEnabled: true, proxyPort: 10200, caCertPath: "/tmp/owned-ca.pem",
      settings: kind === "absent" ? { kind: "absent" } : kind === "foreign"
        ? { kind: "foreign", env: { HTTPS_PROXY: "http://other:8080" } }
        : { kind, env: { HTTPS_PROXY: "http://opencodex:t@127.0.0.1:10200", NODE_EXTRA_CA_CERTS: "/tmp/owned-ca.pem" } },
      applied: kind === "applied", stale,
    });
    h.deps.observeClaudeDesktopMode = () => ({});
    h.deps.reconcileClaudeFirstPartySettings = (_config, desired) => {
      expect(desired).toEqual({ desktop: false, cli: true });
      calls.push("refresh");
      return { ok: true, action: "applied", changed: true, path: "/tmp/settings.json" };
    };
    h.deps.findLiveProxyImpl = async () => null;
    h.deps.removeDesktopPickerArtifacts = async () => ({ ok: true });
    h.deps.removeDesktopFirstParty = () => {
      calls.push("desktop-off");
      return { ok: true, changed: false, path: "/tmp/settings.json", retainedFor: "cli" };
    };
    await runLiveBranch(h, current);
    expect(calls).toEqual(shouldRefresh ? ["refresh", "desktop-off"] : ["desktop-off"]);
  });
}

test("CLI intent with disabled intercept retains the env through Desktop-off cleanup", async () => {
  const current = config({ desktop: false });
  current.claudeCode = { ...current.claudeCode, cliFirstParty: true,
    intercept: { enabled: false }, desktopMode: "gateway" };
  const h = harness(current);
  const calls: string[] = [];
  h.deps.inspectDesktopFirstParty = () => ({ interceptEnabled: false, proxyPort: 10200,
    caCertPath: "/tmp/owned-ca.pem", settings: { kind: "applied", env: {
      HTTPS_PROXY: "http://opencodex:t@127.0.0.1:10200", NODE_EXTRA_CA_CERTS: "/tmp/owned-ca.pem" } },
    applied: true, stale: false });
  h.deps.observeClaudeDesktopMode = () => ({});
  h.deps.reconcileClaudeFirstPartySettings = () => {
    calls.push("refresh");
    return { ok: true, action: "unchanged", changed: false, path: "/tmp/settings.json" };
  };
  h.deps.findLiveProxyImpl = async () => null;
  h.deps.removeDesktopPickerArtifacts = async () => ({ ok: true });
  h.deps.removeDesktopFirstParty = () => {
    calls.push("retained");
    return { ok: true, changed: false, path: "/tmp/settings.json", retainedFor: "cli" };
  };
  await runLiveBranch(h, current);
  expect(calls).toEqual(["refresh", "retained"]);
});

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
