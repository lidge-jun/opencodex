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
  collectWslDualInstall,
  fetchServiceMemory,
  formatServiceMemoryLines,
  parseProcessEnvBlock,
  probeWham,
  proxyDownRestartHint,
  resolveCodexHomeDir,
  type ServiceMemoryData,
} from "../src/cli/doctor";
import { collectOrcaCodexHomeDiagnostic } from "../src/codex/home";
import { NativeProfileError } from "../src/codex/native-profile-types";

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

  test("Orca home diagnostic warns only for the Windows Orca runtime mismatch", () => {
    const appHome = "C:\\Users\\alice\\.codex";
    const orcaHome = "C:\\Users\\alice\\AppData\\Roaming\\orca\\codex-runtime-home\\home";
    const mismatch = collectOrcaCodexHomeDiagnostic({
      platform: "win32",
      env: { CODEX_HOME: orcaHome, ORCA_CODEX_HOME: orcaHome },
      effectiveCodexHome: orcaHome,
      appCodexHome: appHome,
    });
    expect(mismatch.mismatch).toBe(true);
    expect(mismatch.warning).toContain("OpenCodex injection will not reach that app");
    expect(mismatch.effectiveCodexHome).toContain("C:\\Users\\[USER]\\");
    expect(mismatch.effectiveCodexHome).not.toContain("alice");
    expect(mismatch.action).toContain("ocx service uninstall");
    expect(mismatch.action).toContain("ocx service install");
    expect(mismatch.action).toContain("%USERPROFILE%\\.codex");
    expect(mismatch.action).toContain("Remove-Item Env:ORCA_CODEX_HOME");
    expect(mismatch.action).toContain("SilentlyContinue; $env:CODEX_HOME");
    expect(mismatch.action).not.toContain("C:\\Users\\[USER]");

    const matching = collectOrcaCodexHomeDiagnostic({
      platform: "win32",
      env: { CODEX_HOME: appHome, ORCA_CODEX_HOME: orcaHome },
      effectiveCodexHome: appHome,
      appCodexHome: appHome,
    });
    expect(matching.mismatch).toBe(false);

    const intentionalCustom = collectOrcaCodexHomeDiagnostic({
      platform: "win32",
      env: { CODEX_HOME: "D:\\codex-work" },
      effectiveCodexHome: "D:\\codex-work",
      appCodexHome: appHome,
    });
    expect(intentionalCustom.mismatch).toBe(false);
  });

  test("resolveCodexHomeDir discovers a single Windows Codex Desktop home from WSL", () => {
    delete process.env.CODEX_HOME;
    const wslHome = join(TEST_DIR, "wsl-home");
    const usersRoot = join(TEST_DIR, "mnt-c", "Users");
    const windowsCodexHome = join(usersRoot, "example", ".codex");
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
    const windowsCodexHome = join(usersRoot, "example", ".codex");
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

  test("collectWslDualInstall reports both sides plus interop codex on PATH", () => {
    delete process.env.CODEX_HOME;
    const wslHome = join(TEST_DIR, "wsl-home");
    const linuxCodexHome = join(wslHome, ".codex");
    const usersRoot = join(TEST_DIR, "mnt-c", "Users");
    const windowsCodexHome = join(usersRoot, "example", ".codex");
    mkdirSync(linuxCodexHome, { recursive: true });
    mkdirSync(windowsCodexHome, { recursive: true });
    writeFileSync(join(linuxCodexHome, "config.toml"), "model_provider = \"linux\"\n");
    writeFileSync(join(windowsCodexHome, "config.toml"), "model_provider = \"windows\"\n");

    const interopBin = "/mnt/c/Users/example/AppData/Roaming/npm";
    const diag = collectWslDualInstall({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      homedir: () => wslHome,
      usersRoot,
      effectiveCodexHome: linuxCodexHome,
      pathValue: interopBin,
      existsSync: (p: string) => p.startsWith(interopBin) ? p === `${interopBin}/codex.exe` : existsSync(p),
    });

    expect(diag.wsl).toBe(true);
    expect(diag.dualInstall).toBe(true);
    expect(diag.linuxCodexConfigured).toBe(true);
    expect(diag.windowsCodexHomes).toEqual([windowsCodexHome]);
    expect(diag.effectiveIsWindowsMount).toBe(false);
    expect(diag.interopCodexOnPath).toBe(`${interopBin}/codex.exe`);
  });

  test("collectWslDualInstall is inert off WSL", () => {
    const diag = collectWslDualInstall({ platform: "darwin", effectiveCodexHome: TEST_CODEX_HOME });
    expect(diag.wsl).toBe(false);
    expect(diag.dualInstall).toBe(false);
    expect(diag.interopCodexOnPath).toBeNull();
  });

  test("collectWslDualInstall honors a custom wsl.conf automount root", () => {
    delete process.env.CODEX_HOME;
    const wslHome = join(TEST_DIR, "wsl-home-root");
    const linuxCodexHome = join(wslHome, ".codex");
    mkdirSync(linuxCodexHome, { recursive: true });
    writeFileSync(join(linuxCodexHome, "config.toml"), "model_provider = \"linux\"\n");

    const interopBin = "/win/c/Users/example/AppData/Roaming/npm";
    const diag = collectWslDualInstall({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      homedir: () => wslHome,
      wslConf: "[automount]\nroot = /win/\n",
      effectiveCodexHome: linuxCodexHome,
      pathValue: interopBin,
      existsSync: (p: string) => p.startsWith("/win/") ? p === `${interopBin}/codex` : existsSync(p),
      readdirSync: (p: string) => p === "/win/c/Users" ? [] : [],
    });

    expect(diag.automountRoot).toBe("/win");
    expect(diag.interopCodexOnPath).toBe(`${interopBin}/codex`);
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

  test("probeWham suppresses credential and network reads when the cross-process claim is unavailable", async () => {
    let fetchCalls = 0;
    const result = await probeWham((async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch, {
      withNativeMainClaim: async () => {
        throw new NativeProfileError(
          "NATIVE_MAIN_CLAIM_BUSY",
          "Native-main credentials are in use.",
          503,
          true,
        );
      },
    });

    expect(fetchCalls).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      status: null,
      classification: "native_main_claim_busy",
      authenticated: false,
    });
  });

  test("probeWham suppresses credential and network reads during retained recovery", async () => {
    let fetchCalls = 0;
    const result = await probeWham((async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch, {
      withNativeMainClaim: operation => operation(),
      probeNativeMainRecoveryState: () => "manual",
    });

    expect(fetchCalls).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      status: null,
      classification: "native_main_recovery_manual",
      authenticated: false,
    });
  });
});

