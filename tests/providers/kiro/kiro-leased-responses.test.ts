import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../../src/server/responses";
import { finalizeAccountLease } from "../../../src/server/responses/core-lifetime";
import { acquireAccountLease, accountInFlight } from "../../../src/oauth/kiro-account-load";
import { captureOAuthAccountSelection, getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import { clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import type { OcxConfig } from "../../../src/types";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const realFetch = globalThis.fetch;
const oldHome = process.env.OPENCODEX_HOME;
let home = "";
let isolated: IsolatedCodexHome;
let releaseSpend: () => void;
const held: Array<{ release(): void }> = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-load-response-"));
  isolated = installIsolatedCodexHome("ocx-kiro-load-codex-");
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth();
  releaseSpend = acquireOwnedSpendHome();
});
afterEach(() => {
  held.splice(0).forEach(lease => lease.release());
  globalThis.fetch = realFetch;
  releaseSpend();
  clearGenericFailoverHealth();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  isolated.restore();
  removeTreeWithRetry(home);
});

function config(): OcxConfig {
  return { port: 0, defaultProvider: "kiro", providers: { kiro: {
    adapter: "kiro", authMode: "oauth", baseUrl: "https://runtime.us-east-1.kiro.dev",
    models: ["claude-sonnet-4.5"], oauthAccountFailover: { maxConcurrentPerAccount: 1 },
  } } } as OcxConfig;
}
async function seed(count = 1) {
  for (let i = 0; i < count; i++) await saveCredential("kiro", {
    access: `load-access-${i}`, refresh: `load-refresh-${i}`, expires: Date.now() + 3_600_000,
    accountId: `load-account-${i}`, source: "oauth", kiro: { profileArn: `arn:aws:codewhisperer:us-east-1:123456789012:profile/${i}`,
      apiRegion: "us-east-1" },
  }, { addAccount: true });
  const ids = getAccountSet("kiro")!.accounts.map(row => row.id);
  await setActiveAccount("kiro", ids[0]!);
  return ids;
}
function request(signal?: AbortSignal) {
  return new Request("http://localhost/v1/responses", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "kiro/claude-sonnet-4.5", input: "hello", stream: false }), signal });
}
function answer() {
  return new Response(encodeMessage({ ":message-type": "event", ":event-type": "assistantResponseEvent" },
    new TextEncoder().encode(JSON.stringify({ content: "done" }))),
  { headers: { "content-type": "application/vnd.amazon.eventstream" } });
}

test("a full selected account waits then returns 503 account_capacity without a store write", async () => {
  const [id] = await seed();
  held.push((await acquireAccountLease("kiro", id!))!);
  const authFile = join(home, "auth.json");
  const authBefore = readFileSync(authFile);
  const mtimeBefore = statSync(authFile).mtimeMs;
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return answer(); }) as typeof fetch;
  const response = await handleResponses(request(), config(), { model: "claude-sonnet-4.5", provider: "kiro" });
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("1");
  expect((await response.json() as { error: { code: string } }).error.code).toBe("account_capacity");
  expect(sends).toBe(0);
  expect(accountInFlight("kiro", id!)).toBe(1);
  expect(readFileSync(authFile).equals(authBefore)).toBe(true);
  expect(statSync(authFile).mtimeMs).toBe(mtimeBefore);
});

test("Kiro stream completion releases the serving lease", async () => {
  const [id] = await seed();
  globalThis.fetch = (async () => answer()) as typeof fetch;
  const response = await handleResponses(request(), config(), { model: "claude-sonnet-4.5", provider: "kiro" });
  expect(response.status).toBe(200);
  expect(accountInFlight("kiro", id!)).toBe(1);
  await response.text();
  expect(accountInFlight("kiro", id!)).toBe(0);
});

test("an abandoned response body releases its lease when the request aborts", async () => {
  const [id] = await seed();
  const controller = new AbortController();
  globalThis.fetch = (async () => answer()) as typeof fetch;
  const response = await handleResponses(request(controller.signal), config(),
    { model: "claude-sonnet-4.5", provider: "kiro" }, { abortSignal: controller.signal });
  expect(response.status).toBe(200);
  expect(accountInFlight("kiro", id!)).toBe(1);
  controller.abort();
  expect(accountInFlight("kiro", id!)).toBe(0);
  await response.body?.cancel();
});

