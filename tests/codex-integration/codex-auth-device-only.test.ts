/**
 * `codexAuthMethod: "device-only"` (#8082): a headless hub must be able to
 * require the device grant for every Codex pool login, including the
 * dashboard's Re-authenticate action, which starts a login without asking for
 * any flow. Absent and "auto" must keep the caller's choice exactly as before.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { CODEX_LOGIN_TERMINAL_TTL_MS, codexAuthLoginState } from "../../src/codex/auth-api/login-state";
import { cmdAccount, type AccountDeps } from "../../src/cli/account";
import type { AccountStdin } from "../../src/cli/account-api";
import { validateConfigCandidate } from "../../src/config/diagnostics";
import { loadConfig } from "../../src/config";
import type { OcxConfig } from "../../src/types";
import {
  addCodexAccountUiReducer,
  initialAddCodexAccountUiState,
} from "../../gui/src/components/add-codex-account-reducer";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const VALID_PROVIDERS = { openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" } };
let testDir = "";
let previousHome: string | undefined;

function writeConfig(extra: Partial<OcxConfig>): OcxConfig {
  const config = {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccounts: [{ id: "team-hub", email: "operator@example.test" }],
    ...extra,
  } as OcxConfig;
  writeFileSync(join(testDir, "config.json"), JSON.stringify(config));
  return config;
}

async function startLogin(config: OcxConfig, body: Record<string, unknown>) {
  const oauth = await import("../../src/oauth");
  const openUrlModule = await import("../../src/lib/open-url");
  const startSpy = spyOn(oauth, "startLoginFlow").mockImplementation(async (_provider, opts) => (
    (opts as { flow?: string } | undefined)?.flow === "device"
      ? { url: "https://auth.openai.com/codex/device", instructions: "Enter code: ABCD-EFGH", deviceCode: "ABCD-EFGH" }
      : { url: "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" }
  ));
  const openSpy = spyOn(openUrlModule, "openUrl").mockImplementation(async () => ({ status: "started" as const }));
  const statusSpy = spyOn(oauth, "getLoginStatus").mockReturnValue({
    done: true, loggedIn: false, status: "error", error: "Test login ended",
  });
  const pollStopped = Promise.withResolvers<void>();
  const originalSetTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
    if (delay === 2_000) queueMicrotask(() => callback(...args));
    else if (delay === CODEX_LOGIN_TERMINAL_TTL_MS) pollStopped.resolve();
    else return originalSetTimeout(callback, delay, ...args);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  try {
    const req = new Request("http://localhost/api/codex-auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openBrowser: true, ...body }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as Record<string, unknown>;
    if (typeof data.flowId === "string") {
      await pollStopped.promise;
      codexAuthLoginState.delete(data.flowId);
    }
    return { status: resp!.status, data, flow: (startSpy.mock.calls[0]?.[1] as { flow?: string } | undefined)?.flow, opened: openSpy.mock.calls.length };
  } finally {
    timer.mockRestore();
    statusSpy.mockRestore();
    startSpy.mockRestore();
    openSpy.mockRestore();
  }
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-codex-device-only-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  await removeTreeWithRetry(testDir);
});

describe("codexAuthMethod device-only enforcement", () => {
  test("reauthentication without a flow choice starts the device grant, not a browser login", async () => {
    const config = writeConfig({ codexAuthMethod: "device-only" });
    const result = await startLogin(config, { id: "team-hub", reauth: true });

    expect(result.status).toBe(200);
    expect(result.flow).toBe("device");
    expect(result.data.deviceCode).toBe("ABCD-EFGH");
    expect(result.data.authMethod).toBe("device-only");
    // Even with openBrowser:true the hub opens nothing: the page belongs on another device.
    expect(result.opened).toBe(0);
  });

  test("a new account is forced onto the device grant, and an explicit device:false cannot opt out", async () => {
    const config = writeConfig({ codexAuthMethod: "device-only" });
    const result = await startLogin(config, { id: "new-hub-account", device: false });

    expect(result.flow).toBe("device");
    expect(result.data.authMethod).toBe("device-only");
    expect(result.opened).toBe(0);
  });

  test("unknown pool accounts are still refused before any login starts", async () => {
    const config = writeConfig({ codexAuthMethod: "device-only" });
    const result = await startLogin(config, { id: "not-in-pool", reauth: true });

    expect(result.status).toBe(404);
    expect(result.flow).toBeUndefined();
  });

  test("an install without the setting keeps the browser login and reports no policy", async () => {
    const config = writeConfig({});
    const result = await startLogin(config, { id: "team-hub", reauth: true });

    expect(result.flow).toBeUndefined();
    expect(result.data.deviceCode).toBeUndefined();
    expect(result.data.authMethod).toBeUndefined();
    expect(result.opened).toBe(1);
  });

  test("\"auto\" keeps the caller's explicit device choice without claiming a policy", async () => {
    const config = writeConfig({ codexAuthMethod: "auto" });
    const result = await startLogin(config, { id: "team-hub", reauth: true, device: true });

    expect(result.flow).toBe("device");
    expect(result.data.authMethod).toBeUndefined();
  });
});

describe("codexAuthMethod configuration", () => {
  test("accepts the two documented values and omission", () => {
    const base = { port: 10100, providers: VALID_PROVIDERS, defaultProvider: "openai" };
    expect(validateConfigCandidate({ ...base }).ok).toBe(true);
    expect(validateConfigCandidate({ ...base, codexAuthMethod: "auto" }).ok).toBe(true);
    const deviceOnly = validateConfigCandidate({ ...base, codexAuthMethod: "device-only" });
    expect(deviceOnly.ok && deviceOnly.config.codexAuthMethod).toBe("device-only");
  });

  test("rejects anything else with a message naming the key", () => {
    const base = { port: 10100, providers: VALID_PROVIDERS, defaultProvider: "openai" };
    for (const value of ["browser", "DEVICE-ONLY", "", true, 1, null]) {
      const result = validateConfigCandidate({ ...base, codexAuthMethod: value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("codexAuthMethod");
    }
  });

  test("a malformed hand edit loads as the default instead of breaking the config", () => {
    writeFileSync(join(testDir, "config.json"), JSON.stringify({
      port: 10201, providers: VALID_PROVIDERS, defaultProvider: "openai", codexAuthMethod: "browser",
    }));
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = loadConfig();
      expect(loaded.codexAuthMethod).toBeUndefined();
      expect(loaded.port).toBe(10201);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('codexAuthMethod ignored: using "auto"'));
    } finally {
      warning.mockRestore();
    }
  });
});

describe("Codex account modal state", () => {
  test("records an imposed device grant and forgets it when a new login starts", () => {
    let state = initialAddCodexAccountUiState("team-hub");
    state = addCodexAccountUiReducer(state, {
      type: "set-login-hint", authUrl: "https://auth.openai.com/codex/device", deviceCode: "ABCD-EFGH", deviceOnly: true,
    });
    expect(state.deviceOnly).toBe(true);
    expect(state.deviceCode).toBe("ABCD-EFGH");

    state = addCodexAccountUiReducer(state, { type: "reset-oauth-start" });
    expect(state.deviceOnly).toBe(false);

    state = addCodexAccountUiReducer(state, { type: "set-login-hint", authUrl: "https://auth.openai.com/oauth/authorize" });
    expect(state.deviceOnly).toBe(false);
  });

  test("every shipped dashboard locale explains the imposed device login", async () => {
    const locales = ["en", "de", "fr", "ja", "ko", "pt", "ru", "tr", "vi", "zh", "zh-TW"];
    for (const locale of locales) {
      const source = await Bun.file(repoPath("gui", "src", "i18n", `${locale}.ts`)).text();
      expect(source).toContain('"codexAuth.deviceOnlyEnforced"');
    }
  });
});

/**
 * The CLI learns about the policy only from the start response. A JSON wait prints nothing until it
 * ends and a pasted code has no flow to complete, so either would strand the person without the URL
 * and code for the full device budget: the CLI cancels the flow it started and says what works.
 */
