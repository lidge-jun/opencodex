/** Antigravity ACP use policy, the request-peer scope and the pipeline preflight (plan 080). */
import { describe, expect, test } from "bun:test";
import { agyAcpPolicyRefusal } from "../../src/adapters/agy-acp/policy";
import { classifyRequestPeer, currentRequestIsLocal, runWithRequestPeer } from "../../src/lib/request-peer-scope";
import { agyAcpPreflightResponse } from "../../src/server/responses/agy-acp-preflight";
import type { RequestLogContext } from "../../src/server/request-log";

describe("request peer scope", () => {
  test("local only for a loopback peer on a local listener", () => {
    expect(classifyRequestPeer("public", "127.0.0.1").local).toBe(true);
    expect(classifyRequestPeer("unauthenticated-loopback", "::1").local).toBe(true);
    expect(classifyRequestPeer("claude-intercept", "::ffff:127.0.0.1").local).toBe(true);
    expect(classifyRequestPeer("public", "192.168.1.20").local).toBe(false);
    expect(classifyRequestPeer("hub-link", "127.0.0.1").local).toBe(false);
    expect(classifyRequestPeer("hub-management", "127.0.0.1").local).toBe(false);
    expect(classifyRequestPeer("local-control", undefined).local).toBe(false);
    // A server that cannot report the peer (no requestIP) is never local, on a local listener too.
    expect(classifyRequestPeer("public", undefined).local).toBe(false);
    expect(classifyRequestPeer("unauthenticated-loopback", null).local).toBe(false);
  });

  test("a loopback peer relaying forwarding headers is a same-machine reverse proxy, not local", () => {
    for (const name of ["Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Real-IP", "Tailscale-User-Login", "CF-Connecting-IP", "True-Client-IP", "Via"]) {
      expect(classifyRequestPeer("public", "127.0.0.1", undefined, new Headers({ [name]: "203.0.113.9" })).local).toBe(false);
    }
    expect(classifyRequestPeer("public", "127.0.0.1", undefined, new Headers({ "user-agent": "codex_cli_rs" })).local).toBe(true);
  });

  test("a loopback peer the operator declared as a reverse proxy is not local", () => {
    const proxied = { origin: "https://dash.example.test", proxyAddresses: ["127.0.0.1"] };
    expect(classifyRequestPeer("public", "127.0.0.1", proxied).local).toBe(false);
    expect(classifyRequestPeer("public", "::ffff:127.0.0.1", proxied).local).toBe(false);
    expect(classifyRequestPeer("unauthenticated-loopback", "127.0.0.1", proxied).local).toBe(true);
    expect(classifyRequestPeer("claude-intercept", "127.0.0.1", proxied).local).toBe(true);
    // Another loopback peer that is not the declared proxy stays local; a malformed setting declares nothing.
    expect(classifyRequestPeer("public", "::1", proxied).local).toBe(true);
    expect(classifyRequestPeer("public", "127.0.0.1", { proxyAddresses: "127.0.0.1" }).local).toBe(true);
  });

  test("the snapshot is fixed per run, survives awaits and timers, and absence is not local", async () => {
    expect(currentRequestIsLocal()).toBe(false);
    const seen: boolean[] = [];
    await Promise.all([
      runWithRequestPeer({ local: true }, async () => { await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); seen.push(currentRequestIsLocal()); }),
      runWithRequestPeer({ local: false }, async () => { await Promise.resolve(); seen.push(currentRequestIsLocal()); }),
      runWithRequestPeer({ local: true }, () => runWithRequestPeer(undefined, async () => { seen.push(currentRequestIsLocal()); })),
    ]);
    expect(seen.sort()).toEqual([false, false, true]);
  });
});

