import { describe, expect, mock, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createChatgptCloudNetworkLifecycle } from "../../src/server/index/chatgpt-cloud-network-lifecycle";
import { cloudNetworkProxy, startCloudNetwork } from "../../src/chatgpt/cloud-network/runtime";
import { acquireCloudMapping, cloudHelperRequest } from "../../src/chatgpt/cloud-network/helper-client";
import { CloudHostsMapping, SYSTEM_CLOUD_MAPPING } from "../../src/chatgpt/cloud-network/hosts";
import { CLOUD_HOST, CloudNetworkError } from "../../src/chatgpt/cloud-network/contract";
import { chatgptDesktopSchema } from "../../src/config/schema/chatgpt-desktop";
import type { OcxConfig } from "../../src/types";
import { cloudFixture } from "../helpers/cloud-network-fixture";
import { cloudTestProxy } from "../helpers/cloud-network-proxy";

const config = (enabled = false): OcxConfig => ({ providers: {}, defaultProvider: "openai", chatgptDesktop: { cloudNetwork: enabled } });

test("cloud config is strictly opt-in and uses the existing proxy selection", () => {
  expect(chatgptDesktopSchema.parse({})).toEqual({});
  for (const cloudNetwork of [false, true]) expect(chatgptDesktopSchema.parse({ cloudNetwork }).cloudNetwork).toBe(cloudNetwork);
  expect(chatgptDesktopSchema.safeParse({ cloudNetwork: "true" }).success).toBe(false);
  expect(cloudNetworkProxy({ HTTPS_PROXY: "http://user:password@127.0.0.1:8123" })).toBe("http://user:password@127.0.0.1:8123");
  expect(cloudNetworkProxy({ ALL_PROXY: "socks5h://127.0.0.1:1080" })).toBe("socks5h://127.0.0.1:1080");
  expect(() => cloudNetworkProxy({})).toThrow("cloud_proxy_missing");
  expect(() => cloudNetworkProxy({ HTTPS_PROXY: "http://127.0.0.1:8123", NO_PROXY: ".chatgpt.com" })).toThrow("cloud_proxy_bypassed");
  expect(() => cloudNetworkProxy({ HTTPS_PROXY: "https://localhost" })).toThrow("cloud_proxy_loop");
});

describe.skipIf(process.platform === "win32")("formal mapping helper in isolated filesystem", () => {
  test("journal recovery preserves user edits, file mode and resolver ordering", () => {
    const f = cloudFixture();
    try {
      const original = f.read();
      f.mapping.apply();
      expect(f.flushes.at(-1)).toContain(SYSTEM_CLOUD_MAPPING);
      expect(existsSync(f.journal)).toBe(true);
      appendFileSync(f.hosts, "192.0.2.1 custom.test\n");
      f.mapping.recover();
      expect(f.read()).toBe(original + "192.0.2.1 custom.test\n");
      expect(f.flushes.at(-1)).not.toContain(CLOUD_HOST);
      expect(statSync(f.hosts).mode & 0o777).toBe(0o640);
      expect(existsSync(f.journal)).toBe(false);
      f.mapping.recover();
    } finally { f.cleanup(); }
  });

  test("cache-flush failure keeps the journal for recovery; edited blocks are not erased", () => {
    const f = cloudFixture();
    try {
      const failing = new CloudHostsMapping({ hosts: f.hosts, journal: f.journal }, () => { throw new Error("flush"); });
      expect(() => failing.apply()).toThrow("flush");
      expect(existsSync(f.journal)).toBe(true);
      f.mapping.recover();
      f.mapping.apply();
      writeFileSync(f.hosts, f.read().replace("::1 " + CLOUD_HOST, "::2 " + CLOUD_HOST));
      expect(() => f.mapping.recover()).toThrow("mapping_edited");
      expect(existsSync(f.journal)).toBe(true);
    } finally { f.cleanup(); }
  });

  test("existing cloud records are refused and helper ownership excludes other runtimes", async () => {
    const f = cloudFixture();
    const helper = await f.startHelper();
    try {
      appendFileSync(f.hosts, `192.0.2.1 ${CLOUD_HOST}\n`);
      await expect(acquireCloudMapping(f.socketPath)).rejects.toThrow("hostname_already_mapped");
      expect(f.read()).toContain("192.0.2.1");
      writeFileSync(f.hosts, "# restored fixture\n");
      const lease = await acquireCloudMapping(f.socketPath);
      expect((await cloudHelperRequest("status", f.socketPath)).state).toBe("active");
      expect((await cloudHelperRequest("recover", f.socketPath)).error).toBe("mapping_busy");
      await expect(acquireCloudMapping(f.socketPath)).rejects.toThrow("mapping_busy");
      await lease.release();
      expect(f.read()).toBe("# restored fixture\n");
    } finally { await helper.stop(); f.cleanup(); }
  });

  test("actual runtime preflights both listeners and upstream, acquires, then restores on stop", async () => {
    const f = cloudFixture();
    const helper = await f.startHelper(), proxy = await cloudTestProxy();
    try {
      const runtime = await startCloudNetwork({ helperSocket: f.socketPath, listenPort: 0, env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } });
      expect(runtime.endpoints.map(e => e.host)).toEqual(["127.0.0.1", "::1"]);
      expect(proxy.requests).toEqual([`CONNECT ${CLOUD_HOST}:443 HTTP/1.1`]);
      expect(f.read()).toContain(SYSTEM_CLOUD_MAPPING);
      await runtime.stop();
      expect(await runtime.lost).toBe(false);
      expect(f.read()).not.toContain(CLOUD_HOST);
      expect((await cloudHelperRequest("status", f.socketPath)).state).toBe("idle");
    } finally { await helper.stop(); await proxy.stop(); f.cleanup(); }
  });

  test("failed upstream never maps; lost helper closes runtime and reports failure", async () => {
    const f = cloudFixture();
    const helper = await f.startHelper(), proxy = await cloudTestProxy({ refuse: true });
    try {
      await expect(startCloudNetwork({ helperSocket: f.socketPath, listenPort: 0, env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } })).rejects.toThrow("cloud_listener_or_upstream_failed");
      expect(f.read()).not.toContain(CLOUD_HOST);
      const success = await cloudTestProxy();
      try {
        const runtime = await startCloudNetwork({ helperSocket: f.socketPath, listenPort: 0, env: { HTTPS_PROXY: `http://127.0.0.1:${success.port}` } });
        await helper.stop();
        expect(await runtime.lost).toBe(true);
        expect(f.read()).not.toContain(CLOUD_HOST);
      } finally { await success.stop(); }
    } finally { await helper.stop(); await proxy.stop(); f.cleanup(); }
  });
});

