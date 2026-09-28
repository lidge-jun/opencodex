import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import { getAccountSet, replaceProviderAccountSet, saveCredential, setAccountPaused, setActiveAccount } from "../../src/oauth/store";
import { forceRefreshOAuthAccessSnapshot, getValidAccessTokenSnapshot } from "../../src/oauth";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { DEVIN_CLI_CREDENTIALS_ENV } from "../../src/oauth/devin/cli-import";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

const DEAD = "devin-session-token$synthetic-dead";
const LIVE = "devin-session-token$synthetic-live";
const ROTATED = "devin-session-token$synthetic-rotated";
const DEAD_OTHER = "devin-session-token$synthetic-dead-other";
const originalFetch = globalThis.fetch;

// GetUserJwt stand-in: the identity a key mints, keyed by the key inside the protobuf body.
let mintedIdentity: Record<string, { auth_uid?: string; sub?: string; email?: string } | undefined> = {};
let mintCalls = 0;
let mintFailure: (() => Response) | undefined;
let holdMint: (() => Promise<void>) | undefined;
function fakeUserJwt(payload: object): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ ...payload, exp: 9_999_999_999 })}.c2lnbmF0dXJl`;
}
const mintFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.endsWith("/exa.auth_pb.AuthService/GetUserJwt")) return originalFetch(input, init);
  mintCalls++;
  await holdMint?.();
  if (mintFailure) return mintFailure();
  const body = Buffer.from(init?.body as Uint8Array).toString("latin1");
  const key = Object.keys(mintedIdentity).find(candidate => body.includes(candidate));
  const identity = key ? mintedIdentity[key] : undefined;
  if (!identity) return new Response("", { status: 401 });
  const jwt = Buffer.from(fakeUserJwt(identity));
  return new Response(Buffer.concat([Buffer.from([0x0a, jwt.length & 0x7f | 0x80, jwt.length >> 7]), jwt]),
    { status: 200, headers: { "content-type": "application/proto" } });
}) as typeof fetch;

const resolver = await import("../../src/server/adapter-resolve");
const originalResolve = resolver.resolveAdapter;
const originalResolverModule = { ...resolver };
let sentKeys: string[] = [];
let rateLimited = false;
let holdDeadSend: (() => Promise<void>) | undefined;
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
          await holdDeadSend?.();
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
  holdDeadSend = undefined;
  mintedIdentity = { [ROTATED]: { auth_uid: "uid-rotated", email: "rotated@example.com" } };
  mintCalls = 0;
  mintFailure = undefined;
  holdMint = undefined;
  globalThis.fetch = mintFetch;
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
    globalThis.fetch = originalFetch;
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

// A CLI import records no identity: the session token it copies carries only a session_id.
async function saveCliImport(access: string, extra: { accountId?: string; email?: string } = {}) {
  await saveCredential("devin", {
    access, refresh: access, expires: Number.MAX_SAFE_INTEGER, source: "local-cli",
    apiBaseUrl: "https://server.codeium.com", ...extra,
  }, { preserveIdentityless: true });
}

function cliAccount() {
  return getAccountSet("devin")?.accounts.find(row => row.credential.source === "local-cli");
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

test("an identity-less CLI import rejects a rotated key and needs reauth", async () => {
  await saveCliImport(DEAD);
  writeCliFile(ROTATED);

  const body = await (await run()).json() as { error: { message: string } };
  expect(body.error.message).toBe("Not logged in to devin. Run: ocx login devin");
  expect(sentKeys).toEqual([DEAD]);
  expect(mintCalls).toBe(0);
  const row = cliAccount();
  expect(row?.needsReauth).toBe(true);
  expect(row?.credential.access).toBe(DEAD);
});

test("a CLI file belonging to another user cannot replace a bound account", async () => {
  await saveCliImport(DEAD, { accountId: "uid-original", email: "original@example.com" });
  writeCliFile(ROTATED); // Mints uid-rotated, a different Devin user.

  const body = await (await run()).json() as { error: { message: string } };
  expect(body.error.message).toBe("Not logged in to devin. Run: ocx login devin");
  expect(sentKeys).toEqual([DEAD]);
  expect(mintCalls).toBe(1);
  expect(cliAccount()?.needsReauth).toBe(true);
  expect(cliAccount()?.credential.access).toBe(DEAD);
});

test("a legacy alias copy of the same account already holding the rotated key does not block adoption", async () => {
  await saveCliImport(DEAD, { accountId: "uid-rotated" });
  const current = cliAccount()!;
  await replaceProviderAccountSet("devin-cli", {
    activeAccountId: current.id,
    accounts: [{ ...current, credential: {
      ...current.credential, access: ROTATED, refresh: ROTATED,
      accountId: "uid-rotated", email: "rotated@example.com",
    } }],
  });
  writeCliFile(ROTATED);

  expect(await (await run()).text()).toContain("served by rotated");
  expect(sentKeys).toEqual([DEAD, ROTATED]);
  expect(cliAccount()?.credential.access).toBe(ROTATED);
  expect(getAccountSet("devin-cli")?.accounts[0]?.credential.access).toBe(ROTATED);
  expect(cliAccount()?.needsReauth).not.toBe(true);
});

test("a distinct legacy alias account holding the rotated key blocks adoption", async () => {
  await saveCliImport(DEAD);
  await saveCredential("devin-cli", {
    access: ROTATED, refresh: ROTATED, expires: Number.MAX_SAFE_INTEGER,
    source: "oauth", apiBaseUrl: "https://server.codeium.com",
  });
  writeCliFile(ROTATED);

  await (await run()).text();
  expect(sentKeys).not.toContain(ROTATED);
  expect(mintCalls).toBe(0);
  expect(cliAccount()?.credential.access).toBe(DEAD);
  expect(cliAccount()?.needsReauth).toBe(true);
});

test("a distinct legacy alias account still blocks an owned CLI identity", async () => {
  await saveCredential("devin-cli", {
    access: LIVE, refresh: LIVE, expires: Number.MAX_SAFE_INTEGER,
    accountId: "uid-rotated", source: "oauth", apiBaseUrl: "https://server.codeium.com",
  });
  await saveCliImport(DEAD, { email: "rotated@example.com" });
  writeCliFile(ROTATED);

  await (await run()).text();
  expect(cliAccount()?.credential.access).toBe(DEAD);
  expect(cliAccount()?.needsReauth).toBe(true);
});

test.each([
  ["unchanged", () => writeCliFile(DEAD)],
  ["missing", () => {}],
  ["off-allowlist host", () => writeCliFile(ROTATED, "https://attacker.example")],
])("a CLI-imported account with a %s credential file needs reauth", async (_label, arrange) => {
  await saveCliImport(DEAD);
  arrange();

  const body = await (await run()).json() as { error: { message: string } };

  expect(body.error.message).toBe("Not logged in to devin. Run: ocx login devin");
  expect(sentKeys).toEqual([DEAD]);
  expect(cliAccount()?.needsReauth).toBe(true);
  expect(cliAccount()?.credential.access).toBe(DEAD);
  // The key is only ever sent to an allowlisted host, including the identity probe.
  expect(mintCalls).toBe(0);
});

test("a CLI key another stored account already owns is not adopted", async () => {
  await saveDevin(ROTATED, "other");
  await saveCliImport(DEAD, { accountId: "uid-rotated" });
  writeCliFile(ROTATED);

  await (await run()).text();

  expect(cliAccount()?.needsReauth).toBe(true);
  expect(cliAccount()?.credential.access).toBe(DEAD);
});

test.each([
  ["a key Cognition refuses with 401", async () => { mintedIdentity = {}; await saveCliImport(DEAD, { accountId: "uid-rotated" }); }],
  ["a key Cognition refuses with 403", async () => {
    mintFailure = () => new Response("", { status: 403 });
    await saveCliImport(DEAD, { accountId: "uid-rotated" });
  }],
  ["a minted token without auth_uid", async () => {
    mintedIdentity = { [ROTATED]: { email: "rotated@example.com" } };
    await saveCliImport(DEAD, { accountId: "uid-rotated" });
  }],
  ["a slot whose recorded accountId differs", async () => { await saveCliImport(DEAD, { accountId: "uid-before" }); }],
  ["a slot whose recorded email differs", async () => { await saveCliImport(DEAD, { email: "before@example.com" }); }],
  ["an identity another stored account owns", async () => {
    await saveDevin(LIVE, "uid-rotated");
    await saveCliImport(DEAD, { email: "rotated@example.com" });
  }],
])("the CLI key is not adopted for %s", async (_label, arrange) => {
  await arrange();
  writeCliFile(ROTATED);

  await (await run()).text();

  expect(sentKeys).not.toContain(ROTATED);
  expect(cliAccount()?.needsReauth).toBe(true);
  expect(cliAccount()?.credential.access).toBe(DEAD);
});

test.each([
  ["a transient 503", () => new Response("", { status: 503 })],
  ["a 429", () => new Response("", { status: 429 })],
  ["a network failure", () => { throw new TypeError("fetch failed"); }],
])("an identity probe that fails with %s does not flag the account", async (_label, failure) => {
  await saveCliImport(DEAD, { accountId: "uid-rotated" });
  writeCliFile(ROTATED);
  mintFailure = failure;

  const body = await (await run()).json() as { error: { type: string; message: string } };

  expect(body.error.type).toBe("authentication_error");
  expect(body.error.message).not.toContain("ocx login devin");
  expect(cliAccount()?.needsReauth).not.toBe(true);
  expect(cliAccount()?.credential.access).toBe(DEAD);

  // Once the probe recovers, the next 401 adopts the rotated key.
  mintFailure = undefined;
  expect(await (await run()).text()).toContain("served by rotated");
  expect(cliAccount()?.credential.access).toBe(ROTATED);
});

test("a credential file caught mid-write does not flag the account", async () => {
  await saveCliImport(DEAD, { accountId: "uid-rotated" });
  // Half-written by `devin auth login`: the key line is there, the server line is not yet.
  writeFileSync(home.path("devin-credentials.toml"), `windsurf_api_key = "${ROTATED}"\n`);

  const body = await (await run()).json() as { error: { type: string; message: string } };

  expect(body.error.type).toBe("authentication_error");
  expect(body.error.message).not.toContain("ocx login devin");
  expect(cliAccount()?.needsReauth).not.toBe(true);
  expect(mintCalls).toBe(0);

  // Once the write completes, the next 401 adopts the rotated key.
  writeCliFile(ROTATED);
  expect(await (await run()).text()).toContain("served by rotated");
  expect(cliAccount()?.credential.access).toBe(ROTATED);
});

test("concurrent identity-less CLI slots both require explicit reauth", async () => {
  await saveCliImport(DEAD);
  const first = await getValidAccessTokenSnapshot("devin");
  await saveCliImport(DEAD_OTHER);
  const second = await getValidAccessTokenSnapshot("devin");
  expect(first.accountId).not.toBe(second.accountId);
  writeCliFile(ROTATED);
  const outcomes = await Promise.allSettled([
    forceRefreshOAuthAccessSnapshot(first), forceRefreshOAuthAccessSnapshot(second),
  ]);
  const rows = getAccountSet("devin")!.accounts;
  expect(outcomes.every(outcome => outcome.status === "rejected")).toBe(true);
  expect(rows.filter(row => row.credential.access === ROTATED)).toHaveLength(0);
  expect(rows.every(row => row.needsReauth === true)).toBe(true);
  expect(mintCalls).toBe(0);
});

test.each([false, true])("an account paused during 401 refresh returns 403 (stream=%s)", async stream => {
  await saveCliImport(DEAD, { accountId: "uid-rotated" });
  const accountId = cliAccount()!.id;
  writeCliFile(ROTATED);
  const mintStarted = Promise.withResolvers<void>();
  const releaseMint = Promise.withResolvers<void>();
  holdMint = async () => { mintStarted.resolve(); await releaseMint.promise; };
  const responsePromise = run(stream);
  await mintStarted.promise;
  await setAccountPaused("devin", accountId, true);
  releaseMint.resolve();
  const response = await responsePromise;
  const body = await response.json() as { error: { type: string; message: string } };
  expect(response.status).toBe(403);
  expect(body.error.type).toBe("permission_error");
  expect(body.error.message).toContain("OAuth account is paused");
  expect(sentKeys).toEqual([DEAD]);
  expect(cliAccount()?.needsReauth).not.toBe(true);
  expect(cliAccount()?.credential.access).toBe(DEAD);
});

test("a slot recorded from the key's `sub` claim still matches the minted identity", async () => {
  mintedIdentity = { [ROTATED]: { auth_uid: "uid-rotated", sub: "sub-rotated", email: "rotated@example.com" } };
  await saveCliImport(DEAD, { accountId: "sub-rotated" });
  writeCliFile(ROTATED);

  expect(await (await run()).text()).toContain("served by rotated");
  expect(cliAccount()?.credential.accountId).toBe("uid-rotated");
});

test("a slot whose recorded identity matches adopts the rotated key", async () => {
  await saveCliImport(DEAD, { accountId: "uid-rotated", email: "  Rotated@Example.com " });
  writeCliFile(ROTATED);

  expect(await (await run()).text()).toContain("served by rotated");
  expect(cliAccount()?.credential.access).toBe(ROTATED);
  expect(mintCalls).toBe(1);
});

test("a slot bound only by matching email adopts the rotated key", async () => {
  await saveCliImport(DEAD, { email: "  Rotated@Example.com " });
  writeCliFile(ROTATED);

  expect(await (await run()).text()).toContain("served by rotated");
  expect(cliAccount()?.credential.access).toBe(ROTATED);
  expect(cliAccount()?.credential.accountId).toBe("uid-rotated");
});

test("a turn whose 401 lands after another turn already failed the account over still fails over", async () => {
  await saveDevin(LIVE, "spare");
  await saveDevin(DEAD, "revoked");
  // Both turns send on the revoked account; the second 401 only arrives once the first turn has
  // flagged it and moved the selection, so the second refresh sees a changed selection.
  const bothSent = Promise.withResolvers<void>();
  const firstDone = Promise.withResolvers<void>();
  let deadSends = 0;
  holdDeadSend = async () => {
    const order = ++deadSends;
    if (order === 2) bothSent.resolve();
    await bothSent.promise;
    if (order === 2) await firstDone.promise;
  };

  const first = run().then(async response => {
    const text = await response.text();
    firstDone.resolve();
    return text;
  });
  const second = run().then(response => response.text());
  const [firstBody, secondBody] = await Promise.all([first, second]);

  expect(deadSends).toBe(2);
  expect(firstBody).toContain("served by live");
  expect(secondBody).toContain("served by live");
  expect(account("revoked")?.needsReauth).toBe(true);
  expect(getAccountSet("devin")?.activeAccountId).toBe(account("spare")?.id);
});

test("a 429 is not treated as an authentication failure", async () => {
  await saveDevin(LIVE, "limited");
  rateLimited = true;

  const body = await (await run()).json() as { error: { type: string } };

  expect(body.error.type).toBe("rate_limit_error");
  expect(sentKeys).toEqual([LIVE]);
  expect(account("limited")?.needsReauth).not.toBe(true);
});

test("a selection that leaves the revoked account and returns to it before the 401 still refreshes it", async () => {
  await saveDevin(LIVE, "spare");
  await saveDevin(DEAD, "revoked");
  const revoked = account("revoked")!.id;
  // Same account id at 401 time, newer selection revision: the refresh must still run, or the
  // rejected key is replayed and the one allowed recovery is spent on it.
  holdDeadSend = async () => {
    holdDeadSend = undefined;
    await setActiveAccount("devin", account("spare")!.id);
    await setActiveAccount("devin", revoked);
  };

  const body = await (await run()).json() as { error: { message: string } };

  expect(sentKeys.filter(key => key === DEAD)).toHaveLength(1);
  expect(account("revoked")?.needsReauth).toBe(true);
  // The operator's newer manual selection names the revoked account, so no automatic move
  // overrides it; the client is told to log in rather than shown the raw upstream 401.
  expect(body.error.message).toBe("Not logged in to devin. Run: ocx login devin");
});
