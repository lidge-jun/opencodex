import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { cloudFixture } from "../helpers/cloud-network-fixture";
import { cloudTestProxy } from "../helpers/cloud-network-proxy";
import { repoPath } from "../helpers/repo-root";
import { CLOUD_HOST, CloudNetworkError } from "../../src/chatgpt/cloud-network/contract";
import { CloudHostsMapping, SYSTEM_CLOUD_MAPPING } from "../../src/chatgpt/cloud-network/hosts";
import { withCloudHelperLock } from "../../src/chatgpt/cloud-network/helper-system";
import { serveCloudMapping } from "../../src/chatgpt/cloud-network/helper";
import { acquireCloudMapping, cloudHelperRequest } from "../../src/chatgpt/cloud-network/helper-client";

describe.skipIf(process.platform === "win32")("one mapping implementation for normal and crash recovery", () => {
  test("journal before replacement and abandoned mapping recover without losing unrelated bytes", () => {
    const f = cloudFixture();
    try {
      writeFileSync(f.hosts, "127.0.0.1 localhost");
      writeFileSync(f.journal, SYSTEM_CLOUD_MAPPING);
      f.mapping.recover();
      expect(f.read()).toBe("127.0.0.1 localhost");
      f.mapping.apply();
      appendFileSync(f.hosts, "\n192.0.2.3 keep.test\n");
      const restarted = new CloudHostsMapping({ hosts: f.hosts, journal: f.journal }, () => {});
      restarted.recover(); restarted.recover();
      expect(f.read()).toBe("127.0.0.1 localhost\n192.0.2.3 keep.test\n");
      expect(existsSync(f.journal)).toBe(false);
    } finally { f.cleanup(); }
  });

  test("unknown journals and redirected hosts are preserved for inspection", () => {
    const f = cloudFixture();
    try {
      const original = f.read();
      writeFileSync(f.journal, "unknown");
      expect(() => f.mapping.recover()).toThrow("mapping_journal_invalid");
      expect(f.read()).toBe(original);
      unlinkSync(f.journal);
      const outside = f.hosts + ".original";
      writeFileSync(outside, original); unlinkSync(f.hosts); symlinkSync(outside, f.hosts);
      expect(() => f.mapping.apply()).toThrow("hosts_not_regular");
      expect(f.read()).toBe(original);
      expect(existsSync(f.journal)).toBe(false);
    } finally { f.cleanup(); }
  });

  test("OS-held helper lock excludes a second owner and releases on completion", async () => {
    const f = cloudFixture();
    try {
      await withCloudHelperLock(f.root, async () => {
        await expect(withCloudHelperLock(f.root, async () => {})).rejects.toThrow();
      });
      await withCloudHelperLock(f.root, async () => { f.mapping.recover(); });
    } finally { f.cleanup(); }
  });

  test("failed resolver recovery retains its journal and error until an explicit retry succeeds", async () => {
    const f = cloudFixture();
    let failFlush = false;
    const mapping = new CloudHostsMapping({ hosts: f.hosts, journal: f.journal }, () => {
      if (failFlush) throw new CloudNetworkError("resolver_flush_failed");
    });
    const helper = await serveCloudMapping({ socketPath: f.socketPath, mapping, uid: process.getuid!(), gid: process.getgid!() });
    try {
      const lease = await acquireCloudMapping(f.socketPath);
      failFlush = true;
      await expect(lease.release()).rejects.toThrow("resolver_flush_failed");
      expect(f.read()).not.toContain(CLOUD_HOST);
      expect(existsSync(f.journal)).toBe(true);
      expect(await cloudHelperRequest("status", f.socketPath)).toMatchObject({ ok: false, state: "recovery_required", error: "resolver_flush_failed" });
      failFlush = false;
      expect(await cloudHelperRequest("recover", f.socketPath)).toMatchObject({ ok: true, state: "idle" });
      expect(existsSync(f.journal)).toBe(false);
      const next = await acquireCloudMapping(f.socketPath);
      await next.release();
      expect(helper.state()).toBe("idle");
    } finally { failFlush = false; await helper.stop(); f.cleanup(); }
  });
});

function launch(role: string, root: string, port?: number) {
  const env = { ...process.env };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) delete env[key];
  return Bun.spawn([process.execPath, repoPath("tests/helpers/cloud-network-process.ts"), role, root, String(port ?? "")], { env, stdout: "pipe", stderr: "pipe" });
}

async function ready(child: ReturnType<typeof launch>) {
  const reader = child.stdout.getReader();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error(`Fixture exited: ${await new Response(child.stderr).text()}`);
      text += new TextDecoder().decode(next.value);
    }
    expect(JSON.parse(text.split("\n")[0]!).ready).toBe(true);
  } finally { reader.releaseLock(); }
}

async function waitRestored(f: ReturnType<typeof cloudFixture>) {
  for (let i = 0; i < 100 && f.read().includes(CLOUD_HOST); i++) await Bun.sleep(10);
  expect(f.read()).not.toContain(CLOUD_HOST);
  expect(existsSync(f.journal)).toBe(false);
}

describe.skipIf(process.platform === "win32")("integrated recovery across actual process death", () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const) test(`runtime ${signal} restores through its installed-helper connection`, async () => {
    const f = cloudFixture(), proxy = await cloudTestProxy();
    const helper = launch("helper", f.root);
    let runtime: ReturnType<typeof launch> | undefined;
    try {
      await ready(helper);
      runtime = launch("runtime", f.root, proxy.port); await ready(runtime);
      expect(f.read()).toContain(CLOUD_HOST);
      runtime.kill(signal); await runtime.exited;
      await waitRestored(f);
      expect(helper.exitCode).toBeNull();
    } finally {
      runtime?.kill("SIGKILL"); if (runtime) await runtime.exited;
      helper.kill("SIGTERM"); await helper.exited;
      await proxy.stop(); f.cleanup();
    }
  });

  test("helper SIGKILL leaves a journal; a replacement recovers before accepting a new lease", async () => {
    const f = cloudFixture(), proxy = await cloudTestProxy();
    let helper = launch("helper", f.root);
    let runtime: ReturnType<typeof launch> | undefined;
    try {
      await ready(helper);
      runtime = launch("runtime", f.root, proxy.port); await ready(runtime);
      helper.kill("SIGKILL"); await helper.exited;
      expect(existsSync(f.journal)).toBe(true);
      helper = launch("helper", f.root); await ready(helper);
      await waitRestored(f);
      runtime.kill("SIGKILL"); await runtime.exited;
      runtime = launch("runtime", f.root, proxy.port); await ready(runtime);
      expect(f.read()).toContain(CLOUD_HOST);
      runtime.kill("SIGTERM"); await runtime.exited; await waitRestored(f);
    } finally {
      runtime?.kill("SIGKILL"); if (runtime) await runtime.exited;
      helper.kill("SIGTERM"); await helper.exited;
      await proxy.stop(); f.cleanup();
    }
  });
});