describe("service memory section (#314 WP4)", () => {
  const baseData: ServiceMemoryData = {
    pid: 4242,
    bunVersion: "1.3.14",
    platform: "win32",
    rss: 5 * 1024 ** 3,
    heapUsed: 200 * 1024 ** 2,
    external: 300 * 1024 ** 2,
    arrayBuffers: 200 * 1024 ** 2,
    jscHeap: { heapSize: 180 * 1024 ** 2 },
    streamMode: "auto",
    eagerRelay: { useEagerRelay: false, reason: "auto-known-bad" },
    watchdog: { warnThresholdBytes: 4 * 1024 ** 3, lastWarnAt: null },
  };

  test("fetchServiceMemory: ok / unauthorized / unreachable / malformed", async () => {
    const ok = await fetchServiceMemory("127.0.0.1", 10100, null,
      (async () => Response.json(baseData)) as typeof fetch);
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") expect(ok.data.pid).toBe(4242);

    const unauthorized = await fetchServiceMemory("127.0.0.1", 10100, "wrong",
      (async () => new Response("{}", { status: 401 })) as typeof fetch);
    expect(unauthorized.status).toBe("unauthorized");

    const unreachable = await fetchServiceMemory("127.0.0.1", 10100, null,
      (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    expect(unreachable.status).toBe("unreachable");

    const malformed = await fetchServiceMemory("127.0.0.1", 10100, null,
      (async () => Response.json({ hello: "world" })) as typeof fetch);
    expect(malformed.status).toBe("unreachable");
    if (malformed.status === "unreachable") expect(malformed.error).toBe("malformed response");
  });

  test("identity labels: doctor process is never presented as the service", () => {
    const lines = formatServiceMemoryLines({ status: "ok", data: baseData });
    expect(lines[0]).toContain("NOT the service process");
    expect(lines.some(l => l.includes(`service pid ${baseData.pid}`))).toBe(true);
  });

  test("interpretation: high RSS + small JS heap → native-side line", () => {
    const lines = formatServiceMemoryLines({ status: "ok", data: baseData });
    expect(lines.some(l => l.includes("native-side growth"))).toBe(true);
  });

  test("interpretation: high RSS with large JS counters asks for corroboration", () => {
    const lines = formatServiceMemoryLines({
      status: "ok",
      data: { ...baseData, heapUsed: 4 * 1024 ** 3, jscHeap: { heapSize: 4 * 1024 ** 3 } },
    });
    expect(lines.some(l => l.includes("possible JS-side retention"))).toBe(true);
    expect(lines.some(l => l.includes("likely an opencodex bug"))).toBe(false);
  });

  test("interpretation: all observed counters below threshold → normal line", () => {
    const lines = formatServiceMemoryLines({
      status: "ok",
      data: { ...baseData, rss: 300 * 1024 ** 2 },
    });
    expect(lines.some(l => l.includes("looks normal"))).toBe(true);
    expect(lines.some(l => l.includes("native-side growth"))).toBe(false);
  });

  test("interpretation: high external memory is not hidden by low RSS (#509)", () => {
    const lines = formatServiceMemoryLines({
      status: "ok",
      data: {
        ...baseData,
        rss: 300 * 1024 ** 2,
        external: 5 * 1024 ** 3,
        arrayBuffers: 2 * 1024 ** 3,
      },
    });
    expect(lines.some(l => l.includes("observed=5120MB (external)"))).toBe(true);
    expect(lines.some(l => l.includes("high observed memory via external"))).toBe(true);
    expect(lines.some(l => l.includes("looks normal"))).toBe(false);
  });

  test("guidance gating: win32 + auto-known-bad prints version-claiming guidance", () => {
    // A bundled runtime is the case where "set OPENCODEX_BUN_PATH" is still the right advice.
    const lines = formatServiceMemoryLines({ status: "ok", data: { ...baseData, bunRuntimeSource: "bundled" } });
    expect(lines.some(l => l.includes("OPENCODEX_BUN_PATH"))).toBe(true);
    // Version-claiming, never binary-claiming.
    expect(lines.join("\n")).not.toContain("bundled binary");
  });

  test("guidance gating: an active override is never told to set OPENCODEX_BUN_PATH again (#848)", () => {
    const lines = formatServiceMemoryLines({
      status: "ok",
      data: { ...baseData, bunRuntimeSource: "override" },
    });
    const text = lines.join("\n");
    expect(text).toContain("OPENCODEX_BUN_PATH is already active");
    expect(text).not.toContain("set OPENCODEX_BUN_PATH to a runtime you trust");
    // The affected-version warning itself must survive; only the remedy changes.
    expect(text).toContain("affected by the upstream Bun memory issue");
  });

  test("guidance gating: a legacy payload without provenance says unknown instead of guessing", () => {
    const { bunRuntimeSource: _omitted, ...legacy } = { ...baseData, bunRuntimeSource: undefined };
    const text = formatServiceMemoryLines({ status: "ok", data: legacy as ServiceMemoryData }).join("\n");
    expect(text).toContain("records no runtime origin");
    expect(text).not.toContain("set OPENCODEX_BUN_PATH to a runtime you trust");
  });

  test("guidance gating: a process-provenance runtime is not described as bundled", () => {
    const text = formatServiceMemoryLines({
      status: "ok",
      data: { ...baseData, bunRuntimeSource: "process" },
    }).join("\n");
    expect(text).toContain("the runtime that launched it");
    expect(text).toContain("set OPENCODEX_BUN_PATH to a runtime you trust");
  });

  test("guidance gating: darwin auto-off or fixed Windows runtime prints no override guidance", () => {
    const darwin = formatServiceMemoryLines({
      status: "ok",
      data: {
        ...baseData,
        platform: "darwin",
        eagerRelay: { useEagerRelay: false, reason: "auto-known-bad" },
      },
    });
    expect(darwin.some(l => l.includes("OPENCODEX_BUN_PATH"))).toBe(false);

    const fixedRuntime = formatServiceMemoryLines({
      status: "ok",
      data: { ...baseData, eagerRelay: { useEagerRelay: true, reason: "auto-fixed-runtime" } },
    });
    expect(fixedRuntime.some(l => l.includes("OPENCODEX_BUN_PATH"))).toBe(false);
  });

  test("unauthorized and unreachable render honest lines without fake data", () => {
    const unauthorized = formatServiceMemoryLines({ status: "unauthorized" });
    expect(unauthorized.some(l => l.includes("rejected the request"))).toBe(true);
    expect(unauthorized.some(l => l.includes("service pid"))).toBe(false);

    const unreachable = formatServiceMemoryLines({ status: "unreachable", error: "ECONNREFUSED" });
    expect(unreachable.some(l => l.includes("not reachable"))).toBe(true);
    expect(unreachable.some(l => l.includes("service pid"))).toBe(false);
  });

  test("proxyDownRestartHint is null while a live proxy exists", () => {
    expect(proxyDownRestartHint({ proxyRunning: true, port: 10100, serviceViable: false })).toBeNull();
    expect(proxyDownRestartHint({ proxyRunning: true, port: 10100, serviceViable: true })).toBeNull();
  });

  test("proxyDownRestartHint names the symptom and both restart paths", () => {
    const hint = proxyDownRestartHint({ proxyRunning: false, port: 10100, serviceViable: false });
    expect(hint).toContain("error sending request for url");
    expect(hint).toContain("127.0.0.1:10100");
    expect(hint).toContain("ocx start");
    expect(hint).toContain("ocx service install");
  });

  test("proxyDownRestartHint prefers 'ocx service start' when a service is installed", () => {
    const hint = proxyDownRestartHint({ proxyRunning: false, port: 12000, serviceViable: true });
    expect(hint).toContain("ocx service start");
    expect(hint).toContain("127.0.0.1:12000");
    expect(hint).not.toContain("ocx service install");
  });

  // 260804 #970 follow-up: serviceViable=false conflates "no service" with "registered
  // but stale/stopped". Only the first wants install; re-registering an existing service
  // costs a UAC prompt on Windows and can switch a WinSW backend to Task Scheduler.
  test("an installed but unhealthy service is pointed at repair, not install", () => {
    const broken = proxyDownRestartHint({ proxyRunning: false, port: 10100, serviceViable: false, serviceInstalled: true });
    expect(broken).toContain("ocx service repair");
    expect(broken).not.toContain("ocx service install");

    const absent = proxyDownRestartHint({ proxyRunning: false, port: 10100, serviceViable: false, serviceInstalled: false });
    expect(absent).toContain("ocx service install");

    // A two-manager conflict must be uninstalled first; repairService() refuses it.
    const conflict = proxyDownRestartHint({ proxyRunning: false, port: 10100, serviceViable: false, serviceInstalled: true, serviceConflict: true });
    expect(conflict).toContain("ocx service install");
  });
});