test("a reactive rotation onto a full account leaves the store selection and request state unchanged", async () => {
  const [a, b] = await seed(2);
  held.push((await acquireAccountLease("kiro", b!))!);
  const before = captureOAuthAccountSelection("kiro");
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    return Response.json({ reason: "MONTHLY_REQUEST_COUNT" }, { status: 400 });
  }) as typeof fetch;
  const response = await handleResponses(request(), config(), { model: "claude-sonnet-4.5", provider: "kiro" });
  expect(response.status).toBe(400);
  expect(sends).toBe(1);
  expect(captureOAuthAccountSelection("kiro")).toEqual(before);
  expect(accountInFlight("kiro", a!)).toBe(1);
  expect(accountInFlight("kiro", b!)).toBe(1);
  await response.text();
  expect(accountInFlight("kiro", a!)).toBe(0);
});

test("pre-output refusal failover transfers lease before retry", async () => {
  const [a, b] = await seed(2);
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    if (sends === 1) {
      expect(accountInFlight("kiro", a!)).toBe(1);
      return Response.json({ reason: "MONTHLY_REQUEST_COUNT" }, { status: 400 });
    }
    expect(accountInFlight("kiro", a!)).toBe(0);
    expect(accountInFlight("kiro", b!)).toBe(1);
    return answer();
  }) as typeof fetch;
  const response = await handleResponses(request(), config(), { model: "claude-sonnet-4.5", provider: "kiro" });
  expect(response.status).toBe(200);
  expect(sends).toBe(2);
  await response.text();
  expect(accountInFlight("kiro", b!)).toBe(0);
});

test("first refusal alternate full and second free uses the same reserved hop", async () => {
  const [a, b, c] = await seed(3);
  held.push((await acquireAccountLease("kiro", b!))!);
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    if (sends === 1) return Response.json({ reason: "MONTHLY_REQUEST_COUNT" }, { status: 400 });
    expect(accountInFlight("kiro", a!)).toBe(0);
    expect(accountInFlight("kiro", b!)).toBe(1);
    expect(accountInFlight("kiro", c!)).toBe(1);
    return answer();
  }) as typeof fetch;
  const response = await handleResponses(request(), config(), { model: "claude-sonnet-4.5", provider: "kiro" });
  expect(response.status).toBe(200);
  expect(sends).toBe(2);
  await response.text();
  expect(accountInFlight("kiro", c!)).toBe(0);
});

test("two full refusal alternates return the original status and body", async () => {
  const [a, b, c] = await seed(3);
  held.push((await acquireAccountLease("kiro", b!))!);
  held.push((await acquireAccountLease("kiro", c!))!);
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    return Response.json({ reason: "MONTHLY_REQUEST_COUNT" }, { status: 400 });
  }) as typeof fetch;
  const response = await handleResponses(request(), config(), { model: "claude-sonnet-4.5", provider: "kiro" });
  expect(response.status).toBe(400);
  expect(sends).toBe(1);
  expect((await response.text()).length).toBeGreaterThan(0);
  expect(accountInFlight("kiro", a!)).toBe(0);
  expect(accountInFlight("kiro", b!)).toBe(1);
  expect(accountInFlight("kiro", c!)).toBe(1);
});

test("Kiro cancellation and stream error release exactly once", async () => {
  const cancelled = await acquireAccountLease("kiro", "load-cancel");
  const open = new Response(new ReadableStream<Uint8Array>({ pull() {} }));
  const cancelResponse = finalizeAccountLease(open, () => cancelled!.release());
  expect(accountInFlight("kiro", "load-cancel")).toBe(1);
  await cancelResponse.body!.cancel();
  cancelled!.release();
  expect(accountInFlight("kiro", "load-cancel")).toBe(0);

  const errored = await acquireAccountLease("kiro", "load-error");
  const failed = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error("synthetic stream failure")); },
  }));
  const errorResponse = finalizeAccountLease(failed, () => errored!.release());
  await expect(errorResponse.body!.getReader().read()).rejects.toThrow("synthetic stream failure");
  errored!.release();
  expect(accountInFlight("kiro", "load-error")).toBe(0);
});

test("a post-401 alternate at its cap returns the original formatted 401", async () => {
  const [a, b] = await seed(2);
  held.push((await acquireAccountLease("kiro", b!))!);
  let sends = 0;
  let refreshes = 0;
  globalThis.fetch = (async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/refreshToken")) {
      refreshes++;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    sends++;
    return new Response("expired", { status: 401 });
  }) as typeof fetch;
  const response = await handleResponses(request(), config(), { model: "claude-sonnet-4.5", provider: "kiro" });
  expect(response.status).toBe(401);
  expect(sends).toBe(1);
  expect(refreshes).toBe(1);
  expect((await response.text()).length).toBeGreaterThan(0);
  expect(accountInFlight("kiro", a!)).toBe(0);
  expect(accountInFlight("kiro", b!)).toBe(1);
});

