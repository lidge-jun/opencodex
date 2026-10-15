import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { cancelLoginFlow, clearLoginState, getLoginStatus, OAUTH_PROVIDERS, publicOAuthAuthenticationErrorMessage } from "../../src/oauth";
import { loginMetaMuse, type MuseImportDeps } from "../../src/oauth/meta-muse";
import { MuseLoginError } from "../../src/oauth/meta-muse-errors";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";

const original = OAUTH_PROVIDERS["meta-muse"].login;
let testDir = "";
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-muse-diagnostics-"));
  process.env.OPENCODEX_HOME = testDir;
  codexHome = installIsolatedCodexHome("ocx-muse-diagnostics-codex-");
  saveConfig({ port: 0, defaultProvider: "stub", providers: { stub: { adapter: "openai-chat", baseUrl: "https://stub.invalid/v1", apiKey: "stub-key" } } } as OcxConfig);
});
afterEach(async () => {
  cancelLoginFlow("meta-muse");
  OAUTH_PROVIDERS["meta-muse"].login = original;
  clearLoginState("meta-muse");
  try {
    await removeTreeAfterBackgroundWork(testDir);
    if (codexHome) await removeTreeAfterBackgroundWork(codexHome.path);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    codexHome?.restoreEnvironment();
  }
});
const pointer = JSON.stringify({ providers: { meta: { mechanism: "oauth", storage: "keychain" } } });
const deps: MuseImportDeps = {
  platform: "darwin", readPointer: async () => pointer,
  readKeychain: async () => { throw new MuseLoginError("keychain-denied"); },
  loginDevice: async () => { throw new Error("must not start a second login"); },
};
const cfg = { port: 0, providers: {} } as OcxConfig;
const request = () => new ManagementRequest("http://localhost/api/oauth/login", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "meta-muse" }),
});

