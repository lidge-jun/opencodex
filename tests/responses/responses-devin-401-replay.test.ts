import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { DEVIN_CLI_CREDENTIALS_ENV } from "../../src/oauth/devin/cli-import";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

const DEAD = "devin-session-token$synthetic-dead";
const LIVE = "devin-session-token$synthetic-live";
const ROTATED = "devin-session-token$synthetic-rotated";

const resolver = await import("../../src/server/adapter-resolve");
const originalResolve = resolver.resolveAdapter;
const originalResolverModule = { ...resolver };
let sentKeys: string[] = [];
let rateLimited = false;
mock.module("../../src/server/adapter-resolve", () => ({ ...resolver,
  resolveAdapter(provider: OcxProviderConfig, cache?: "none" | "short" | "long") {
    if (provider.adapter !== "devin") return originalResolve(provider, cache);
    return {
      name: "devin",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async *parseStream() { yield { type: "done" } as AdapterEvent; },
      async runTurn(_parsed, _incoming, emit) {
        const key = String(provider.apiKey);
        sentKeys.push(key);
        if (rateLimited) {
          emit({ type: "error", status: 429, errorType: "rate_limit_error", code: "resource_exhausted",
            retryable: true, message: "Cognition chat failed (resource_exhausted)" });
          return;
        }
        if (key === DEAD) {
          emit({ type: "error", status: 401, errorType: "authentication_error", code: "unauthenticated",
            retryable: false, message: "Devin cloud error unauthenticated: invalid api key" });
          return;
        }
        emit({ type: "text_delta", text: `served by ${key === ROTATED ? "rotated" : "live"}` });
        emit({ type: "done" });
      },
    } satisfies ProviderAdapter;
  },
}));
const { handleResponses } = await import("../../src/server/responses");

let home: ReturnType<typeof createTempHome>;
let release: (() => void) | undefined;
let previousCliPath: string | undefined;

beforeEach(() => {
  home = createTempHome("ocx-devin-401-replay-");
  release = acquireOwnedSpendHome();
  clearGenericFailoverHealth();
  sentKeys = [];
  rateLimited = false;
  previousCliPath = process.env[DEVIN_CLI_CREDENTIALS_ENV];
  // Never let a test read the developer's real CLI credential.
  process.env[DEVIN_CLI_CREDENTIALS_ENV] = home.path("devin-credentials.toml");
});
afterAll(() => {
  mock.module("../../src/server/adapter-resolve", () => originalResolverModule);
});
afterEach(() => {
  try {
    release?.();
  } finally {
    if (previousCliPath === undefined) delete process.env[DEVIN_CLI_CREDENTIALS_ENV];
    else process.env[DEVIN_CLI_CREDENTIALS_ENV] = previousCliPath;
    clearGenericFailoverHealth();
    home.remove();
  }
});

function writeCliFile(apiKey: string, apiServerUrl = "https://server.codeium.com"): void {
  writeFileSync(home.path("devin-credentials.toml"),
    `windsurf_api_key = "${apiKey}"\napi_server_url = "${apiServerUrl}"\n`);
}

async function saveDevin(access: string, accountId: string, source: "oauth" | "local-cli" = "oauth") {
  await saveCredential("devin", {
    access, refresh: access, expires: Number.MAX_SAFE_INTEGER, accountId, source,
    apiBaseUrl: "https://server.codeium.com",
  });
}

function run(stream = false) {
  const config = {
    port: 0, defaultProvider: "devin",
    providers: { devin: { adapter: "devin", authMode: "oauth", baseUrl: "https://server.codeium.com", models: ["swe-1-6"] } },
  } as OcxConfig;
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "devin/swe-1-6", input: "answer", stream }),
  }), config, { model: "", provider: "", surface: "codex" });
}

function account(id: string) {
  return getAccountSet("devin")?.accounts.find(row => row.credential.accountId === id);
}

test.each([false, true])("a revoked key is marked needsReauth and the turn fails over (stream=%s)", async stream => {
  await saveDevin(LIVE, "spare");
  await saveDevin(DEAD, "revoked");
  expect(getAccountSet("devin")?.activeAccountId).toBe(account("revoked")?.id);

  const response = await run(stream);
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("served by live");
  expect(sentKeys).toEqual([DEAD, LIVE]);
  expect(account("revoked")?.needsReauth).toBe(true);
  expect(getAccountSet("devin")?.activeAccountId).toBe(account("spare")?.id);

  // The dead account is not reselected by the next request.
  sentKeys = [];
  expect((await run()).status).toBe(200);
  expect(sentKeys).toEqual([LIVE]);
});

test("a lone revoked account surfaces the login instruction", async () => {
  await saveDevin(DEAD, "revoked");

  // A buffered runTurn failure is a `status: "failed"` Response object, not an HTTP error.
  const body = await (await run()).json() as { status: string; error: { type: string; message: string } };

  expect(body.status).toBe("failed");
  expect(body.error.type).toBe("authentication_error");
  expect(body.error.message).toBe("Not logged in to devin. Run: ocx login devin");
  expect(sentKeys).toEqual([DEAD]);
  expect(account("revoked")?.needsReauth).toBe(true);

  // Later turns fail fast on the flagged account instead of re-sending a dead key.
  sentKeys = [];
  const next = await run();
  expect(next.status).toBe(401);
  expect(await next.text()).toContain("ocx login devin");
  expect(sentKeys).toEqual([]);
});

test("a CLI-imported account adopts the key a later `devin auth login` wrote", async () => {
  await saveDevin(DEAD, "cli", "local-cli");
  writeCliFile(ROTATED);

  const response = await run();

  expect(response.status).toBe(200);
  expect(await response.text()).toContain("served by rotated");
  expect(sentKeys).toEqual([DEAD, ROTATED]);
  const row = account("cli");
  expect(row?.needsReauth).not.toBe(true);
  expect(row?.credential.access).toBe(ROTATED);
  expect(row?.credential.source).toBe("local-cli");
  expect(row?.credential.expires).toBe(Number.MAX_SAFE_INTEGER);
});

test.each([
  ["unchanged", () => writeCliFile(DEAD)],
  ["missing", () => {}],
  ["off-allowlist host", () => writeCliFile(ROTATED, "https://attacker.example")],
])("a CLI-imported account with a %s credential file needs reauth", async (_label, arrange) => {
  await saveDevin(DEAD, "cli", "local-cli");
  arrange();

  const body = await (await run()).json() as { error: { message: string } };

  expect(body.error.message).toBe("Not logged in to devin. Run: ocx login devin");
  expect(sentKeys).toEqual([DEAD]);
  expect(account("cli")?.needsReauth).toBe(true);
  expect(account("cli")?.credential.access).toBe(DEAD);
});

test("a CLI key another stored account already owns is not adopted", async () => {
  await saveDevin(ROTATED, "other");
  await saveDevin(DEAD, "cli", "local-cli");
  writeCliFile(ROTATED);

  await (await run()).text();

  expect(account("cli")?.needsReauth).toBe(true);
  expect(account("cli")?.credential.access).toBe(DEAD);
});

test("a 429 is not treated as an authentication failure", async () => {
  await saveDevin(LIVE, "limited");
  rateLimited = true;

  const body = await (await run()).json() as { error: { type: string } };

  expect(body.error.type).toBe("rate_limit_error");
  expect(sentKeys).toEqual([LIVE]);
  expect(account("limited")?.needsReauth).not.toBe(true);
});
