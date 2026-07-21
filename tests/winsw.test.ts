import { describe, expect, test } from "bun:test";
import { buildWinswXml, ensureWinswBinary, parseWinswStatus, probeScmRegistration, sha256Hex, installWinswService, statusWinswRaw, WINSW_SHA256, WINSW_SERVICE_ID } from "../src/lib/winsw";
import { parseServiceArgs, serviceReinstallArgs } from "../src/service";
import { loadServiceTokenFromFile } from "../src/lib/service-secrets";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = { bun: "C:\\OpenCodex\\bun.exe", cli: "C:\\Open Codex\\cli & co\\index.ts" };

describe("winsw xml", () => {
  const env = { USERDOMAIN: "WORKGROUP", USERNAME: "jun", PATH: "C:\\bin;C:\\tools & more" } as NodeJS.ProcessEnv;

  test("registers the user service account (v2 schema), never LocalSystem", () => {
    const xml = buildWinswXml(entry, env);

    expect(xml).toContain("<serviceaccount>");
    expect(xml).toContain("<domain>WORKGROUP</domain>");
    expect(xml).toContain("<user>jun</user>");
    expect(xml).toContain("<allowservicelogon>true</allowservicelogon>");
    // v2 schema uses domain/user; v3's <username> must not appear, nor any password.
    expect(xml).not.toContain("<username>");
    expect(xml).not.toContain("<password>");
    expect(xml.toLowerCase()).not.toContain("localsystem");
  });

  test("carries service env: OCX_SERVICE, token file pointer, and escaped PATH parity", () => {
    const xml = buildWinswXml(entry, env);

    expect(xml).toContain('<env name="OCX_SERVICE" value="1"/>');
    expect(xml).toContain('<env name="OCX_API_TOKEN_FILE"');
    expect(xml).toContain('<env name="PATH" value="C:\\bin;C:\\tools &amp; more"/>');
    // The token VALUE never lands in the XML — only the file pointer.
    expect(xml).not.toContain("OPENCODEX_API_AUTH_TOKEN");
  });

  test("escapes executable/arguments and configures restart + graceful stop", () => {
    const xml = buildWinswXml(entry, env);

    expect(xml).toContain("<executable>C:\\OpenCodex\\bun.exe</executable>");
    expect(xml).toContain("<arguments>&quot;C:\\Open Codex\\cli &amp; co\\index.ts&quot; start --port 10100</arguments>");
    expect(xml).toContain('<onfailure action="restart" delay="5 sec"/>');
    expect(xml).toContain("<stoptimeout>20 sec</stoptimeout>");
    expect(xml).toContain('<log mode="roll-by-size">');
    expect(xml).toContain(`<id>${WINSW_SERVICE_ID}</id>`);
  });
  test("honors OCX_BAKE_PORT when building WinSW arguments", () => {
    const xml = buildWinswXml(entry, { ...env, OCX_BAKE_PORT: "14444" });
    expect(xml).toContain("start --port 14444");
  });
});