describe("ocx account login against a device-only proxy", () => {
  let requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let deviceOnly = true;
  let cancelStatus = 200;
  let server: ReturnType<typeof Bun.serve>;
  let errors: string[] = [];
  let logs: string[] = [];
  let restore: Array<() => void> = [];

  beforeEach(() => {
    requests = [];
    deviceOnly = true;
    cancelStatus = 200;
    errors = [];
    logs = [];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "POST" ? await req.json().catch(() => undefined) : undefined;
        requests.push({ method: req.method, path: url.pathname, body });
        if (url.pathname === "/api/codex-auth/login") {
          return Response.json(deviceOnly
            ? { url: "https://auth.openai.com/codex/device", deviceCode: "ABCD-EFGH", flowId: "flow-device", authMethod: "device-only" }
            : { url: "https://auth.openai.com/oauth/authorize", flowId: "flow-browser" });
        }
        if (url.pathname === "/api/codex-auth/login/cancel") return Response.json({ ok: cancelStatus === 200 }, { status: cancelStatus });
        if (url.pathname === "/api/codex-auth/login/code") return Response.json({ ok: true, accepted: true });
        if (url.pathname === "/api/codex-auth/login-status") return Response.json({ status: "done", email: "operator@example.test" });
        return Response.json({ error: "unhandled" }, { status: 404 });
      },
    });
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
    restore = [() => log.mockRestore(), () => error.mockRestore()];
  });

  afterEach(() => {
    for (const undo of restore) undo();
    server.stop(true);
  });

  function deps(stdin?: string): AccountDeps {
    const stdinImpl = stdin === undefined ? undefined : Object.assign(Readable.from([stdin]), { isTTY: false }) as AccountStdin;
    return {
      baseUrl: `http://127.0.0.1:${server.port}`,
      loadConfigImpl: () => ({ providers: {} }) as OcxConfig,
      ...(stdinImpl ? { stdinImpl } : {}),
    };
  }

  const paths = () => requests.map(entry => entry.path);

  for (const args of [["--json"], ["--reauth", "--id", "team-hub", "--json"], ["--device", "--json"]]) {
    test(`a JSON wait (${args.join(" ")}) is refused at once and the started flow is cancelled`, async () => {
      const code = await cmdAccount(["login", "openai", ...args], deps());
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("with --json, add --no-wait");
      expect(paths()).toEqual(["/api/codex-auth/login", "/api/codex-auth/login/cancel"]);
      expect(requests[1]!.body).toEqual({ flowId: "flow-device" });
      expect(logs).toEqual([]);
    });
  }

  test("a pasted code is refused before it is submitted, and the flow is cancelled", async () => {
    const code = await cmdAccount(["login", "openai", "--code", "-"], deps("http://localhost:1455/auth/callback?code=x\n"));
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("--code cannot be used");
    expect(paths()).toEqual(["/api/codex-auth/login", "/api/codex-auth/login/cancel"]);
  });

  test("an open stdin with no data does not delay the device-only refusal of --code -", async () => {
    // A stream that never ends: reading it before the start answer would hang this test.
    const silent = Object.assign(new Readable({ read() {} }), { isTTY: false }) as AccountStdin;
    const code = await cmdAccount(["login", "openai", "--code", "-"], { ...deps(), stdinImpl: silent });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("--code cannot be used");
    expect(paths()).toEqual(["/api/codex-auth/login", "/api/codex-auth/login/cancel"]);
    silent.destroy();
  }, 5_000);

  test("a failed cancel is reported instead of hidden", async () => {
    cancelStatus = 500;
    const code = await cmdAccount(["login", "openai", "--json"], deps());
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Could not cancel the started login flow.");
  });

  test.each(["already-ended EOF", "empty EOF", "timeout"])("auto login cancels its flow when stdin reaches %s", async (failure) => {
    deviceOnly = false;
    const stdin = Object.assign(new Readable({ read() {
      if (failure !== "timeout") this.push(null);
    } }), { isTTY: false }) as AccountStdin & Readable;
    try {
      if (failure === "already-ended EOF") {
        const ended = new Promise<void>(resolve => stdin.once("end", resolve));
        stdin.resume();
        await ended;
      }
      const code = await cmdAccount(["login", "openai", "--code", "-"], {
        ...deps(), stdinImpl: stdin, stdinTimeoutMs: 5,
      });
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain(failure === "timeout"
        ? "timed out waiting for authorization code on stdin"
        : "authorization code input was empty");
      expect(requests).toEqual([
        expect.objectContaining({ method: "POST", path: "/api/codex-auth/login" }),
        { method: "POST", path: "/api/codex-auth/login/cancel", body: { flowId: "flow-browser" } },
      ]);
    } finally {
      stdin.destroy();
    }
  });

  test("--no-wait --json still returns the URL, the device code and the policy", async () => {
    const code = await cmdAccount(["login", "openai", "--no-wait", "--json"], deps());
    expect(code ?? 0).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ url: "https://auth.openai.com/codex/device", deviceCode: "ABCD-EFGH", authMethod: "device-only" });
    expect(paths()).toEqual(["/api/codex-auth/login"]);
  });

  test("without the policy a JSON wait still polls to completion", async () => {
    deviceOnly = false;
    const code = await cmdAccount(["login", "openai", "--json"], deps());
    expect(code).toBe(0);
    expect(paths()).toEqual(["/api/codex-auth/login", "/api/codex-auth/login-status"]);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ status: "done" });
  }, 15_000);
});
