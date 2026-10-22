import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import {
  antigravityModelUnlistedMessage,
  antigravitySelectedAccountUnlistedMessage,
  clearGenericFailoverHealth,
} from "../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setAccountPaused, setActiveAccount } from "../../src/oauth/store";
import { clearPoolRotationState } from "../../src/oauth/pool-kernel";
import { clearAntigravityAccountRosters, recordAntigravityAccountRoster } from "../../src/providers/antigravity-account-roster";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import * as retry from "../../src/lib/upstream-retry";

// #7500: an Antigravity request reaches only accounts whose own model discovery may serve it.
const provider = "google-antigravity";
const origin = "https://daily-cloudcode-pa.googleapis.com";
const model = "gemini-3.8-flash";
let home: string;
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;
let release: () => void;
let originalFetch: typeof fetch;
let sleep: ReturnType<typeof spyOn>;
let ids: string[];
let sends: string[];
let onSend: ((auth: string) => Promise<Response | undefined>) | undefined;

beforeEach(async () => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-agy-model-routing-"));
  process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome("ocx-agy-model-routing-codex-");
  release = acquireOwnedSpendHome();
  clearGenericFailoverHealth();
  clearPoolRotationState();
  originalFetch = globalThis.fetch;
  sleep = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
  for (const slot of ["one", "two", "three"]) {
    await saveCredential(provider, { access: `synthetic-${slot}`, refresh: `synthetic-refresh-${slot}`,
      expires: Date.now() + 3_600_000, accountId: `synthetic-${slot}`, projectId: `synthetic-project-${slot}` });
  }
  ids = getAccountSet(provider)!.accounts.map(row => row.id);
  await setActiveAccount(provider, ids[0]!);
  sends = [];
  onSend = undefined;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "synthetic-refreshed", expires_in: 3600, token_type: "Bearer" });
    if (url.origin !== origin || !["/v1internal:generateContent", "/v1internal:streamGenerateContent"].includes(url.pathname))
      throw new Error("Unexpected external request in Antigravity model routing regression");
    const auth = new Headers(init?.headers).get("authorization")!;
    sends.push(auth);
    return await onSend?.(auth) ?? Response.json({ response: {
      candidates: [{ content: { role: "model", parts: [{ text: "synthetic result" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  sleep.mockRestore();
  release();
  clearGenericFailoverHealth();
  clearAntigravityAccountRosters();
  clearPoolRotationState();
  codexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function config(enabled?: boolean): OcxConfig {
  const cfg = { defaultProvider: provider, providers: { [provider]: {
    adapter: "google", authMode: "oauth", baseUrl: origin, googleMode: "cloud-code-assist", models: [model],
    ...(enabled === undefined ? {} : { oauthAccountFailover: { enabled } }),
  } } } as unknown as OcxConfig;
  saveConfig(cfg);
  return cfg;
}

/** `true` lists the model, `false` lists only another one, `undefined` leaves the roster unknown. */
function rosters(...lists: Array<boolean | undefined>): void {
  lists.forEach((listed, index) => {
    if (listed === undefined) return;
    const id = listed ? model : "gemini-other";
    recordAntigravityAccountRoster(provider, ids[index]!, [{ id, wireModelId: id } as never]);
  });
}

async function turn(cfg: OcxConfig): Promise<{ status: number; body: { error?: { message?: string; type?: string; code?: string } } }> {
  const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: `${provider}/${model}`, input: "synthetic input", stream: false }),
  }), cfg, { model, provider }, {});
  return { status: response.status, body: await response.json() as never };
}

const bearer = (index: number) => `Bearer synthetic-${["one", "two", "three"][index]}`;

test("an active account that lists the model, or has no roster yet, is used unchanged", async () => {
  rosters(undefined, true, true);
  expect((await turn(config(true))).status).toBe(200);
  rosters(true, false, false);
  expect((await turn(config(true))).status).toBe(200);
  expect(sends).toEqual([bearer(0), bearer(0)]);
});

test("with failover enabled an omitting active account yields to a sibling that may serve", async () => {
  // The unknown sibling is chosen even though the existing preference only follows a listing one.
  rosters(false, false, undefined);
  expect((await turn(config(true))).status).toBe(200);
  expect(sends).toEqual([bearer(2)]);
});

test("every usable account omitting the model refuses locally without an upstream send", async () => {
  rosters(false, false, true);
  await setAccountPaused(provider, ids[2]!, true);
  const result = await turn(config(true));
  expect(result.status).toBe(403);
  expect(result.body.error).toMatchObject({
    type: "permission_error", code: "permission_denied", message: antigravityModelUnlistedMessage(model),
  });
  expect(sends).toEqual([]);
});

test("without failover an omitting selected account is refused, not moved", async () => {
  rosters(false, true, true);
  for (const enabled of [undefined, false]) {
    const result = await turn(config(enabled));
    expect(result.status).toBe(403);
    expect(result.body.error?.message).toBe(antigravitySelectedAccountUnlistedMessage(model));
  }
  expect(sends).toEqual([]);
  expect(getAccountSet(provider)!.activeAccountId).toBe(ids[0]);
});

test("a recovery rebind onto a newly selected omitting account is abandoned, not sent", async () => {
  rosters(true, false, false);
  // The operator selects an omitting account while the first send is being refused with 401.
  onSend = async auth => {
    if (auth !== bearer(0)) return undefined;
    await setActiveAccount(provider, ids[1]!);
    return Response.json({ error: { code: 401, status: "UNAUTHENTICATED", message: "synthetic" } }, { status: 401 });
  };
  const result = await turn(config());
  expect(result.status).not.toBe(200);
  expect(sends).not.toContain(bearer(1));
});
