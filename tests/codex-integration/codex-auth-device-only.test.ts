/**
 * `codexAuthMethod: "device-only"` (#8082): a headless hub must be able to
 * require the device grant for every Codex pool login, including the
 * dashboard's Re-authenticate action, which starts a login without asking for
 * any flow. Absent and "auto" must keep the caller's choice exactly as before.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { validateConfigCandidate } from "../../src/config/diagnostics";
import { loadConfig } from "../../src/config";
import type { OcxConfig } from "../../src/types";
import {
  addCodexAccountUiReducer,
  initialAddCodexAccountUiState,
} from "../../gui/src/components/add-codex-account-reducer";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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
  try {
    const req = new Request("http://localhost/api/codex-auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openBrowser: true, ...body }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as Record<string, unknown>;
    return { status: resp!.status, data, flow: (startSpy.mock.calls[0]?.[1] as { flow?: string } | undefined)?.flow, opened: openSpy.mock.calls.length };
  } finally {
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
      port: 10100, providers: VALID_PROVIDERS, defaultProvider: "openai", codexAuthMethod: "browser",
    }));
    expect(loadConfig().codexAuthMethod).toBeUndefined();
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
      const source = await Bun.file(`gui/src/i18n/${locale}.ts`).text();
      expect(source).toContain('"codexAuth.deviceOnlyEnforced"');
    }
  });
});
