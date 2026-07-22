import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import {
  CLOUDFLARE_TUNNEL_ORIGIN_HOST,
  ManagedCloudflareTunnelController,
  buildCloudflaredLaunch,
  normalizeNamedPublicUrl,
  parseCloudflaredReadyUrl,
  parseQuickTunnelUrl,
} from "../src/server/cloudflare-tunnel";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedWith: NodeJS.Signals[] = [];
  exitCode: number | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith.push(signal);
    return true;
  }

  spawned(): void { this.emit("spawn"); }
  close(code = 0): void {
    this.exitCode = code;
    this.emit("close", code, null);
  }
}

function fakeSpawner(child: FakeChild, calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }>) {
  return ((file: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ file, args: [...args], options });
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
}

const startOptions = {
  originUrl: "http://127.0.0.1:54321",
  actualPort: 54321,
  configuredPort: 54321,
};
const READY_METRICS_LINE = "Starting metrics server on 127.0.0.1:32123/metrics\n";
const readyFetch = async () => new Response(null, { status: 200 });

describe("Cloudflare Tunnel launch configuration", () => {
  test("accepts only exact HTTPS trycloudflare origins", () => {
    expect(parseQuickTunnelUrl("ready https://safe-name.trycloudflare.com now"))
      .toBe("https://safe-name.trycloudflare.com");
    expect(parseQuickTunnelUrl("│ https://one.two.trycloudflare.com │"))
      .toBe("https://one.two.trycloudflare.com");
    for (const value of [
      "http://safe.trycloudflare.com",
      "https://trycloudflare.com",
      "https://safe.trycloudflare.com.evil.example",
      "https://safe.trycloudflare.com/private",
      "https://-bad.trycloudflare.com",
      "https://bad-.trycloudflare.com",
      "https://bad..name.trycloudflare.com",
    ]) expect(parseQuickTunnelUrl(value)).toBeNull();
  });

  test("builds a shell-free Quick Tunnel with the protected origin host", () => {
    const launch = buildCloudflaredLaunch(startOptions, {
      env: { TUNNEL_TOKEN: "stale", TUNNEL_TOKEN_FILE: "/stale-token" },
      homeDir: "/isolated-home",
      exists: () => false,
    });
    expect(launch).toMatchObject({
      mode: "quick",
      binary: "cloudflared",
      publicUrl: null,
      supportsSse: false,
      args: [
        "tunnel", "--no-autoupdate", "--loglevel", "info",
        "--metrics", "127.0.0.1:0",
        "--http-host-header", CLOUDFLARE_TUNNEL_ORIGIN_HOST,
        "--url", startOptions.originUrl,
      ],
    });
    if (!("status" in launch)) {
      expect(launch.env.TUNNEL_TOKEN).toBeUndefined();
      expect(launch.env.TUNNEL_TOKEN_FILE).toBeUndefined();
    }
  });

  test("does not modify an existing user cloudflared config for Quick Tunnel", () => {
    const launch = buildCloudflaredLaunch(startOptions, {
      env: {},
      homeDir: "/isolated-home",
      exists: path => path.endsWith("config.yml"),
    });
    expect(launch).toMatchObject({ status: "error", mode: "quick", publicUrl: null });
    expect("error" in launch ? launch.error : "").toContain("config.yml");
  });

  test("keeps Named Tunnel tokens out of argv and requires the fixed configured port", () => {
    const token = "secret-runner-token";
    const env = {
      OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN: token,
      OPENCODEX_CLOUDFLARE_PUBLIC_URL: "https://ocx.example.com",
      TUNNEL_TOKEN: "stale-token",
      TUNNEL_TOKEN_FILE: "/stale-token",
    };
    const launch = buildCloudflaredLaunch(startOptions, { env });
    expect(launch).toMatchObject({
      mode: "named",
      publicUrl: "https://ocx.example.com",
      supportsSse: true,
      args: [
        "tunnel", "--no-autoupdate", "--loglevel", "info", "--protocol", "auto",
        "--metrics", "127.0.0.1:0", "run",
      ],
    });
    if (!("status" in launch)) {
      expect(launch.args.join(" ")).not.toContain(token);
      expect(launch.env.TUNNEL_TOKEN).toBe(token);
      expect(launch.env.TUNNEL_TOKEN_FILE).toBeUndefined();
      expect(launch.env.OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN).toBeUndefined();
    }

    const fromFile = buildCloudflaredLaunch(startOptions, {
      env: {
        OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN_FILE: "/chosen-token",
        OPENCODEX_CLOUDFLARE_PUBLIC_URL: "https://ocx.example.com",
        TUNNEL_TOKEN: "stale-token",
        TUNNEL_TOKEN_FILE: "/stale-token",
      },
    });
    expect(fromFile).toMatchObject({
      mode: "named",
      args: [
        "tunnel", "--no-autoupdate", "--loglevel", "info", "--protocol", "auto",
        "--metrics", "127.0.0.1:0", "run", "--token-file", "/chosen-token",
      ],
    });
    if (!("status" in fromFile)) {
      expect(fromFile.env.TUNNEL_TOKEN).toBeUndefined();
      expect(fromFile.env.TUNNEL_TOKEN_FILE).toBeUndefined();
    }

    const mismatch = buildCloudflaredLaunch({ ...startOptions, actualPort: 54322 }, { env });
    expect(mismatch).toMatchObject({ status: "error", mode: "named" });
    expect("error" in mismatch ? mismatch.error : "").toContain("fallback port");
  });

  test("validates Named Tunnel public URLs as exact HTTPS origins", () => {
    expect(normalizeNamedPublicUrl("https://ocx.example.com/"))
      .toBe("https://ocx.example.com");
    expect(normalizeNamedPublicUrl("http://ocx.example.com")).toBeNull();
    expect(normalizeNamedPublicUrl("https://ocx.example.com/v1")).toBeNull();
    expect(normalizeNamedPublicUrl("https://user:pass@ocx.example.com")).toBeNull();
    expect(normalizeNamedPublicUrl("https://ocx.example.com.")).toBeNull();
    expect(normalizeNamedPublicUrl("https://*.example.com")).toBeNull();
    expect(normalizeNamedPublicUrl("https://-bad.example.com")).toBeNull();
    expect(normalizeNamedPublicUrl("https://bad-.example.com")).toBeNull();
    expect(normalizeNamedPublicUrl("https://bad..example.com")).toBeNull();
    expect(normalizeNamedPublicUrl("https://localhost")).toBeNull();
    expect(normalizeNamedPublicUrl("https://127.0.0.1")).toBeNull();
    expect(normalizeNamedPublicUrl("https://[::1]")).toBeNull();
  });

  test("parses only loopback cloudflared metrics listeners for readiness", () => {
    expect(parseCloudflaredReadyUrl("Starting metrics server on 127.0.0.1:32123/metrics"))
      .toBe("http://127.0.0.1:32123/ready");
    expect(parseCloudflaredReadyUrl("http://localhost:20241/metrics"))
      .toBe("http://127.0.0.1:20241/ready");
    expect(parseCloudflaredReadyUrl("http://0.0.0.0:20241/metrics")).toBeNull();
    expect(parseCloudflaredReadyUrl("http://127.0.0.1:0/metrics")).toBeNull();
    expect(parseCloudflaredReadyUrl("http://127.0.0.1:65536/metrics")).toBeNull();
    expect(parseCloudflaredReadyUrl(
      "configured 127.0.0.1:0/metrics; listening 127.0.0.1:32124/metrics",
    )).toBe("http://127.0.0.1:32124/ready");
  });
});