test("a 401 replay that resolves a different account never sends without that account's lease", async () => {
  const [a, b] = await seed(2);
  held.push((await acquireAccountLease("kiro", b!))!);
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    if (sends === 1) {
      expect(accountInFlight("kiro", a!)).toBe(1);
      await setActiveAccount("kiro", b!);
    }
    return new Response("expired", { status: 401 });
  }) as typeof fetch;
  const response = await handleResponses(request(), config(), { model: "claude-sonnet-4.5", provider: "kiro" });
  expect(response.status).toBe(401);
  expect(sends).toBe(1);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("invalid_api_key");
  expect(accountInFlight("kiro", b!)).toBe(1);
  expect(accountInFlight("kiro", a!)).toBe(0);
});

test("a selection race during rotation never sends on an account whose lease it does not hold", async () => {
  const [a, b, c] = await seed(3);
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    if (sends === 1) {
      await setActiveAccount("kiro", c!);
      return Response.json({ reason: "MONTHLY_REQUEST_COUNT" }, { status: 400 });
    }
    expect(accountInFlight("kiro", a!)).toBe(0);
    expect(accountInFlight("kiro", b!)).toBe(0);
    expect(accountInFlight("kiro", c!)).toBe(1);
    return answer();
  }) as typeof fetch;
  const response = await handleResponses(request(), config(), { model: "claude-sonnet-4.5", provider: "kiro" });
  expect(response.status).toBe(200);
  expect(sends).toBe(2);
  await response.text();
  expect(accountInFlight("kiro", c!)).toBe(0);
});

test("least-loaded selects the less busy Kiro account on the first physical send", async () => {
  const [a, b] = await seed(2);
  held.push((await acquireAccountLease("kiro", a!))!);
  const cfg = config();
  cfg.pool = { kernel: true };
  cfg.providers.kiro.oauthAccountFailover = { strategy: "least-loaded", enabled: true };
  const auth: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    auth.push(new Headers(init?.headers).get("authorization") ?? "");
    expect(accountInFlight("kiro", b!)).toBe(1);
    return answer();
  }) as typeof fetch;
  const response = await handleResponses(request(), cfg, { model: "claude-sonnet-4.5", provider: "kiro" });
  expect(response.status).toBe(200);
  expect(auth).toEqual(["Bearer load-access-1"]);
  await response.text();
  expect(accountInFlight("kiro", b!)).toBe(0);
});

test("least-loaded does not move a healthy request when proactive preference is off", async () => {
  const [a] = await seed(2);
  held.push((await acquireAccountLease("kiro", a!))!);
  const cfg = config();
  cfg.pool = { kernel: true };
  cfg.providers.kiro.oauthAccountFailover = { strategy: "least-loaded", enabled: false };
  const auth: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    auth.push(new Headers(init?.headers).get("authorization") ?? "");
    return answer();
  }) as typeof fetch;
  const response = await handleResponses(request(), cfg, { model: "claude-sonnet-4.5", provider: "kiro" });
  expect(response.status).toBe(200);
  expect(auth).toEqual(["Bearer load-access-0"]);
  await response.text();
});

test("explicit off full cap waits and returns account_capacity without moving", async () => {
  const [a, b] = await seed(2);
  held.push((await acquireAccountLease("kiro", a!))!);
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return answer(); }) as typeof fetch;
  for (const cfg of [
    { ...config(), oauthAccountFailover: { enabled: false } } as OcxConfig,
    { ...config(), providers: { kiro: { ...config().providers.kiro,
      oauthAccountFailover: { maxConcurrentPerAccount: 1, enabled: false } } } } as OcxConfig,
  ]) {
    const response = await handleResponses(request(), cfg, { model: "claude-sonnet-4.5", provider: "kiro" });
    expect(response.status).toBe(503);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("account_capacity");
  }
  expect(sends).toBe(0);
  expect(accountInFlight("kiro", a!)).toBe(1);
  expect(accountInFlight("kiro", b!)).toBe(0);
});

test("aborting initial capacity wait returns the client cancellation response", async () => {
  const [a] = await seed();
  held.push((await acquireAccountLease("kiro", a!))!);
  const controller = new AbortController();
  const pending = handleResponses(request(controller.signal), config(),
    { model: "claude-sonnet-4.5", provider: "kiro" }, { abortSignal: controller.signal });
  controller.abort();
  const response = await pending;
  expect(response.status).toBe(499);
  expect(accountInFlight("kiro", a!)).toBe(1);
});
