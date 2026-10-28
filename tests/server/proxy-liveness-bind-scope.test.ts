import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createTempHome } from "../helpers/temp-home";
import { findLiveProxy, observeProxyLiveness, type LivenessIo } from "../../src/server/proxy-liveness";
import { standaloneCodexRoutingTarget } from "../../src/codex/inject/routing-target";
import { reconcileEnsureDesiredIntegrations } from "../../src/cli/ensure-desired-integrations";
import { injectGrokConfig, type GrokInjectResult } from "../../src/grok/inject";
import { syncGrokConfig } from "../../src/grok/sync";
import type { OcxConfig } from "../../src/types";

const binds = [
  { label: "omitted", hostname: undefined, expected: "127.0.0.1", loopback: true },
  { label: "empty", hostname: "", expected: "127.0.0.1", loopback: true },
  { label: "blank", hostname: " \t ", expected: "127.0.0.1", loopback: true },
  { label: "IPv4 wildcard", hostname: "0.0.0.0", expected: "0.0.0.0", loopback: false },
  { label: "IPv6 wildcard", hostname: "::", expected: "::", loopback: false },
  { label: "bracketed wildcard", hostname: "[::]", expected: "[::]", loopback: false },
  { label: "asterisk wildcard", hostname: "*", expected: "*", loopback: false },
  { label: "explicit loopback", hostname: "127.0.0.1", expected: "127.0.0.1", loopback: true },
];

for (const { label, hostname, expected, loopback } of binds) {
for (const source of ["runtime", "orphan", "config"] as const) {
for (const route of ["early", "late"] as const) {
  test(`${route} ${source} discovery preserves ${label} admission through ensure and the actual Grok writer`, async () => {
    const home = createTempHome("ocx-live-bind-scope-");
    try {
      const grokHome = home.path("grok"); mkdirSync(grokHome);
      const config: OcxConfig = { port: 10123, hostname, defaultProvider: "openai", providers: {},
        clientIntegrations: { grok: { enabled: true }, "claude-desktop": { enabled: true } },
        claudeCode: { desktopMode: "gateway" } };
      let answers = route === "early";
      const io: LivenessIo = {
        readPidFn: () => source === "runtime" ? 4242 : null,
        readRuntimeFn: () => source === "config" ? null : { pid: 4242, port: config.port!, hostname },
        verifyPidFn: pid => pid, configFn: () => config, loopbackAvailabilityFn: () => "available",
        fetchFn: (async () => {
          if (!answers) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
          return Response.json({ service: "opencodex", pid: 4242 });
        }) as typeof fetch,
      };
      if (route === "late") {
        expect(await findLiveProxy(io)).toBeNull(); // The early probe misses the owner.
        answers = true;
      }
      const live = route === "early" ? await findLiveProxy(io) : (await observeProxyLiveness(io)).live;
      expect(live).not.toBeNull();
      let written: GrokInjectResult | undefined;
      await reconcileEnsureDesiredIntegrations(live!.port, { kind: "live", ...live! }, {
        // A later config with the opposite scope must not replace the live bind, even
        // when the runtime/config candidate omitted the default hostname or left it blank.
        loadConfig: () => ({ ...config, hostname: loopback ? "0.0.0.0" : "127.0.0.1" }),
        syncGrokConfig: async (port, current, opts) => written = await syncGrokConfig(port, current,
          { ...opts, grokHome }, { fetchAllModels: async () => [], injectGrokConfig }),
        stripGrokConfig: () => { throw new Error("unexpected strip"); },
        observeClaudeDesktopMode: () => ({}),
        removeDesktop3pStandardPivot: () => { throw new Error("unused desktop seam"); },
        log() {}, error: message => { throw new Error(message); },
      });
      if (loopback) {
        expect(written).toMatchObject({ ok: true, changed: true });
        expect(readFileSync(home.path("grok", "config.toml"), "utf8")).toContain('api_key = "opencodex-loopback"');
      } else {
        expect(written).toMatchObject({ ok: true, changed: false, skippedReason: "non-loopback" });
        expect(existsSync(home.path("grok", "config.toml"))).toBe(false);
      }
      expect(live!.hostname).toBe(expected);
      expect(live!.probeHostname).toBe(route === "late" ? "127.0.0.1" : undefined);
      expect(standaloneCodexRoutingTarget(live!.port, { hostname: live!.hostname })
        .requiresAdmissionToken).toBe(!loopback);
    } finally { home.remove(); }
  });
}
}
}

for (const source of ["runtime", "orphan", "config"] as const) {
  test(`late ${source} recovery writes the responding IPv4 address for an IPv6 bind candidate`, async () => {
    const home = createTempHome("ocx-live-probe-destination-");
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({ service: "opencodex", pid: process.pid }) });
    try {
      const grokHome = home.path("grok"); mkdirSync(grokHome);
      const config: OcxConfig = { port: listener.port!, hostname: "::1", defaultProvider: "openai", providers: {},
        clientIntegrations: { grok: { enabled: true }, "claude-desktop": { enabled: true } },
        claudeCode: { desktopMode: "gateway" } };
      const io: LivenessIo = {
        readPidFn: () => source === "runtime" ? process.pid : null,
        readRuntimeFn: () => source === "config" ? null : { pid: process.pid, port: listener.port!, hostname: "::1" },
        verifyPidFn: pid => pid, configFn: () => config, attempts: 1,
        loopbackAvailabilityFn: () => "available",
      };
      expect(await findLiveProxy(io)).toBeNull();
      const observed = await observeProxyLiveness(io);
      expect(observed.kind).toBe("live");
      const live = observed.live!;
      expect(live).toMatchObject({ hostname: "::1", probeHostname: "127.0.0.1" });
      await reconcileEnsureDesiredIntegrations(live.port, { kind: "live", ...live }, {
        loadConfig: () => config,
        syncGrokConfig: (port, current, opts) => syncGrokConfig(port, current, { ...opts, grokHome },
          { fetchAllModels: async () => [], injectGrokConfig }),
        stripGrokConfig: () => { throw new Error("unexpected strip"); },
        observeClaudeDesktopMode: () => ({}),
        removeDesktop3pStandardPivot: () => { throw new Error("unused desktop seam"); },
        log() {}, error: message => { throw new Error(message); },
      });
      const written = Bun.TOML.parse(readFileSync(home.path("grok", "config.toml"), "utf8")) as {
        model_providers: { opencodex: { base_url: string } };
      };
      expect(written.model_providers.opencodex.base_url).toBe(`http://127.0.0.1:${listener.port}/v1`);
      expect((await fetch(written.model_providers.opencodex.base_url)).ok).toBe(true);
    } finally { await listener.stop(true); home.remove(); }
  });
}