describe("managed Cloudflare Tunnel lifecycle", () => {
  test("parses a split Quick URL, deduplicates concurrent starts, and stops gracefully", async () => {
    const child = new FakeChild();
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const controller = new ManagedCloudflareTunnelController({
      spawnFn: fakeSpawner(child, calls),
      fetchFn: readyFetch,
      env: {},
      homeDir: "/isolated-home",
      exists: () => false,
      startupTimeoutMs: 500,
      namedReadyDelayMs: 0,
      stopTimeoutMs: 50,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });

    const first = controller.start(startOptions);
    const second = controller.start(startOptions);
    expect(first).toBe(second);
    expect(calls).toHaveLength(1);
    child.stderr.write("route: https://split-name.trycloud");
    child.stdout.write("flare.com\n");
    child.stderr.write(READY_METRICS_LINE);
    await expect(first).resolves.toEqual({
      status: "running",
      mode: "quick",
      publicUrl: "https://split-name.trycloudflare.com",
      supportsSse: false,
      startedAt: "2026-07-22T00:00:00.000Z",
    });

    const stopping = controller.stop();
    expect(controller.getStatus().status).toBe("stopping");
    expect(child.killedWith).toEqual(["SIGTERM"]);
    child.close();
    await expect(stopping).resolves.toMatchObject({ status: "stopped", publicUrl: null });
  });

  test("does not advertise a Quick URL until cloudflared reports an active edge connection", async () => {
    const child = new FakeChild();
    let readinessChecks = 0;
    let edgeReady = false;
    const controller = new ManagedCloudflareTunnelController({
      spawnFn: fakeSpawner(child, []),
      fetchFn: async () => {
        readinessChecks += 1;
        return new Response(null, { status: edgeReady ? 200 : 503 });
      },
      env: {},
      homeDir: "/isolated-home",
      exists: () => false,
      startupTimeoutMs: 500,
      namedReadyDelayMs: 1,
    });

    const pending = controller.start(startOptions);
    child.stderr.write("https://not-ready-yet.trycloudflare.com\n");
    child.stderr.write(READY_METRICS_LINE);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(readinessChecks).toBeGreaterThan(0);
    expect(controller.getStatus()).toMatchObject({ status: "starting", publicUrl: null });

    edgeReady = true;
    await expect(pending).resolves.toMatchObject({
      status: "running",
      publicUrl: "https://not-ready-yet.trycloudflare.com",
    });
  });

  test("reports ENOENT without exposing raw process details", async () => {
    const child = new FakeChild();
    const controller = new ManagedCloudflareTunnelController({
      spawnFn: fakeSpawner(child, []),
      fetchFn: readyFetch,
      env: {},
      homeDir: "/isolated-home",
      exists: () => false,
      startupTimeoutMs: 500,
      namedReadyDelayMs: 0,
      stopTimeoutMs: 10,
    });
    const pending = controller.start(startOptions);
    child.emit("error", Object.assign(new Error("spawn /private/path ENOENT"), { code: "ENOENT" }));
    const status = await pending;
    expect(status).toMatchObject({ status: "error", publicUrl: null });
    expect(status.error).toContain("not installed");
    expect(status.error).not.toContain("/private/path");
  });

  test("marks an unexpected post-start exit as an error", async () => {
    const child = new FakeChild();
    const controller = new ManagedCloudflareTunnelController({
      spawnFn: fakeSpawner(child, []),
      fetchFn: readyFetch,
      env: {},
      homeDir: "/isolated-home",
      exists: () => false,
      startupTimeoutMs: 500,
      namedReadyDelayMs: 0,
    });
    const pending = controller.start(startOptions);
    child.stderr.write("https://exit-later.trycloudflare.com\n");
    child.stderr.write(READY_METRICS_LINE);
    await pending;
    child.close(1);
    expect(controller.getStatus()).toMatchObject({
      status: "error",
      publicUrl: "https://exit-later.trycloudflare.com",
    });
  });

  test("starts Named Tunnel only after its metrics readiness probe succeeds", async () => {
    const child = new FakeChild();
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    let readinessChecks = 0;
    const controller = new ManagedCloudflareTunnelController({
      spawnFn: fakeSpawner(child, calls),
      fetchFn: async url => {
        expect(String(url)).toBe("http://127.0.0.1:32123/ready");
        readinessChecks += 1;
        return new Response(null, { status: readinessChecks === 1 ? 503 : 200 });
      },
      env: {
        OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN: "named-secret",
        OPENCODEX_CLOUDFLARE_PUBLIC_URL: "https://ocx.example.com",
      },
      homeDir: "/isolated-home",
      exists: () => false,
      startupTimeoutMs: 500,
      namedReadyDelayMs: 0,
    });
    const pending = controller.start(startOptions);
    child.spawned();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(controller.getStatus().status).toBe("starting");
    child.stderr.write("Starting metrics server on 127.0.0.1:321");
    child.stdout.write("23/metrics\n");
    await expect(pending).resolves.toMatchObject({
      status: "running",
      mode: "named",
      publicUrl: "https://ocx.example.com",
      supportsSse: true,
    });
    expect(readinessChecks).toBe(2);
    expect(String((calls[0].options.env as NodeJS.ProcessEnv).TUNNEL_TOKEN)).toBe("named-secret");
    child.close();
  });

  test("a late Named readiness response cannot revive a stopped tunnel", async () => {
    const child = new FakeChild();
    let resolveReadiness: ((response: Response) => void) | undefined;
    const readiness = new Promise<Response>(resolve => { resolveReadiness = resolve; });
    const controller = new ManagedCloudflareTunnelController({
      spawnFn: fakeSpawner(child, []),
      fetchFn: async () => readiness,
      env: {
        OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN: "named-secret",
        OPENCODEX_CLOUDFLARE_PUBLIC_URL: "https://ocx.example.com",
      },
      homeDir: "/isolated-home",
      exists: () => false,
      startupTimeoutMs: 500,
      namedReadyDelayMs: 0,
      stopTimeoutMs: 50,
    });

    const pendingStart = controller.start(startOptions);
    child.stderr.write("Starting metrics server on 127.0.0.1:32123/metrics\n");
    await new Promise(resolve => setTimeout(resolve, 5));
    const pendingStop = controller.stop();
    await expect(pendingStart).resolves.toMatchObject({ status: "stopping" });
    resolveReadiness?.(new Response(null, { status: 200 }));
    child.close();
    await expect(pendingStop).resolves.toMatchObject({ status: "stopped" });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(controller.getStatus()).toMatchObject({ status: "stopped", publicUrl: null });
  });

  test("times out a Named Tunnel whose readiness endpoint stays unavailable", async () => {
    const child = new FakeChild();
    const controller = new ManagedCloudflareTunnelController({
      spawnFn: fakeSpawner(child, []),
      fetchFn: async () => new Response(null, { status: 503 }),
      env: {
        OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN: "named-secret",
        OPENCODEX_CLOUDFLARE_PUBLIC_URL: "https://ocx.example.com",
      },
      homeDir: "/isolated-home",
      exists: () => false,
      startupTimeoutMs: 10,
      namedReadyDelayMs: 1,
      stopTimeoutMs: 10,
    });

    const pending = controller.start(startOptions);
    child.stderr.write("Starting metrics server on 127.0.0.1:32123/metrics\n");
    await expect(pending).resolves.toMatchObject({
      status: "error",
      error: "Cloudflare Tunnel did not become ready before the startup timeout.",
    });
    expect(child.killedWith).toContain("SIGTERM");
  });

  test("keeps ownership when forced stop receives no close event and cleans up a late close", async () => {
    const child = new FakeChild();
    const controller = new ManagedCloudflareTunnelController({
      spawnFn: fakeSpawner(child, []),
      fetchFn: readyFetch,
      env: {},
      homeDir: "/isolated-home",
      exists: () => false,
      startupTimeoutMs: 500,
      namedReadyDelayMs: 0,
      stopTimeoutMs: 1,
    });
    const started = controller.start(startOptions);
    child.stderr.write("https://slow-stop.trycloudflare.com\n");
    child.stderr.write(READY_METRICS_LINE);
    await started;

    const stopped = await controller.stop();
    expect(stopped).toMatchObject({
      status: "error",
      publicUrl: "https://slow-stop.trycloudflare.com",
    });
    expect(child.killedWith).toEqual(["SIGTERM", "SIGKILL"]);

    child.close();
    expect(controller.getStatus()).toMatchObject({ status: "stopped", publicUrl: null });
  });

  test("honors the final stop intent when start is queued behind an earlier stop", async () => {
    const firstChild = new FakeChild();
    const secondChild = new FakeChild();
    const children = [firstChild, secondChild];
    let spawnCount = 0;
    const spawnFn = ((..._args: unknown[]) => (
      children[spawnCount++] as unknown as ChildProcess
    )) as unknown as typeof spawn;
    const controller = new ManagedCloudflareTunnelController({
      spawnFn,
      fetchFn: readyFetch,
      env: {},
      homeDir: "/isolated-home",
      exists: () => false,
      startupTimeoutMs: 500,
      namedReadyDelayMs: 0,
      stopTimeoutMs: 50,
    });

    const initialStart = controller.start(startOptions);
    firstChild.stderr.write("https://initial.trycloudflare.com\n");
    firstChild.stderr.write(READY_METRICS_LINE);
    await initialStart;

    const firstStop = controller.stop();
    const queuedStart = controller.start(startOptions);
    const finalStop = controller.stop();
    firstChild.close();

    await Promise.all([firstStop, queuedStart, finalStop]);
    expect(spawnCount).toBe(1);
    expect(controller.getStatus()).toMatchObject({ status: "stopped", publicUrl: null });
  });

  test("cancels a pending start promptly without overwriting a forced-stop error", async () => {
    const child = new FakeChild();
    const controller = new ManagedCloudflareTunnelController({
      spawnFn: fakeSpawner(child, []),
      env: {},
      homeDir: "/isolated-home",
      exists: () => false,
      startupTimeoutMs: 500,
      stopTimeoutMs: 1,
    });

    const pendingStart = controller.start(startOptions);
    const pendingStop = controller.stop();
    expect(await Promise.race([
      pendingStart.then(() => "start"),
      pendingStop.then(() => "stop"),
    ])).toBe("start");
    await expect(pendingStart).resolves.toMatchObject({ status: "stopping" });

    await expect(pendingStop).resolves.toMatchObject({
      status: "error",
      error: "cloudflared did not stop after forced termination.",
    });
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(controller.getStatus()).toMatchObject({
      status: "error",
      error: "cloudflared did not stop after forced termination.",
    });
  });

  test("times out a child that never publishes a Quick Tunnel URL", async () => {
    const child = new FakeChild();
    const controller = new ManagedCloudflareTunnelController({
      spawnFn: fakeSpawner(child, []),
      env: {},
      homeDir: "/isolated-home",
      exists: () => false,
      startupTimeoutMs: 10,
      stopTimeoutMs: 10,
    });
    const status = await controller.start(startOptions);
    expect(status).toMatchObject({ status: "error", publicUrl: null });
    expect(status.error).toContain("startup timeout");
    expect(child.killedWith).toContain("SIGTERM");
  });
});
