import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  clearMainAccountInfoCache, observeMainQuotaCredential, observeMainQuotaIdentity,
} from "../../src/codex/main-account-cache";
import {
  getMainReserveAuthorization, isMainReserveAuthorizationLive, observeMainReserveRevocation,
} from "../../src/codex/reserve-availability";
import type { WhamUsageResponse } from "../../src/codex/quota-types";

let originalFetch: typeof fetch;
let serial = 0;
function owned(user = "fixture-user-a", account = "fixture-reserve-main") {
  const accessToken = `fixture.${Buffer.from(JSON.stringify({ nonce: ++serial,
    "https://api.openai.com/auth": { chatgpt_user_id: user, chatgpt_account_id: account },
  })).toString("base64url")}.signature`;
  observeMainQuotaIdentity(account);
  const writer = observeMainQuotaCredential(accessToken, account);
  if (!writer) throw new Error("Expected fixture-owned writer");
  return { token: { accessToken, chatgptAccountId: account }, writer };
}
function grant(): WhamUsageResponse {
  return {
    rate_limit: { allowed: false, primary_window: { used_percent: 100, limit_window_seconds: 18_000 } },
    rate_limit_upsell: { banner_type: "luna_reserve" },
    additional_rate_limits: [{ limit_name: "gpt-reserve", rate_limit: { allowed: true } }],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function serve(handler: (init?: RequestInit) => Promise<Response>) {
  let calls = 0;
  globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(String(url)).toBe("https://chatgpt.com/backend-api/wham/usage");
    calls++;
    return handler(init);
  }, { preconnect: originalFetch.preconnect });
  return () => calls;
}
beforeEach(() => { originalFetch = globalThis.fetch; clearMainAccountInfoCache(); });
afterEach(() => { globalThis.fetch = originalFetch; clearMainAccountInfoCache(); });

