import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  collectPaths,
  detectFsType,
  collectConfiguredProxy,
  collectProxyEnv,
  collectRunningProxyEnv,
  collectWslDualInstall,
  fetchServiceMemory,
  formatResponseTempLines,
  formatServiceMemoryLines,
  parseProcessEnvBlock,
  probeWham,
  proxyDownRestartHint,
  resolveCodexHomeDir,
  runDoctor,
  type ServiceMemoryData,
} from "../src/cli/doctor";
import { collectOrcaCodexHomeDiagnostic } from "../src/codex/home";
import { NativeProfileError } from "../src/codex/native-profile-types";
import {
  LOCAL_MANAGEMENT_CAPABILITY_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER,
  LOCAL_MANAGEMENT_NONCE_HEADER,
  LOCAL_MANAGEMENT_READ_PATHS,
  verifyLocalManagementReadCapability,
} from "../src/lib/local-management-capability";

const TEST_DIR = join(import.meta.dir, ".tmp-doctor-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
const TEST_OPENCODEX_HOME = join(TEST_DIR, "opencodex");
let prevOpencodexHome: string | undefined;
let prevCodexHome: string | undefined;
let prevHttpsProxy: string | undefined;
let prevLowerHttpsProxy: string | undefined;
let prevProxyRef: string | undefined;
let prevAdminToken: string | undefined;

describe("doctor", () => {
  beforeEach(() => {
    prevOpencodexHome = process.env.OPENCODEX_HOME;
    prevCodexHome = process.env.CODEX_HOME;
    prevHttpsProxy = process.env.HTTPS_PROXY;
    prevLowerHttpsProxy = process.env.https_proxy;
    prevProxyRef = process.env.OCX_TEST_PROXY_REF;
    prevAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
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
    if (prevAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = prevAdminToken;
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
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-token-must-not-leave-doctor";
    const target = { hostname: "127.0.0.1", port: 10100, pid: 4242, source: "runtime" } as const;
    const attestationSecret = "A".repeat(43);
    const nonce = "B".repeat(43);
    const now = 1_800_000_000_000;
    const deps = {
      readRuntime: () => ({ pid: 4242, port: 10100, attestationSecret }),
      createNonce: () => nonce,
      now: () => now,
    };
    const ok = await fetchServiceMemory(target, {
      ...deps,
      fetchImpl: (async (_input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("x-opencodex-api-key")).toBeNull();
        expect(headers.get(LOCAL_MANAGEMENT_EXPECTED_PID_HEADER)).toBe("4242");
        expect(verifyLocalManagementReadCapability(
          attestationSecret,
          headers.get(LOCAL_MANAGEMENT_NONCE_HEADER),
          "GET",
          LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
          4242,
          10100,
          Number(headers.get(LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER)),
          headers.get(LOCAL_MANAGEMENT_CAPABILITY_HEADER),
          now,
        )).toBe(true);
        return Response.json(baseData);
      }) as typeof fetch,
    });
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") expect(ok.data.pid).toBe(4242);

    const unauthorized = await fetchServiceMemory(target, {
      ...deps,
      fetchImpl: (async () => new Response("{}", { status: 401 })) as typeof fetch,
    });
    expect(unauthorized.status).toBe("unauthorized");

    const unreachable = await fetchServiceMemory(target, {
      ...deps,
      fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
    });
    expect(unreachable.status).toBe("unreachable");

    const malformed = await fetchServiceMemory(target, {
      ...deps,
      fetchImpl: (async () => Response.json({ ...baseData, pid: 9999 })) as typeof fetch,
    });
    expect(malformed.status).toBe("unreachable");
    if (malformed.status === "unreachable") expect(malformed.error).toBe("malformed response");
  });

  test("does not contact configured-port or stale runtime targets", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return Response.json(baseData);
    }) as typeof fetch;
    const configured = await fetchServiceMemory(
      { hostname: "127.0.0.1", port: 10100, pid: null, source: "config" },
      { fetchImpl },
    );
    const staleRuntime = await fetchServiceMemory(
      { hostname: "127.0.0.1", port: 10100, pid: 4242, source: "runtime" },
      {
        fetchImpl,
        readRuntime: () => ({ pid: 4242, port: 10101, attestationSecret: "A".repeat(43) }),
      },
    );
    const legacyRuntime = await fetchServiceMemory(
      { hostname: "127.0.0.1", port: 10100, pid: 4242, source: "runtime" },
      {
        fetchImpl,
        readRuntime: () => ({ pid: 4242, port: 10100 }),
      },
    );
    expect(configured.status).toBe("unauthorized");
    expect(staleRuntime.status).toBe("unauthorized");
    expect(legacyRuntime.status).toBe("unauthorized");
    expect(fetchCalls).toBe(0);
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
    expect(unauthorized.some(l => l.includes("local diagnostic capability unavailable"))).toBe(true);
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

describe("doctor abandoned response-state temps", () => {
  const result = (over: Partial<Parameters<typeof formatResponseTempLines>[0]> = {}) => ({
    matched: 0, removed: 0, failed: 0, bytesRemoved: 0, eligible: 0, eligibleBytes: 0, truncated: false, ...over,
  });

  test("reports reclaimable files without removing them, and names the opt-in flag", () => {
    // Report is the default: doctor is a diagnostic, so it must not delete as a side effect
    // of being asked a question.
    const lines = formatResponseTempLines(result({ matched: 9, eligible: 3, eligibleBytes: 72 * 1024 * 1024 }), false);
    expect(lines[0]).toContain("3 abandoned response-state temp file(s)");
    expect(lines[0]).toContain("72MB");
    expect(lines.join("\n")).toContain("ocx doctor --reclaim-response-temps");
  });

  test("reports eligible, never matched", () => {
    // matched counts name-matching entries BEFORE the age/liveness/file-type gates, so
    // reporting it would call live-pid and young temps abandoned.
    const lines = formatResponseTempLines(result({ matched: 12, eligible: 0 }), false);
    expect(lines).toEqual(["  ok  No abandoned response-state temp files."]);
    expect(lines.join("\n")).not.toContain("12");
  });

  test("reclaim mode reports what was freed", () => {
    const lines = formatResponseTempLines(result({ matched: 4, removed: 2, bytesRemoved: 48 * 1024 * 1024 }), true);
    expect(lines[0]).toContain("Reclaimed 2");
    expect(lines[0]).toContain("48MB");
    expect(lines.join("\n")).not.toContain("--reclaim-response-temps");
  });

  test("locked files are surfaced honestly", () => {
    const lines = formatResponseTempLines(result({ matched: 3, removed: 1, failed: 2, bytesRemoved: 24 * 1024 * 1024 }), true);
    expect(lines.join("\n")).toContain("2 file(s) could not be removed");
    expect(lines.join("\n")).toContain("in use or locked");
  });

  test("a clean machine says so in both modes", () => {
    expect(formatResponseTempLines(result(), false)).toEqual(["  ok  No abandoned response-state temp files."]);
    expect(formatResponseTempLines(result(), true)).toEqual(["  ok  No abandoned response-state temp files."]);
  });

  test("a partial reclaim tells the operator to run again instead of silently stopping", () => {
    // The shape here is one the scanner can actually produce. It cannot produce
    // eligible > removed + failed outside a dry run: an entry is counted eligible and then
    // unlinked or failed on the same iteration, so those are always equal, and the earlier
    // version of this warning keyed on a comparison between them and therefore never fired.
    const lines = formatResponseTempLines(
      result({ eligible: 512, removed: 512, bytesRemoved: 512 * 24 * 1024 * 1024, truncated: true }),
      true,
    );
    expect(lines.join("\n")).toContain("Cleanup budget reached");
    expect(lines.join("\n")).toContain("Run the command again");
  });

  test("a reclaim that finished does NOT claim files remain", () => {
    // Ablation guard for the test above: same counts, truncated false. If the warning ever
    // stops depending on `truncated`, this fails.
    const lines = formatResponseTempLines(
      result({ eligible: 512, removed: 512, bytesRemoved: 512 * 24 * 1024 * 1024 }),
      true,
    ).join("\n");
    expect(lines).not.toContain("Cleanup budget reached");
    expect(lines).not.toContain("Run the command again");
  });

  test("a truncated report says the total is a floor, not the backlog", () => {
    const lines = formatResponseTempLines(
      result({ matched: 4096, eligible: 4096, eligibleBytes: 96 * 1024 * 1024, truncated: true }),
      false,
    ).join("\n");
    expect(lines).toContain("4096 abandoned response-state temp file(s)");
    expect(lines).toContain("the real total is higher");
  });

  test("locked files are never described as retried automatically", () => {
    // This command exists for the operator whose proxy will not start; in that state nothing
    // retries anything, so promising automatic retry would be a lie to its target reader.
    const lines = formatResponseTempLines(result({ removed: 1, failed: 2 }), true).join("\n");
    expect(lines).not.toContain("retried automatically");
    expect(lines).toContain("re-run this command");
  });
});

describe("doctor reclaim wiring (end to end)", () => {
  // The formatter tests above cannot observe deletion. This covers the call site itself:
  // inverting the report/reclaim ternary in runDoctor must fail a test.
  let tempHome: string;
  let previousHome: string | undefined;
  let logged: string[];
  const realLog = console.log;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    tempHome = join(tmpdir(), `ocx-doctor-temps-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
    process.env.OPENCODEX_HOME = tempHome;
    logged = [];
    console.log = (...parts: unknown[]) => { logged.push(parts.join(" ")); };
  });
  afterEach(() => {
    console.log = realLog;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  const seedStaleTemp = (): string => {
    const deadPid = process.pid === 4242 ? 4243 : 4242;
    const path = join(tempHome, `responses-state.json.ocx.${deadPid}.1.tmp`);
    writeFileSync(path, "abandoned snapshot");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    utimesSync(path, old, old);
    return path;
  };

  test("the default run reports the file and leaves it on disk", async () => {
    const path = seedStaleTemp();
    await runDoctor([]);
    expect(existsSync(path)).toBe(true);
    expect(logged.join("\n")).toContain("reclaimable");
  });

  test("the opt-in flag removes it", async () => {
    const path = seedStaleTemp();
    await runDoctor(["--reclaim-response-temps"]);
    expect(existsSync(path)).toBe(false);
    expect(logged.join("\n")).toContain("Reclaimed 1");
  });

  test("a mistyped flag warns instead of silently reporting", async () => {
    const path = seedStaleTemp();
    await runDoctor(["--reclaim-response-temp"]);
    expect(existsSync(path)).toBe(true);
    expect(logged.join("\n")).toContain("Unrecognized flag");
  });
});