describe("use policy", () => {
  test("only the certain signals refuse; a local interactive turn passes", () => {
    expect(agyAcpPolicyRefusal({ headers: new Headers(), local: true })).toBeUndefined();
    expect(agyAcpPolicyRefusal({ headers: new Headers({ "x-codex-parent-thread-id": "t" }), local: true })?.code).toBe("agy_acp_interactive_only");
    expect(agyAcpPolicyRefusal({ headers: new Headers(), comboAttempt: true, local: true })?.code).toBe("agy_acp_interactive_only");
    expect(agyAcpPolicyRefusal({ headers: new Headers(), internalDecisionCall: true, local: true })?.code).toBe("agy_acp_interactive_only");
    expect(agyAcpPolicyRefusal({ headers: new Headers(), subagentFallback: true, local: true })?.code).toBe("agy_acp_interactive_only");
    expect(agyAcpPolicyRefusal({ headers: new Headers(), local: false })?.code).toBe("agy_acp_local_only");
    // Without an explicit value the request scope decides, and no scope is not local.
    expect(agyAcpPolicyRefusal({ headers: new Headers() })?.code).toBe("agy_acp_local_only");
    // Other headers (a thread id, a user agent) are not signals.
    expect(agyAcpPolicyRefusal({ headers: new Headers({ "thread-id": "x", "user-agent": "codex_exec" }), local: true })).toBeUndefined();
  });

  test("unattended Codex turns without a parent-thread header are refused: memory and spawned threads", () => {
    const refused = (headers: Record<string, string>, body?: unknown) => agyAcpPolicyRefusal({ headers: new Headers(headers), body, local: true })?.code;
    expect(refused({ "x-openai-subagent": "memory_consolidation" })).toBe("agy_acp_interactive_only");
    expect(refused({ "x-openai-memgen-request": "true" })).toBe("agy_acp_interactive_only");
    expect(refused({ "x-codex-turn-metadata": JSON.stringify({ request_kind: "memory" }) })).toBe("agy_acp_interactive_only");
    expect(refused({ "x-codex-turn-metadata": JSON.stringify({ thread_source: "memory_consolidation" }) })).toBe("agy_acp_interactive_only");
    expect(refused({ "x-openai-subagent": "collab_spawn" })).toBe("agy_acp_interactive_only");
    expect(refused({ "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "thread_spawn" }) })).toBe("agy_acp_interactive_only");
    // The WebSocket frame's own copy of the turn metadata travels in the body.
    expect(refused({}, { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_source: "memory_consolidation" }) } })).toBe("agy_acp_interactive_only");
    // An ordinary interactive turn, with ordinary turn metadata, still runs.
    expect(refused({ "x-codex-turn-metadata": JSON.stringify({ thread_source: "user" }) })).toBeUndefined();
  });

  test("the pipeline preflight answers a structured 403 only for the ACP adapter", async () => {
    const logCtx = {} as RequestLogContext;
    const base = { requestHeaders: new Headers(), forwardHeaders: new Headers(), body: {}, comboAttempt: false, internalDecisionCall: false, subagentFallback: false, logCtx };
    expect(agyAcpPreflightResponse({ ...base, adapterName: "google", comboAttempt: true })).toBeUndefined();
    const refused = runWithRequestPeer({ local: true }, () => agyAcpPreflightResponse({ ...base, adapterName: "agy-acp", requestHeaders: new Headers({ "x-codex-parent-thread-id": "p" }) }))!;
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { type: "permission_error", code: "agy_acp_interactive_only" } });
    expect(runWithRequestPeer({ local: true }, () => agyAcpPreflightResponse({ ...base, adapterName: "agy-acp" }))).toBeUndefined();
    expect(runWithRequestPeer({ local: true }, () => agyAcpPreflightResponse({ ...base, adapterName: "agy-acp", subagentFallback: true }))?.status).toBe(403);
    expect(runWithRequestPeer({ local: true }, () => agyAcpPreflightResponse({ ...base, adapterName: "agy-acp", internalDecisionCall: true }))?.status).toBe(403);
  });

  test("a WebSocket frame's own spawned-thread label is refused without a header copy", () => {
    expect(agyAcpPolicyRefusal({
      headers: new Headers(), inboundTransport: "websocket", local: true,
      body: { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "thread_spawn" }) } },
    })?.code).toBe("agy_acp_interactive_only");
  });

  test("an HTTP memory header is authoritative for refusal even when the body copy is malformed", () => {
    const headers = new Headers({ "x-codex-turn-metadata": JSON.stringify({ request_kind: "memory" }) });
    const body = { client_metadata: null };
    expect(agyAcpPolicyRefusal({ headers, body, local: true })?.code).toBe("agy_acp_interactive_only");
  });

  test("a WebSocket handshake memory label does not classify an ordinary frame", () => {
    const headers = new Headers({ "x-codex-turn-metadata": JSON.stringify({ request_kind: "memory" }) });
    expect(agyAcpPolicyRefusal({ headers, body: {}, inboundTransport: "websocket", local: true })).toBeUndefined();
    headers.set("x-openai-subagent", "memory_consolidation");
    expect(agyAcpPolicyRefusal({ headers, body: {}, inboundTransport: "websocket", local: true })).toBeUndefined();
  });

  test("HTTP preflight refuses a memory header with malformed body metadata", async () => {
    const refused = runWithRequestPeer({ local: true }, () => agyAcpPreflightResponse({
      adapterName: "agy-acp",
      requestHeaders: new Headers({ "x-codex-turn-metadata": JSON.stringify({ thread_source: "memory_consolidation" }) }),
      forwardHeaders: new Headers(),
      body: { client_metadata: null },
      comboAttempt: false,
      internalDecisionCall: false,
      subagentFallback: false,
      logCtx: {} as RequestLogContext,
    }));
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toMatchObject({ error: { code: "agy_acp_interactive_only" } });
  });
});