describe("owned main Reserve capability", () => {
  test("requests capability with exact owned credentials and keeps proof private/credential-bound", async () => {
    const input = owned();
    const data = grant();
    let observed = 0;
    const calls = serve(async init => {
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(headers.get("authorization")).toBe(`Bearer ${input.token.accessToken}`);
      expect(headers.get("chatgpt-account-id")).toBe(input.token.chatgptAccountId);
      expect(headers.get("x-openai-codex-luna-reserve")).toBe("1");
      return Response.json(data);
    });
    const observeOrdinaryQuota = (usage: WhamUsageResponse, writer: typeof input.writer) => {
      observed++; expect(usage).toEqual(data); expect(writer).toEqual(input.writer);
    };
    const authorization = await getMainReserveAuthorization({ ...input, observeOrdinaryQuota });
    expect(authorization).toBeDefined();
    expect(isMainReserveAuthorizationLive(authorization, input.token)).toBe(true);
    expect(isMainReserveAuthorizationLive({ ...authorization! }, input.token)).toBe(false);
    expect(Object.keys(authorization!).sort()).toEqual(["expiresAt", "observedAt", "writer"]);
    expect(JSON.stringify(authorization)).not.toContain(input.token.accessToken);
    expect(JSON.stringify(authorization)).not.toContain("fixture-user");
    expect(authorization!.expiresAt - authorization!.observedAt).toBe(60_000);
    observeMainQuotaCredential(input.token.accessToken, input.token.chatgptAccountId);
    expect(await getMainReserveAuthorization({ ...input, observeOrdinaryQuota })).toBe(authorization);
    expect(calls()).toBe(1); expect(observed).toBe(1);
    expect(isMainReserveAuthorizationLive(authorization, input.token, authorization!.expiresAt)).toBe(false);
    expect(isMainReserveAuthorizationLive(authorization, input.token, authorization!.observedAt - 1)).toBe(false);
  });

  test.each(["unowned", "wrong bearer", "wrong account", "aborted"])("%s makes no metadata read", async kind => {
    const input = owned();
    const controller = new AbortController();
    if (kind === "aborted") controller.abort();
    const calls = serve(async () => Response.json(grant()));
    const token = { ...input.token };
    if (kind === "wrong bearer") token.accessToken = "fixture-unmatched";
    if (kind === "wrong account") token.chatgptAccountId = "fixture-other";
    const result = await getMainReserveAuthorization({ token, writer: kind === "unowned" ? undefined : input.writer,
      signal: controller.signal, observeOrdinaryQuota: () => { throw new Error("must not observe"); } });
    expect(result).toBeUndefined(); expect(calls()).toBe(0);
  });

  test.each(["missing normal", "ordinary allowed", "string allowed", "missing banner", "missing reserve",
    "reserve denied", "duplicate", "bad additional", "wrong account", "wrong user"])("%s is not permission", async kind => {
    const input = owned();
    const data = grant();
    if (kind === "missing normal") delete data.rate_limit;
    if (kind === "ordinary allowed") data.rate_limit!.allowed = true;
    if (kind === "string allowed") data.additional_rate_limits![0]!.rate_limit!.allowed = "true";
    if (kind === "missing banner") delete data.rate_limit_upsell;
    if (kind === "missing reserve") delete data.additional_rate_limits;
    if (kind === "reserve denied") data.additional_rate_limits![0]!.rate_limit!.allowed = false;
    if (kind === "duplicate") data.additional_rate_limits!.push({ ...data.additional_rate_limits![0] });
    if (kind === "bad additional") Reflect.set(data, "additional_rate_limits", "not an array");
    if (kind === "wrong account") data.account_id = "fixture-other";
    if (kind === "wrong user") data.user_id = "fixture-user-b";
    let observed = 0;
    serve(async () => Response.json(data));
    expect(await getMainReserveAuthorization({ ...input, observeOrdinaryQuota: () => { observed++; } })).toBeUndefined();
    if (["wrong account", "wrong user", "bad additional"].includes(kind)) expect(observed).toBe(0);
  });

  test("matching optional identity echoes are accepted, including user_id token claim fallback", async () => {
    const input = owned();
    input.token.accessToken = `fixture.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { user_id: "fixture-user-a" },
    })).toString("base64url")}.signature`;
    observeMainQuotaCredential(input.token.accessToken, input.token.chatgptAccountId);
    serve(async () => Response.json({ ...grant(), account_id: input.token.chatgptAccountId, user_id: "fixture-user-a" }));
    expect(await getMainReserveAuthorization({ ...input, observeOrdinaryQuota: () => {} })).toBeDefined();
  });

  test("concurrent callers share one bounded read; one caller abort does not cancel another", async () => {
    const input = owned();
    const response = deferred<Response>();
    let observed = 0;
    const calls = serve(async () => response.promise);
    const controller = new AbortController();
    const common = { ...input, observeOrdinaryQuota: () => { observed++; } };
    const first = getMainReserveAuthorization({ ...common, signal: controller.signal });
    const second = getMainReserveAuthorization(common);
    controller.abort();
    expect(await first).toBeUndefined();
    response.resolve(Response.json(grant()));
    expect(await second).toBeDefined();
    expect(calls()).toBe(1); expect(observed).toBe(1);
  });

  test("new token/user in the same workspace cannot reuse or publish the previous flight", async () => {
    const firstInput = owned();
    const response = deferred<Response>();
    let oldObserved = 0;
    const calls = serve(async () => calls() === 1 ? response.promise : Response.json(grant()));
    const first = getMainReserveAuthorization({ ...firstInput, observeOrdinaryQuota: () => { oldObserved++; } });
    const nextInput = owned("fixture-user-b");
    expect(nextInput.writer).toEqual(firstInput.writer);
    const next = await getMainReserveAuthorization({ ...nextInput, observeOrdinaryQuota: () => {} });
    expect(next).toBeDefined();
    expect(await first).toBeUndefined();
    response.resolve(Response.json(grant()));
    await Promise.resolve(); await Promise.resolve();
    expect(oldObserved).toBe(0);
    expect(isMainReserveAuthorizationLive(next, firstInput.token)).toBe(false);
    expect(isMainReserveAuthorizationLive(next, nextInput.token)).toBe(true);
    expect(calls()).toBe(2);
  });

  test.each(["pending", "cached"])("%s A proof cannot resurrect after A→B→A without a B request", async phase => {
    const input = owned();
    const response = deferred<Response>();
    let observed = 0;
    const calls = serve(async () => phase === "pending" && calls() === 1 ? response.promise : Response.json(grant()));
    const args = { ...input, observeOrdinaryQuota: () => { observed++; } };
    const pending = getMainReserveAuthorization(args);
    const cached = phase === "cached" ? await pending : undefined;
    owned("fixture-user-b");
    observeMainQuotaCredential(input.token.accessToken, input.token.chatgptAccountId);
    expect(isMainReserveAuthorizationLive(cached, input.token)).toBe(false);
    response.resolve(Response.json(grant()));
    if (phase === "pending") { expect(await pending).toBeUndefined(); expect(observed).toBe(0); }
    expect(await getMainReserveAuthorization(args)).toBeDefined();
    expect(calls()).toBe(2);
  });

  test("refresh token replacement cannot reuse an old spread proof or cache", async () => {
    const first = owned();
    const calls = serve(async () => Response.json(grant()));
    const old = await getMainReserveAuthorization({ ...first, observeOrdinaryQuota: () => {} });
    const refreshed = owned();
    expect(isMainReserveAuthorizationLive(old, refreshed.token)).toBe(false);
    expect(isMainReserveAuthorizationLive({ ...old! }, refreshed.token)).toBe(false);
    expect(await getMainReserveAuthorization({ ...refreshed, observeOrdinaryQuota: () => {} })).toBeDefined();
    expect(calls()).toBe(2);
  });

  test.each(["ordinary", "reserve"])("new passive %s refusal/recovery revokes without granting", async kind => {
    const input = owned();
    serve(async () => Response.json(grant()));
    const authorization = await getMainReserveAuthorization({ ...input, observeOrdinaryQuota: () => {} });
    observeMainReserveRevocation({ plan_type: "plus" }, input.writer);
    expect(isMainReserveAuthorizationLive(authorization, input.token)).toBe(true);
    observeMainReserveRevocation(kind === "ordinary" ? { rate_limit: { allowed: true } }
      : { additional_rate_limits: [{ limit_name: "gpt-reserve", rate_limit: { allowed: false } }] }, input.writer);
    expect(isMainReserveAuthorizationLive(authorization, input.token)).toBe(false);
    observeMainReserveRevocation(grant(), input.writer);
    expect(isMainReserveAuthorizationLive(authorization, input.token)).toBe(false);
  });

  test("revocation and identity replacement fence a pending response before ordinary publication", async () => {
    for (const change of ["revoke", "identity"] as const) {
      const input = owned();
      const response = deferred<Response>();
      let observed = 0;
      serve(async () => response.promise);
      const pending = getMainReserveAuthorization({ ...input, observeOrdinaryQuota: () => { observed++; } });
      if (change === "revoke") observeMainReserveRevocation({ rate_limit: { allowed: true } }, input.writer);
      else observeMainQuotaIdentity("fixture-replacement");
      response.resolve(Response.json(grant()));
      expect(await pending).toBeUndefined(); expect(observed).toBe(0);
    }
  });

  test.each(["status", "network", "json", "oversized", "utf8"])("%s response fails closed", async kind => {
    const input = owned();
    let observed = 0;
    serve(async () => {
      if (kind === "network") throw new Error("fixture transport failure");
      if (kind === "status") return new Response(null, { status: 401 });
      if (kind === "json") return new Response("not json");
      if (kind === "utf8") return new Response(new Uint8Array([0xff]));
      return Response.json({ ...grant(), ignored: "x".repeat(65_536) });
    });
    expect(await getMainReserveAuthorization({ ...input, observeOrdinaryQuota: () => { observed++; } })).toBeUndefined();
    expect(observed).toBe(0);
  });

  test("whole-read deadline fences even an uncooperative fetch and its late body", async () => {
    const input = owned();
    const response = deferred<Response>();
    let observed = 0;
    const realTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const [callback, ms, ...rest] = args;
      return realTimeout(callback, ms === 8_000 ? 5 : ms, ...rest);
    }) as typeof setTimeout);
    serve(async () => response.promise);
    try {
      expect(await getMainReserveAuthorization({ ...input, observeOrdinaryQuota: () => { observed++; } })).toBeUndefined();
      response.resolve(Response.json(grant()));
      await Promise.resolve(); await Promise.resolve();
      expect(observed).toBe(0);
    } finally { timer.mockRestore(); response.resolve(Response.json(grant())); }
  });
});
