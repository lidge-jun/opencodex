import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import { CodexReserveHelperUnsupportedError, CodexReserveUnavailableError, createCodexReserveDispatchGuard } from "../../src/codex/auth-context";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearCodexUpstreamHealthForAccount } from "../../src/codex/routing";
import { clearMainAccountInfoCache, observeMainQuotaCredential, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { getMainReserveAuthorization, isMainReserveAuthorizationLive } from "../../src/codex/reserve-availability";
import type { OcxProviderConfig } from "../../src/types";

const URL = "https://chatgpt.com/backend-api/codex/responses";
const realWebSocket = globalThis.WebSocket;

class DelayedWebSocket extends EventTarget {
  static instances: DelayedWebSocket[] = [];
  static constructed?: (socket: DelayedWebSocket) => void;
  readonly sent: string[] = [];
  readonly listeners = new Set<EventListenerOrEventListenerObject>();
  closed = false;
  constructor(readonly url: string, readonly options: { headers: Record<string, string> }) {
    super();
    DelayedWebSocket.instances.push(this);
    DelayedWebSocket.constructed?.(this);
  }
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    if (listener) this.listeners.add(listener);
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    if (listener) this.listeners.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  send(frame: string): void { this.sent.push(frame); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
}

function install(): void {
  globalThis.WebSocket = DelayedWebSocket as unknown as typeof WebSocket;
}

function init(signal?: AbortSignal): RequestInit {
  return {
    method: "POST", signal,
    headers: { authorization: "Bearer fixture-reserve", "chatgpt-account-id": "fixture-workspace" },
    body: JSON.stringify({ model: "gpt-reserve", input: "ping", stream: true }),
  };
}

afterEach(() => {
  for (const socket of DelayedWebSocket.instances) socket.close();
  DelayedWebSocket.instances = [];
  DelayedWebSocket.constructed = undefined;
  globalThis.WebSocket = realWebSocket;
});

describe("synchronous Reserve dispatch callbacks on WebSocket", () => {
  test.each([true, false])("valid-proof terminal helper with enabled-at-open=%s cannot confuse helper permission with conversation permission", async enabledAtOpen => {
    install();
    clearAccountNeedsReauth("__main__");
    clearCodexUpstreamHealthForAccount("__main__");
    clearMainAccountInfoCache();
    const token = { accessToken: "fixture-reserve", chatgptAccountId: "fixture-workspace" };
    observeMainQuotaIdentity(token.chatgptAccountId);
    const writer = observeMainQuotaCredential(token.accessToken, token.chatgptAccountId);
    let whamReads = 0;
    let observations = 0;
    let fallbacks = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (
      input: Parameters<typeof fetch>[0], options?: RequestInit,
    ) => {
      const request = new Request(input, options);
      expect(request.url).toBe("https://chatgpt.com/backend-api/wham/usage");
      expect(request.headers.get("authorization")).toBe("Bearer fixture-reserve");
      expect(request.headers.get("chatgpt-account-id")).toBe("fixture-workspace");
      expect(request.headers.get("x-openai-codex-luna-reserve")).toBe("1");
      whamReads++;
      return Response.json({ account_id: token.chatgptAccountId, rate_limit: { allowed: false },
        rate_limit_upsell: { banner_type: "luna_reserve" },
        additional_rate_limits: [{ limit_name: "gpt-reserve", rate_limit: { allowed: true } }],
      });
    }, { preconnect() {} }));
    try {
      const proof = await getMainReserveAuthorization({ token, writer, observeOrdinaryQuota() { observations++; } });
      expect(isMainReserveAuthorizationLive(proof, token)).toBe(true);
      if (!proof) throw new Error("Expected genuine positive conversation proof");
      const config = { codexDesktopAuthless: false };
      const ctx = { kind: "main" as const, accountId: null, reserveAuthorization: proof };
      const guard = createCodexReserveDispatchGuard(ctx, config, "gpt-reserve", { source: "loopback" }, true);
      expect(guard).toBeDefined();
      const fallback = Object.assign(async () => { fallbacks++; return new Response("unexpected fallback"); }, { preconnect() {} });
      const pending = codexWsUpstreamFetch(URL, init(), fallback, "1.4.0", undefined, guard);
      const observed = pending.then(
        response => ({ status: "fulfilled" as const, response }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      expect(DelayedWebSocket.instances).toHaveLength(1); // Off at handshake, so the late guard must be exercised.
      const socket = DelayedWebSocket.instances[0]!;
      config.codexDesktopAuthless = enabledAtOpen;
      socket.dispatchEvent(new Event("open"));
      if (!enabledAtOpen) socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "response.created", response: { id: "fixture-response" } }),
      }));
      const outcome = await observed;
      if (enabledAtOpen) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") throw new Error("Expected terminal helper refusal");
        expect(outcome.error).toBeInstanceOf(CodexReserveHelperUnsupportedError);
        expect(socket.sent).toEqual([]);
        expect(socket.closed).toBe(true);
        expect(socket.listeners.size).toBe(0);
      } else {
        if (outcome.status !== "fulfilled") throw outcome.error;
        expect(outcome.response.status).toBe(200);
        expect(socket.sent).toHaveLength(1);
        expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "response.create", model: "gpt-reserve" });
        await outcome.response.body?.cancel();
      }
      expect(isMainReserveAuthorizationLive(proof, token)).toBe(true);
      expect(whamReads).toBe(1);
      expect(observations).toBe(1);
      expect(fallbacks).toBe(0);
    } finally { fetchSpy.mockRestore(); clearMainAccountInfoCache(); }
  });

  test("off-to-on during delayed WS open refuses the unproved create frame without fallback", async () => {
    install();
    clearAccountNeedsReauth("__main__");
    clearCodexUpstreamHealthForAccount("__main__");
    const config = { codexDesktopAuthless: false };
    const guard = createCodexReserveDispatchGuard({ kind: "main", accountId: null }, config, "gpt-reserve", { source: "loopback" });
    expect(guard).toBeDefined();
    let fallbacks = 0;
    const fallback = Object.assign(async () => { fallbacks += 1; return new Response("unexpected"); }, { preconnect() {} });
    const pending = codexWsUpstreamFetch(URL, init(), fallback, "1.4.0", undefined, guard);
    const observed = pending.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const socket = DelayedWebSocket.instances[0]!;
    config.codexDesktopAuthless = true;
    socket.dispatchEvent(new Event("open"));
    const outcome = await observed;
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("Expected dispatch refusal");
    expect(outcome.error).toBeInstanceOf(CodexReserveUnavailableError);
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBe(true);
    expect(socket.listeners.size).toBe(0);
    expect(fallbacks).toBe(0);
  });

  test("a still-disabled delayed WS open retains ordinary create behavior with an installed guard", async () => {
    install();
    const config = { codexDesktopAuthless: false };
    const guard = createCodexReserveDispatchGuard({ kind: "main", accountId: null }, config, "gpt-reserve", { source: "loopback" });
    expect(guard).toBeDefined();
    let fallbacks = 0;
    const fallback = Object.assign(async () => { fallbacks += 1; return new Response("unexpected"); }, { preconnect() {} });
    const pending = codexWsUpstreamFetch(URL, init(), fallback, "1.4.0", undefined, guard);
    const socket = DelayedWebSocket.instances[0]!;
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "response.created", response: { id: "fixture-response" } }),
    }));
    const response = await pending;
    expect(response.status).toBe(200);
    expect(socket.sent).toHaveLength(1);
    expect(fallbacks).toBe(0);
    await response.body?.cancel();
  });

  test("handshake refusal rejects the original error without dialing or HTTP fallback", async () => {
    install();
    const refusal = new Error("local permission refused");
    let fallbacks = 0;
    const fallback = Object.assign(async () => { fallbacks += 1; return new Response("unexpected"); }, { preconnect() {} });
    await expect(codexWsUpstreamFetch(URL, init(), fallback, "1.4.0", undefined, () => { throw refusal; }))
      .rejects.toBe(refusal);
    expect(DelayedWebSocket.instances).toHaveLength(0);
    expect(fallbacks).toBe(0);
  });

  test("delayed-open refusal closes and detaches before synchronous close, with no create or fallback", async () => {
    install();
    const refusal = new Error("proof revoked during upgrade");
    const abort = new AbortController();
    const removeAbort = spyOn(abort.signal, "removeEventListener");
    let checks = 0;
    let fallbacks = 0;
    const fallback = Object.assign(async () => { fallbacks += 1; return new Response("unexpected"); }, { preconnect() {} });
    const pending = codexWsUpstreamFetch(URL, init(abort.signal), fallback, "1.4.0", undefined, headers => {
      expect(headers.get("authorization")).toBe("Bearer fixture-reserve");
      expect(headers.get("chatgpt-account-id")).toBe("fixture-workspace");
      if (++checks === 2) throw refusal;
    });
    const observed = pending.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const socket = DelayedWebSocket.instances[0]!;
    socket.dispatchEvent(new Event("open"));
    const outcome = await observed;
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("Expected dispatch refusal");
    expect(outcome.error).toBe(refusal);
    expect(checks).toBe(2);
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBe(true);
    expect(socket.listeners.size).toBe(0);
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    abort.abort();
    socket.dispatchEvent(new Event("open"));
    expect(fallbacks).toBe(0);
    removeAbort.mockRestore();
  });

  test("allowed dispatch preserves the handshake guard and separate live quota observer", async () => {
    install();
    const seen: string[] = [];
    const quotaValues: string[] = [];
    let fallbacks = 0;
    const fallback = Object.assign(async () => { fallbacks += 1; return new Response("unexpected"); }, { preconnect() {} });
    const pending = codexWsUpstreamFetch(URL, init(), fallback, "1.4.0", headers => {
      quotaValues.push(headers.get("x-codex-primary-used-percent")!);
    }, headers => {
      seen.push(headers.get("authorization")!);
    });
    const socket = DelayedWebSocket.instances[0]!;
    socket.dispatchEvent(new Event("open"));
    expect(quotaValues).toEqual([]);
    expect(seen).toEqual(["Bearer fixture-reserve", "Bearer fixture-reserve"]);
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 37 } } }),
    }));
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "response.created", response: { id: "fixture-response" } }),
    }));
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-codex-primary-used-percent")).toBe("37");
    expect(quotaValues).toEqual(["37"]);
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 49 } } }),
    }));
    expect(quotaValues).toEqual(["37", "49"]);
    expect(response.headers.get("x-codex-primary-used-percent")).toBe("37");
    expect(seen).toEqual(["Bearer fixture-reserve", "Bearer fixture-reserve"]);
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "response.create", model: "gpt-reserve" });
    expect(fallbacks).toBe(0);
    await response.body?.cancel();
  });

  test("an upgrade failure's HTTP fallback still runs the dispatch guard", async () => {
    install();
    const refusal = new Error("permission expired before fallback");
    let permitted = true;
    let httpSends = 0;
    let constructed!: (socket: DelayedWebSocket) => void;
    const created = new Promise<DelayedWebSocket>(resolve => { constructed = resolve; });
    DelayedWebSocket.constructed = constructed;
    const provider: OcxProviderConfig & { fetch: typeof fetch } = {
      adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex",
      fetch: Object.assign(async () => { httpSends += 1; return new Response("unexpected"); }, { preconnect() {} }),
    };
    const executor = providerFetch(provider, "1.4.0", { beforeDispatch: () => { if (!permitted) throw refusal; } });
    const pending = executor(URL, init());
    const observed = pending.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const socket = await created;
    permitted = false;
    socket.close();
    const outcome = await observed;
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("Expected dispatch refusal");
    expect(outcome.error).toBe(refusal);
    expect(socket.sent).toEqual([]);
    expect(httpSends).toBe(0);
  });
});