describe("Muse login diagnostics across management boundaries", () => {
  test("fixed diagnostics survive projection even if message and cause contain private data", () => {
    const error = new MuseLoginError("keychain-denied");
    error.message = "private-credential-and-path";
    error.cause = new Error("private-provider-body");
    expect(publicOAuthAuthenticationErrorMessage(error)).toBe(new MuseLoginError("keychain-denied").message);
    expect(publicOAuthAuthenticationErrorMessage(new Error("private-provider-body"))).toStartWith("OAuth authentication failed.");
    expect(publicOAuthAuthenticationErrorMessage(new MuseLoginError("validation-http", 401))).toContain("HTTP 401");
    expect(publicOAuthAuthenticationErrorMessage(new MuseLoginError("validation-http", NaN))).not.toContain("NaN");
  });

  test("early import failures return a safe actionable login response", async () => {
    OAUTH_PROVIDERS["meta-muse"].login = async ctrl => loginMetaMuse({ ...ctrl, onManualCodeInput: undefined }, { ...deps, readPointer: async () => "null" });
    const req = request();
    const res = await handleManagementAPI(req, new URL(req.url), cfg, {}, "gui-session");
    expect(res?.status).toBe(409);
    expect((await res!.json()).error).toBe(new MuseLoginError("pointer-invalid").message);
  });

  test("Keychain hint returns before approval; late refusal remains actionable in status", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    OAUTH_PROVIDERS["meta-muse"].login = async ctrl => loginMetaMuse({ ...ctrl, onManualCodeInput: undefined }, {
      ...deps, readKeychain: async () => { await waiting; throw new MuseLoginError("keychain-denied"); },
    });
    const req = request();
    const res = await handleManagementAPI(req, new URL(req.url), cfg, {}, "gui-session");
    expect(res?.status).toBe(200);
    expect(await res!.json()).toMatchObject({ url: "", instructions: expect.stringContaining("120 seconds") });
    expect(getLoginStatus("meta-muse").done).toBe(false);
    finish();
    for (let i = 0; i < 100 && !getLoginStatus("meta-muse").done; i++) await Bun.sleep(1);
    const statusReq = new ManagementRequest("http://localhost/api/oauth/status?provider=meta-muse");
    const statusRes = await handleManagementAPI(statusReq, new URL(statusReq.url), cfg, {}, "gui-session");
    expect((await statusRes!.json()).error).toBe(new MuseLoginError("keychain-denied").message);
  });

  test.each(["null", "[]", '"string"', '{"providers":null}', '{"providers":{"meta":null}}'])("invalid pointer %s is contained", async raw => {
    await expect(loginMetaMuse({}, { ...deps, readPointer: async () => raw })).rejects.toThrow(/invalid shape/);
  });

  test("unsupported storage text is never reflected", async () => {
    const raw = JSON.stringify({ providers: { meta: { mechanism: "oauth", storage: "private-storage-value" } } });
    const error = await loginMetaMuse({}, { ...deps, readPointer: async () => raw }).catch(e => e);
    expect(error.kind).toBe("storage-unsupported");
    expect(error.message).not.toContain("private-storage-value");
  });

  test("import refusal offers explicit paste recovery without starting another grant", async () => {
    let grants = 0;
    const hints: string[] = [];
    const key = `LLM|${"1".repeat(16)}|${"c".repeat(27)}`;
    const credential = await loginMetaMuse({
      onAuth: info => hints.push(info.instructions ?? ""),
      onManualCodeInput: async () => key,
    }, {
      ...deps,
      loginDevice: async () => { grants++; throw new Error("unexpected grant"); },
      fetchImpl: (async (url, init) => {
        expect(url).toBe("https://api.meta.ai/v1/models");
        expect(new Headers(init?.headers).get("x-api-version")).toBe("1.0.0");
        expect(init?.redirect).toBe("error");
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    expect(credential.source).toBe("manual");
    expect(credential.access === key).toBe(true);
    expect(credential.email).toBeUndefined();
    expect(grants).toBe(0);
    expect(hints.join(" ")).toContain("denied");
    expect(hints.join(" ")).not.toContain(key);
  });

  test("empty recovery preserves the import diagnosis; cancellation never validates", async () => {
    await expect(loginMetaMuse({ onManualCodeInput: async () => "" }, deps)).rejects.toThrow(/denied/);
    const ac = new AbortController();
    let fetched = false;
    await expect(loginMetaMuse({ signal: ac.signal, onManualCodeInput: async () => { ac.abort(); return "ignored"; } }, {
      ...deps, fetchImpl: (async () => { fetched = true; return new Response(); }) as typeof fetch,
    })).rejects.toThrow(/cancelled/);
    expect(fetched).toBe(false);
  });

  test("dashboard import failure continues through the existing manual-code endpoint", async () => {
    const key = `LLM|${"2".repeat(16)}|${"d".repeat(27)}`;
    OAUTH_PROVIDERS["meta-muse"].login = async ctrl => loginMetaMuse(ctrl, {
      ...deps, fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });
    const req = request();
    const res = await handleManagementAPI(req, new URL(req.url), cfg, {}, "gui-session");
    expect(res?.status).toBe(200);
    for (let i = 0; i < 100 && !getLoginStatus("meta-muse").hint?.url; i++) await Bun.sleep(1);
    expect(getLoginStatus("meta-muse").hint?.instructions).toContain("denied");
    const codeReq = new ManagementRequest("http://localhost/api/oauth/login/code", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "meta-muse", input: key }),
    });
    const codeRes = await handleManagementAPI(codeReq, new URL(codeReq.url), cfg, {}, "gui-session");
    expect(codeRes?.status).toBe(200);
    for (let i = 0; i < 100 && !getLoginStatus("meta-muse").done; i++) await Bun.sleep(1);
    const status = getLoginStatus("meta-muse");
    expect(status.done).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(JSON.stringify(status)).not.toContain(key);
  });

  test("validation transport errors never reflect provider text", async () => {
    const key = `LLM|${"1".repeat(16)}|${"c".repeat(27)}`;
    const error = await loginMetaMuse({}, { ...deps, readKeychain: async () => JSON.stringify({ api_key: key }),
      fetchImpl: (async () => { throw new Error("private-network-details"); }) as unknown as typeof fetch,
    }).catch(e => e);
    expect(error.kind).toBe("validation-network");
    expect(publicOAuthAuthenticationErrorMessage(error)).not.toContain("private-network-details");
  });

  test("cancellation after an injected read prevents validation and persistence", async () => {
    const ac = new AbortController();
    let fetched = false;
    await expect(loginMetaMuse({ signal: ac.signal }, { ...deps,
      readKeychain: async () => { ac.abort(); return "{}"; },
      fetchImpl: (async () => { fetched = true; return new Response(); }) as unknown as typeof fetch,
    })).rejects.toThrow(/cancelled/);
    expect(fetched).toBe(false);
  });
});
