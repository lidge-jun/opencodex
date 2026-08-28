import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGenericFailoverHealth } from "../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

const ACCOUNT_A_ORIGIN = "https://a.githubcopilot.com";
const ACCOUNT_B_ORIGIN = "https://b.githubcopilot.com";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const GITHUB_USER_URL = "https://api.github.com/user";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
let home = "";

type Wire = "chat" | "responses";

function bearer(accessToken: string): string {
  return ["Bearer", accessToken].join(" ");
}

function config(wire: Wire): OcxConfig {
  const model = wire === "chat" ? "gpt-4o" : "gpt-5.4";
  return {
    port: 0,
    defaultProvider: "github-copilot",
    providers: {
      "github-copilot": {
        adapter: "openai-chat",
        authMode: "oauth",
        baseUrl: "https://api.githubcopilot.com",
        models: [model],
        ...(wire === "responses" ? { modelAdapters: { [model]: "openai-responses" } } : {}),
      },
    },
  } as OcxConfig;
}

function request(wire: Wire): Request {
  const model = wire === "chat" ? "gpt-4o" : "gpt-5.4";
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: `github-copilot/${model}`, input: "hello", stream: false }),
  });
}

function successResponse(wire: Wire): Response {
  if (wire === "responses") {
    return Response.json({
      id: "resp-copilot-origin",
      object: "response",
      status: "completed",
      model: "gpt-5.4",
      output: [{
        id: "msg-copilot-origin",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }
  return Response.json({
    id: "chatcmpl-copilot-origin",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

async function seedAccounts(aExpires = Date.now() + 3_600_000): Promise<{ a: string; b: string }> {
  await saveCredential("github-copilot", {
    access: "copilot-access-a",
    refresh: "gho-account-a",
    expires: aExpires,
    accountId: "101",
    apiBaseUrl: ACCOUNT_A_ORIGIN,
    source: "oauth",
  });
  await saveCredential("github-copilot", {
    access: "copilot-access-b",
    refresh: "gho-account-b",
    expires: Date.now() + 3_600_000,
    accountId: "202",
    apiBaseUrl: ACCOUNT_B_ORIGIN,
    source: "oauth",
  });
  const set = getAccountSet("github-copilot");
  const a = set?.accounts.find(account => account.credential.accountId === "101")?.id;
  const b = set?.accounts.find(account => account.credential.accountId === "202")?.id;
  if (!a || !b) throw new Error("failed to seed Copilot account fixtures");
  await setActiveAccount("github-copilot", a);
  return { a, b };
}

function installFetch(options: {
  wire: Wire;
  statuses: number[];
  switchToAccountId?: string;
  switchOn: "refresh" | "first-dispatch" | "never";
}): { dispatches: { origin: string; authorization: string }[] } {
  const dispatches: { origin: string; authorization: string }[] = [];
  let refreshSwitched = false;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === COPILOT_TOKEN_URL) {
      if (options.switchOn === "refresh" && options.switchToAccountId && !refreshSwitched) {
        refreshSwitched = true;
        await setActiveAccount("github-copilot", options.switchToAccountId);
      }
      return Response.json({
        token: "copilot-access-a-refreshed",
        refresh_in: 1500,
        endpoints: { api: ACCOUNT_A_ORIGIN },
      });
    }
    if (url === GITHUB_USER_URL) return Response.json({ id: 101 });

    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".githubcopilot.com") || parsed.hostname === "api.githubcopilot.com") {
      dispatches.push({
        origin: parsed.origin,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
      });
      if (options.switchOn === "first-dispatch" && options.switchToAccountId && dispatches.length === 1) {
        await setActiveAccount("github-copilot", options.switchToAccountId);
      }
      const status = options.statuses.shift() ?? 200;
      if (status !== 200) {
        return Response.json({ error: { message: status === 401 ? "rejected" : "limited" } }, {
          status,
          headers: status === 429 ? { "retry-after": "1" } : undefined,
        });
      }
      return successResponse(options.wire);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return { dispatches };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-copilot-origin-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearGenericFailoverHealth();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("GitHub Copilot bearer/origin snapshot atomicity", () => {
  for (const wire of ["chat", "responses"] as const) {
    test(`${wire} initial refresh keeps account A's origin after B becomes active`, async () => {
      const accounts = await seedAccounts(0);
      const observed = installFetch({
        wire,
        statuses: [200],
        switchToAccountId: accounts.b,
        switchOn: "refresh",
      });

      const response = await handleResponses(request(wire), config(wire), { model: "", provider: "" });
      await response.text();

      expect(response.status).toBe(200);
      expect(observed.dispatches).toEqual([{
        origin: ACCOUNT_A_ORIGIN,
        authorization: bearer("copilot-access-a-refreshed"),
      }]);
    });

    test(`${wire} 401 replay keeps refreshed account A's origin after B becomes active`, async () => {
      const accounts = await seedAccounts();
      const observed = installFetch({
        wire,
        statuses: [401, 200],
        switchToAccountId: accounts.b,
        switchOn: "first-dispatch",
      });

      const response = await handleResponses(request(wire), config(wire), { model: "", provider: "" });
      await response.text();

      expect(response.status).toBe(200);
      expect(observed.dispatches).toEqual([
        { origin: ACCOUNT_A_ORIGIN, authorization: bearer("copilot-access-a") },
        { origin: ACCOUNT_A_ORIGIN, authorization: bearer("copilot-access-a-refreshed") },
      ]);
    });
  }

  test("chat 429 failover moves bearer and origin together to account B", async () => {
    await seedAccounts();
    const observed = installFetch({ wire: "chat", statuses: [429, 200], switchOn: "never" });

    const response = await handleResponses(request("chat"), config("chat"), { model: "", provider: "" });
    await response.text();

    expect(response.status).toBe(200);
    expect(observed.dispatches).toEqual([
      { origin: ACCOUNT_A_ORIGIN, authorization: bearer("copilot-access-a") },
      { origin: ACCOUNT_B_ORIGIN, authorization: bearer("copilot-access-b") },
    ]);
  });
});