describe("winsw binary pinning", () => {
  test("download failing hash verification is fail-closed", async () => {
    const fakeFetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;

    await expect(ensureWinswBinary(fakeFetch)).rejects.toThrow(/SHA-256 verification/);
  });

  test("download network failure names the manual placement path", async () => {
    const fakeFetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

    await expect(ensureWinswBinary(fakeFetch)).rejects.toThrow(/Place the official WinSW\.NET461\.exe/);
  });

  test("pinned digest shape is a sha256 hex", () => {
    expect(WINSW_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("winsw status parsing", () => {
  test("maps the three v2 outputs exactly", () => {
    expect(parseWinswStatus("Started")).toBe("started");
    expect(parseWinswStatus("Stopped")).toBe("stopped");
    expect(parseWinswStatus("NonExistent")).toBe("nonexistent");
    // Unparseable output is NOT proof of absence — callers fail closed on "unknown".
    expect(parseWinswStatus("garbage")).toBe("unknown");
  });
});

describe("winsw fail-closed lifecycle", () => {
  test("install refuses to guess when the status query fails", async () => {
    await expect(
      installWinswService(entry, {
        ensureBinary: async () => "exe",
        writeXml: () => {},
        interactive: () => {},
        run: () => "",
        verifyAccount: () => {},
        status: () => "unknown",
      }),
    ).rejects.toThrow(/Could not query the native service state/);
  });

  test("a failed status query is treated as possibly-installed by lifecycle consumers", () => {
    // stopServiceIfInstalled/installWindows gate on `!== "nonexistent"` — "unknown"
    // must therefore route INTO stop/uninstall attempts, never skip them.
    const service = readFileSync(new URL("../src/service.ts", import.meta.url), "utf8");
    expect(service).not.toContain('statusWinswRaw() === "unknown"');
    expect((service.match(/statusWinswRaw\(\) !== "nonexistent"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test("exe missing + non-Windows is confirmed absence; on Windows the SCM is queried", () => {
    // This test host has no WinSW binary installed, so the missing-exe branch runs:
    // off-Windows it must short-circuit to "nonexistent" (no sc.exe exists here).
    if (process.platform !== "win32") {
      expect(statusWinswRaw()).toBe("nonexistent");
    } else {
      // win32 CI runners have no binary either, but the SCM probe result depends on
      // the live runner state — assert only that the probe never throws.
      expect(["started", "stopped", "nonexistent", "unknown"]).toContain(statusWinswRaw());
    }
    // On win32 the same branch must confirm against the SCM — a quarantined/deleted
    // exe does not prove the registration is gone.
    const winsw = readFileSync(new URL("../src/lib/winsw.ts", import.meta.url), "utf8");
    const fn = winsw.slice(winsw.indexOf("export function statusWinswRaw"), winsw.indexOf("/**", winsw.indexOf("export function statusWinswRaw")));
    expect(fn).toContain('process.platform !== "win32"');
    expect(fn).toContain("probeScmRegistration()");
    expect(fn).toContain('probe === false ? "nonexistent" : "unknown"');
  });

  test("SCM probe distinguishes registered / confirmed-absent / query-failure", () => {
    // Query succeeds → registration exists.
    expect(probeScmRegistration(() => "STATE : 4 RUNNING")).toBe(true);
    // Exit 1060 (or its stderr form) is the ONLY proof of absence.
    expect(probeScmRegistration(() => { const e = new Error("fail") as Error & { status: number }; e.status = 1060; throw e; })).toBe(false);
    expect(probeScmRegistration(() => { const e = new Error("fail") as Error & { status: number; stderr: string }; e.status = 1; e.stderr = "[SC] OpenService FAILED 1060:"; throw e; })).toBe(false);
    // sc.exe can channel the 1060 line on STDOUT (observed in service-lifecycle CI) —
    // every captured stream must be scanned, not just stderr.
    expect(probeScmRegistration(() => { const e = new Error("fail") as Error & { status: number; stdout: string }; e.status = 1; e.stdout = "[SC] OpenService FAILED 1060:"; throw e; })).toBe(false);
    // Localized output with Bun's low-byte status still proves absence via textual 1060.
    expect(probeScmRegistration(() => { const e = new Error("fail") as Error & { status: number; stdout: string }; e.status = 36; e.stdout = "[SC] EnumQueryServicesStatus:OpenService FALHA 1060: ..."; throw e; })).toBe(false);
    expect(probeScmRegistration(() => { const e = new Error("fail") as Error & { status: number; stderr: string }; e.status = 36; e.stderr = "[SC] OpenService 1060: 지정된 서비스가 ..."; throw e; })).toBe(false);
    expect(probeScmRegistration(() => { const e = new Error("<localized> 1060") as Error & { status: number }; e.status = 1; throw e; })).toBe(false);
    // Access denied / missing sc.exe / any other failure → error, never absence.
    expect(probeScmRegistration(() => { const e = new Error("Acesso negado") as Error & { status: number; stderr: string }; e.status = 5; e.stderr = "[SC] OpenSCManager FALHA 5: Acesso negado."; throw e; })).toBe("error");
    expect(probeScmRegistration(() => { throw new Error("spawn sc.exe ENOENT"); })).toBe("error");
  });

  test("uninstall removes a stale SCM registration via sc.exe when the exe is gone", () => {
    const winsw = readFileSync(new URL("../src/lib/winsw.ts", import.meta.url), "utf8");
    const fn = winsw.slice(winsw.indexOf("export function uninstallWinswService"), winsw.indexOf("export function winswStatusSummary"));
    expect(fn).toContain("!existsSync(winswExePath())");
    expect(fn).toContain("probeScmRegistration()");
    expect(fn).toContain('["delete", WINSW_SERVICE_ID]');
    // An unverifiable registration (probe "error") must abort, not silently succeed.
    expect(fn).toContain('probe === "error"');
    expect(fn).toContain("Uninstall aborted");
  });
});

describe("winsw install flow", () => {
  test("fresh install prompts credentials via /p and verifies the account", async () => {
    const calls: string[][] = [];
    await installWinswService(entry, {
      ensureBinary: async () => "exe",
      writeXml: () => {},
      interactive: args => { calls.push(["interactive", ...args]); },
      run: args => { calls.push(["run", ...args]); return ""; },
      verifyAccount: () => { calls.push(["verify"]); },
      status: () => "nonexistent",
    });

    expect(calls).toEqual([["interactive", "install", "/p"], ["verify"], ["run", "start"]]);
  });

  test("repair over an existing service rewrites assets and restarts without re-prompting", async () => {
    const calls: string[][] = [];
    await installWinswService(entry, {
      ensureBinary: async () => "exe",
      writeXml: () => { calls.push(["xml"]); },
      interactive: args => { calls.push(["interactive", ...args]); },
      run: args => { calls.push(["run", ...args]); return ""; },
      verifyAccount: () => { calls.push(["verify"]); },
      status: () => "stopped",
    });

    // Uses stopwait (not stop) so the service fully stops before start — avoids STOP_PENDING race.
    expect(calls).toEqual([["xml"], ["run", "stopwait"], ["run", "start"]]);
  });
});

describe("service backend CLI parsing", () => {
  test("install --native selects the native backend", () => {
    expect(parseServiceArgs(["install", "--native"])).toEqual({ sub: "install", backend: "native", invalid: [] });
  });

  test("bare service defaults to install with no backend override", () => {
    expect(parseServiceArgs([])).toEqual({ sub: "install", backend: null, invalid: [] });
  });

  test("--scheduler and unknown flags are recognized separately", () => {
    expect(parseServiceArgs(["install", "--scheduler"]).backend).toBe("scheduler");
    expect(parseServiceArgs(["install", "--bogus"]).invalid).toEqual(["--bogus"]);
    // status with --native is syntactically accepted by the parser; serviceCommand rejects it at runtime.
    expect(parseServiceArgs(["status", "--native"]).backend).toBe("native");
  });

  test("conflicting --native --scheduler flags are rejected", () => {
    const result = parseServiceArgs(["install", "--native", "--scheduler"]);
    expect(result.invalid.length).toBeGreaterThan(0);
    expect(result.invalid[0]).toContain("conflicts");
  });
});

describe("service reinstall args", () => {
  test("defaults to the scheduler backend on this machine (no native state)", () => {
    // On a dev machine without a native install-state the accessor maps to scheduler.
    expect(serviceReinstallArgs()).toEqual(["service", "install"]);
  });
});

describe("app-side service token loading", () => {
  test("loads the token from OCX_API_TOKEN_FILE only when the env token is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-token-"));
    const file = join(dir, "service-api-token");
    writeFileSync(file, "  tok-123  \n");
    try {
      expect(loadServiceTokenFromFile({ OCX_API_TOKEN_FILE: file })).toBe("tok-123");
      expect(loadServiceTokenFromFile({ OCX_API_TOKEN_FILE: file, OPENCODEX_API_AUTH_TOKEN: "already" })).toBeNull();
      expect(loadServiceTokenFromFile({})).toBeNull();
      expect(loadServiceTokenFromFile({ OCX_API_TOKEN_FILE: join(dir, "missing") })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
