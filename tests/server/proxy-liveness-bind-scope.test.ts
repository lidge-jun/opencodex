import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createTempHome } from "../helpers/temp-home";
import { findLiveProxy, observeProxyLiveness, type LivenessIo } from "../../src/server/proxy-liveness";
import { standaloneCodexRoutingTarget } from "../../src/codex/inject/routing-target";
import { ensureGrokFenceMatchesDesired } from "../../src/cli/ensure-desired-integrations";
import { injectGrokConfig, type GrokInjectResult } from "../../src/grok/inject";
import { syncGrokConfig } from "../../src/grok/sync";
import type { OcxConfig } from "../../src/types";

for (const hostname of ["0.0.0.0", "::", "[::]", "*", "127.0.0.1"]) {
for (const source of ["runtime", "orphan", "config"] as const) {
  test(`late ${source} discovery preserves ${hostname} admission through the actual Grok writer`, async () => {
    const home = createTempHome("ocx-live-bind-scope-");
    try {
      const grokHome = home.path("grok"); mkdirSync(grokHome);
      const config: OcxConfig = { port: 10123, hostname, defaultProvider: "openai", providers: {},
        clientIntegrations: { grok: { enabled: true } } };
      let answers = false;
      const io: LivenessIo = {
        readPidFn: () => source === "runtime" ? 4242 : null,
        readRuntimeFn: () => source === "config" ? null : { pid: 4242, port: config.port!, hostname },
        verifyPidFn: pid => pid, configFn: () => config, loopbackAvailabilityFn: () => "available",
        fetchFn: (async () => {
          if (!answers) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
          return Response.json({ service: "opencodex", pid: 4242 });
        }) as typeof fetch,
      };
      expect(await findLiveProxy(io)).toBeNull(); // The early probe misses the owner.
      answers = true;
      const observed = await observeProxyLiveness(io);
      expect(observed.kind).toBe("live");
      expect(observed.live?.hostname).toBe(hostname);
      expect(observed.live?.probeHostname).toBe("127.0.0.1");
      expect(standaloneCodexRoutingTarget(config.port!, { hostname: observed.live!.hostname })
        .requiresAdmissionToken).toBe(hostname !== "127.0.0.1");
      let written: GrokInjectResult | undefined;
      await ensureGrokFenceMatchesDesired(config.port!, { hostname: observed.live!.hostname }, {
        // A changed persisted loopback config must not replace the observed wildcard bind.
        loadConfig: () => ({ ...config, hostname: "127.0.0.1" }),
        syncGrokConfig: async (port, current, opts) => written = await syncGrokConfig(port, current,
          { ...opts, grokHome }, { fetchAllModels: async () => [], injectGrokConfig }),
        stripGrokConfig: () => { throw new Error("unexpected strip"); },
        removeDesktop3pStandardPivot: () => { throw new Error("unused desktop seam"); },
        log() {}, error: message => { throw new Error(message); },
      });
      if (hostname === "127.0.0.1") {
        expect(written).toMatchObject({ ok: true, changed: true });
        expect(readFileSync(home.path("grok", "config.toml"), "utf8")).toContain('api_key = "opencodex-loopback"');
      } else {
        expect(written).toMatchObject({ ok: true, changed: false, skippedReason: "non-loopback" });
        expect(existsSync(home.path("grok", "config.toml"))).toBe(false);
      }
    } finally { home.remove(); }
  });
}
}