describe("server-owned cloud lifecycle", () => {
  for (const reason of ["mapping_edited", "resolver_flush_failed", "mapping_journal_invalid", "mapping_io_failed", "helper_disconnected"]) {
    test(`startup recovery failure ${reason} remains pending when disabling without a handle`, async () => {
      const saved = config(true);
      let recoveryFails = true, starts = 0;
      const recover = mock(async () => { if (recoveryFails) throw new CloudNetworkError(reason); });
      const lifecycle = createChatgptCloudNetworkLifecycle({ platform: "darwin", warn: () => {}, recover,
        start: async () => {
          if (++starts > 1) throw new CloudNetworkError("cloud_proxy_missing");
          throw reason === "helper_disconnected" ? new CloudNetworkError(reason)
            : CloudNetworkError.fromReply({ protocol: 1, ok: false, state: "recovery_required", error: reason }, "mapping_failed");
        } });
      lifecycle.start(saved); await lifecycle.settled();
      expect(lifecycle.status()).toMatchObject({ configured: true, state: "unavailable", reason });
      if (reason === "helper_disconnected") {
        await lifecycle.configure(true, () => {});
        expect(lifecycle.status().reason).toBe("cloud_proxy_missing");
      }
      const persist = () => { saved.chatgptDesktop!.cloudNetwork = false; };
      await expect(lifecycle.configure(false, persist)).rejects.toThrow(reason);
      expect(lifecycle.status()).toMatchObject({ configured: false, state: "unavailable", reason: "recovery_failed" });
      recoveryFails = false;
      expect(await lifecycle.configure(false, persist)).toMatchObject({ configured: false, state: "disabled" });
      expect(recover).toHaveBeenCalledTimes(2);
      await lifecycle.stop();
      expect(recover).toHaveBeenCalledTimes(2);
    });
  }

  test("shutdown retries a startup recovery failure before reporting stopped", async () => {
    let recoveryFails = true;
    const recover = mock(async () => { if (recoveryFails) throw new CloudNetworkError("mapping_edited"); });
    const lifecycle = createChatgptCloudNetworkLifecycle({ platform: "darwin", warn: () => {}, recover,
      start: async () => { throw CloudNetworkError.fromReply({ protocol: 1, ok: false, state: "recovery_required", error: "mapping_edited" }, "mapping_failed"); } });
    lifecycle.start(config(true)); await lifecycle.settled();
    await expect(lifecycle.stop()).rejects.toThrow("mapping_edited");
    expect(lifecycle.status()).toMatchObject({ state: "unavailable", reason: "recovery_failed" });
    recoveryFails = false;
    await lifecycle.stop();
    expect(lifecycle.status().state).toBe("stopped");
    expect(lifecycle.status().reason).toBeUndefined();
    expect(recover).toHaveBeenCalledTimes(2);
    await lifecycle.stop();
    expect(recover).toHaveBeenCalledTimes(2);
  });

  for (const action of ["disable", "stop"] as const) test(`helper loss survives a failed re-enable until ${action} recovers`, async () => {
    const saved = config(true);
    let lose!: (lost: boolean) => void;
    const lost = new Promise<boolean>(resolve => { lose = resolve; });
    let starts = 0, recoveryFails = true;
    const recover = mock(async () => { if (recoveryFails) throw new CloudNetworkError("resolver_flush_failed"); });
    const lifecycle = createChatgptCloudNetworkLifecycle({ platform: "darwin", warn: () => {}, recover,
      start: async () => {
        if (++starts > 1) throw new CloudNetworkError("cloud_proxy_missing");
        return { endpoints: [], stop: async () => {}, lost };
      } });
    lifecycle.start(saved); await lifecycle.settled();
    lose(true); await Bun.sleep(0);
    expect(lifecycle.status().reason).toBe("helper_disconnected");
    await lifecycle.configure(true, () => {});
    expect(lifecycle.status().reason).toBe("cloud_proxy_missing");
    const finish = () => action === "disable"
      ? lifecycle.configure(false, () => { saved.chatgptDesktop!.cloudNetwork = false; }) : lifecycle.stop();
    await expect(finish()).rejects.toThrow("resolver_flush_failed");
    expect(lifecycle.status()).toMatchObject({ state: "unavailable", reason: "recovery_failed" });
    recoveryFails = false;
    await finish();
    expect(lifecycle.status().state).toBe(action === "disable" ? "disabled" : "stopped");
    expect(lifecycle.status().reason).toBeUndefined();
    expect(recover).toHaveBeenCalledTimes(2);
    await lifecycle.stop();
    expect(recover).toHaveBeenCalledTimes(2);
  });

  test("successful reacquisition clears startup recovery debt before normal release", async () => {
    const saved = config(true);
    let starts = 0;
    const recover = mock(async () => { throw new Error("unexpected recovery without a handle"); });
    const stop = mock(async () => {});
    const lifecycle = createChatgptCloudNetworkLifecycle({ platform: "darwin", warn: () => {}, recover,
      start: async () => {
        if (++starts === 1) throw CloudNetworkError.fromReply({ protocol: 1, ok: false, state: "recovery_required", error: "resolver_flush_failed" }, "mapping_failed");
        return { endpoints: [], stop, lost: new Promise<boolean>(() => {}) };
      } });
    lifecycle.start(saved); await lifecycle.settled();
    expect((await lifecycle.configure(true, () => {})).state).toBe("active");
    expect((await lifecycle.configure(false, () => { saved.chatgptDesktop!.cloudNetwork = false; })).state).toBe("disabled");
    await lifecycle.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
  });

  test("retrying disable after failed release cannot report disabled before recovery succeeds", async () => {
    const saved = config(true);
    const stop = mock(async () => { throw new CloudNetworkError("resolver_flush_failed"); });
    let flushFails = true;
    const recover = mock(async () => { if (flushFails) throw new CloudNetworkError("resolver_flush_failed"); });
    const lifecycle = createChatgptCloudNetworkLifecycle({ platform: "darwin", warn: () => {}, recover,
      start: async () => ({ endpoints: [], stop, lost: new Promise<boolean>(() => {}) }) });
    lifecycle.start(saved); await lifecycle.settled();
    const persist = () => { saved.chatgptDesktop!.cloudNetwork = false; };
    await expect(lifecycle.configure(false, persist)).rejects.toThrow("resolver_flush_failed");
    await expect(lifecycle.configure(false, persist)).rejects.toThrow("resolver_flush_failed");
    expect(lifecycle.status()).toMatchObject({ configured: false, state: "unavailable", reason: "recovery_failed" });
    flushFails = false;
    expect(await lifecycle.configure(false, persist)).toMatchObject({ configured: false, state: "disabled" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(2);
    await lifecycle.stop();
  });

  test("default-off, client-role and other platforms do not start transport", async () => {
    const start = mock(async () => { throw new Error("must not start"); });
    for (const [enabled, platform, client] of [[false, "darwin", false], [true, "linux", false], [true, "darwin", true]] as const) {
      const lifecycle = createChatgptCloudNetworkLifecycle({ start, platform, warn: () => {} });
      lifecycle.start({ ...config(enabled), ...(client ? { runtimeRole: "client" } : {}) });
      await lifecycle.settled(); await lifecycle.stop();
    }
    expect(start).not.toHaveBeenCalled();
  });

  test("shutdown joins in-flight activation and never reports a failed optional start as active", async () => {
    let ready!: (value: any) => void;
    const pending = new Promise<any>(resolve => { ready = resolve; });
    const stop = mock(async () => {});
    const lifecycle = createChatgptCloudNetworkLifecycle({ start: () => pending, platform: "darwin" });
    lifecycle.start(config(true));
    await Bun.sleep(0);
    const stopped = lifecycle.stop();
    ready({ endpoints: [], stop, lost: new Promise(() => {}) });
    await stopped;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.status().state).toBe("stopped");
    const failed = createChatgptCloudNetworkLifecycle({ platform: "darwin", warn: () => {}, start: async () => { throw new CloudNetworkError("helper_unavailable"); } });
    failed.start(config(true)); await failed.settled();
    expect(failed.status()).toEqual({ configured: true, state: "unavailable", reason: "helper_unavailable", applicationHandshake: "unverified" });
    await failed.stop();
  });
});
