import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  collectPaths,
  detectFsType,
  collectConfiguredProxy,
  collectProxyEnv,
  collectRunningProxyEnv,
  parseProcessEnvBlock,
  probeWham,
  resolveCodexHomeDir,
} from "../src/cli/doctor";

const TEST_DIR = join(import.meta.dir, ".tmp-doctor-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
const TEST_OPENCODEX_HOME = join(TEST_DIR, "opencodex");
let prevOpencodexHome: string | undefined;
let prevCodexHome: string | undefined;
let prevHttpsProxy: string | undefined;
let prevLowerHttpsProxy: string | undefined;
let prevProxyRef: string | undefined;

describe("doctor", () => {
  beforeEach(() => {
    prevOpencodexHome = process.env.OPENCODEX_HOME;
    prevCodexHome = process.env.CODEX_HOME;
    prevHttpsProxy = process.env.HTTPS_PROXY;
    prevLowerHttpsProxy = process.env.https_proxy;
    prevProxyRef = process.env.OCX_TEST_PROXY_REF;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    mkdirSync(TEST_OPENCODEX_HOME, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_OPENCODEX_HOME;
    process.env.CODEX_HOME = TEST_CODEX_HOME;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.OCX_TEST_PROXY_REF;
  });

  afterEach(() => {
    if (prevOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevOpencodexHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = prevHttpsProxy;
    if (prevLowerHttpsProxy === undefined) delete process.env.https_proxy;
    else process.env.https_proxy = prevLowerHttpsProxy;
    if (prevProxyRef === undefined) delete process.env.OCX_TEST_PROXY_REF;
    else process.env.OCX_TEST_PROXY_REF = prevProxyRef;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("path report flips auth.json/config.json from absent to present", () => {
    let rows = collectPaths();
    const auth = () => rows.find(r => r.label === "CODEX_HOME/auth.json")!;
    const cfg = () => rows.find(r => r.label === "OPENCODEX_HOME/config.json")!;
    expect(auth().exists).toBe(false);
    expect(cfg().exists).toBe(false);

    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), "{}");
    writeFileSync(join(TEST_OPENCODEX_HOME, "config.json"), "{}");
    rows = collectPaths();
    expect(auth().exists).toBe(true);
    expect(cfg().exists).toBe(true);
  });

  test("resolveCodexHomeDir expands ~ like the hardened runtime paths", () => {
    process.env.CODEX_HOME = "~/custom-codex";
    expect(resolveCodexHomeDir()).toBe(join(homedir(), "custom-codex"));
  });

  test("resolveCodexHomeDir discovers a single Windows Codex Desktop home from WSL", () => {
    delete process.env.CODEX_HOME;
    const wslHome = join(TEST_DIR, "wsl-home");
    const usersRoot = join(TEST_DIR, "mnt-c", "Users");
    const windowsCodexHome = join(usersRoot, "jun", ".codex");
    mkdirSync(windowsCodexHome, { recursive: true });
    writeFileSync(join(windowsCodexHome, "config.toml"), "model_provider = \"opencodex\"\n");

    expect(resolveCodexHomeDir({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      homedir: () => wslHome,
      usersRoot,
    })).toBe(windowsCodexHome);
  });

  test("resolveCodexHomeDir keeps Linux CODEX_HOME default when it already has config.toml", () => {
    delete process.env.CODEX_HOME;
    const wslHome = join(TEST_DIR, "wsl-home");
    const linuxCodexHome = join(wslHome, ".codex");
    const usersRoot = join(TEST_DIR, "mnt-c", "Users");
    const windowsCodexHome = join(usersRoot, "jun", ".codex");
    mkdirSync(linuxCodexHome, { recursive: true });
    mkdirSync(windowsCodexHome, { recursive: true });
    writeFileSync(join(linuxCodexHome, "config.toml"), "model_provider = \"linux\"\n");
    writeFileSync(join(windowsCodexHome, "config.toml"), "model_provider = \"windows\"\n");

    expect(resolveCodexHomeDir({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      homedir: () => wslHome,
      usersRoot,
    })).toBe(linuxCodexHome);
  });

  test("detectFsType flags /mnt drvfs mounts and leaves ext4 home alone", () => {
    const mounts = [
      "rootfs / wslroot rw 0 0",
      "/dev/sdc /home ext4 rw,relatime 0 0",
      "drivers /mnt/c drvfs rw,noatime 0 0",
    ].join("\n");

    const c = detectFsType("/mnt/c/Users/test/.opencodex", mounts);
    expect(c.isDrvfs).toBe(true);
    expect(c.isMntDrive).toBe(true);
    expect(c.fstype).toBe("drvfs");

    const home = detectFsType("/home/test/.opencodex", mounts);
    expect(home.isDrvfs).toBe(false);
    expect(home.isMntDrive).toBe(false);
    expect(home.fstype).toBe("ext4");
  });

  test("detectFsType returns n/a when mounts content is unavailable", () => {
    const info = detectFsType("/home/test/.codex", null);
    expect(info.fstype).toBe("n/a");
    expect(info.isDrvfs).toBe(false);
  });

  test("collectProxyEnv reports presence without leaking the value", () => {
    let rows = collectProxyEnv();
    expect(rows.find(r => r.key === "HTTPS_PROXY")!.present).toBe(false);

    process.env.HTTPS_PROXY = "http://user:secret@proxy.example.test:8080";
    rows = collectProxyEnv();
    const https = rows.find(r => r.key === "HTTPS_PROXY")!;
    expect(https.present).toBe(true);
    // The row exposes only a boolean; the secret value is never carried.
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  test("parseProcessEnvBlock supports proxy presence without carrying secret values", () => {
    const env = parseProcessEnvBlock([
      "HTTP_PROXY=http://user:secret@proxy.example.test:8080",
      "NO_PROXY=localhost,127.0.0.1",
      "",
    ].join("\0"));

    const rows = collectProxyEnv(env);
    expect(rows.find(r => r.key === "HTTP_PROXY")!.present).toBe(true);
    expect(rows.find(r => r.key === "NO_PROXY")!.present).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  test("collectRunningProxyEnv separates no pid, unreadable pid env, and pid env presence", () => {
    const none = collectRunningProxyEnv({ readPidFn: () => null });
    expect(none.status).toBe("not_running");
    expect(none.rows.every(row => !row.present)).toBe(true);

    const unreadable = collectRunningProxyEnv({
      readPidFn: () => 4242,
      readEnvironFn: () => null,
      platform: "linux",
    });
    expect(unreadable.status).toBe("unavailable");
    expect(unreadable.rows.every(row => !row.present)).toBe(true);

    const running = collectRunningProxyEnv({
      readPidFn: () => 4242,
      readEnvironFn: () => "HTTPS_PROXY=http://user:secret@proxy.example.test:8080\0NO_PROXY=localhost\0",
      platform: "linux",
    });
    expect(running.status).toBe("ok");
    expect(running.rows.find(row => row.key === "HTTPS_PROXY")!.present).toBe(true);
    expect(running.rows.find(row => row.key === "NO_PROXY")!.present).toBe(true);
    expect(JSON.stringify(running)).not.toContain("secret");
  });

  test("collectConfiguredProxy reports effective config proxy without leaking values", () => {
    writeFileSync(join(TEST_OPENCODEX_HOME, "config.json"), JSON.stringify({ proxy: "${OCX_TEST_PROXY_REF}" }));

    let diagnostic = collectConfiguredProxy();
    expect(diagnostic.configured).toBe(true);
    expect(diagnostic.present).toBe(false);
    expect(diagnostic.detail).toContain("OCX_TEST_PROXY_REF");

    process.env.OCX_TEST_PROXY_REF = "http://user:secret@proxy.example.test:8080";
    diagnostic = collectConfiguredProxy();
    expect(diagnostic.configured).toBe(true);
    expect(diagnostic.present).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });

  test("probeWham classifies ok, http error, timeout, and connect failures", async () => {
    const ok = await probeWham((async () => new Response("{}", { status: 200 })) as typeof fetch);
    expect(ok.ok).toBe(true);
    expect(ok.classification).toBe("ok");
    expect(typeof ok.durationMs).toBe("number");

    const unauth = await probeWham((async () => new Response("", { status: 401 })) as typeof fetch);
    expect(unauth.ok).toBe(false);
    expect(unauth.classification).toBe("http_401");

    const timeout = await probeWham((async () => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }) as typeof fetch);
    expect(timeout.classification).toBe("timeout");

    const connect = await probeWham((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(connect.classification).toBe("connect_error");
  });
});
