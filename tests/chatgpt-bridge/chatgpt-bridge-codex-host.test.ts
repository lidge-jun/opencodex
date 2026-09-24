import { describe, expect, test } from "bun:test";
import { BridgeCoreError } from "../../src/chatgpt-bridge/contracts";
import { CodexHostAdapter, DevSpaceMcpClient } from "../../src/chatgpt-bridge/hosts/codex/devspace-mcp-client";

/** Minimal fetch mock speaking the DevSpace MCP tool envelope. */
function mockClient(handler: (tool: string, args: Record<string, unknown>) => Record<string, unknown>, opts: { status?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, init: init ?? {} });
    if (url.endsWith("/healthz")) {
      return new Response(JSON.stringify({ ok: true, name: "devspace" }), { status: 200 });
    }
    const result = handler(body.params?.name ?? "", body.params?.arguments ?? {});
    const payload = { jsonrpc: "2.0", id: body.id, result };
    return new Response(JSON.stringify(payload), { status: opts.status ?? 200 });
  }) as typeof fetch;
  const client = new DevSpaceMcpClient({
    baseUrl: "http://127.0.0.1:17676/mcp",
    bearerToken: "test-token-not-a-real-secret",
    fetchImpl,
  });
  return { client, calls };
}

function toolResult(result: Record<string, unknown>) {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(result) }] };
}

function toolFailure(code: string, message: string) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, code, message }) }],
  };
}

describe("devspace mcp client", () => {
  test("healthz probes the loopback service", async () => {
    const { client, calls } = mockClient(() => ({}));
    expect(await client.healthz()).toEqual({ ok: true, name: "devspace" });
    expect(calls[0]?.url).toBe("http://127.0.0.1:17676/healthz");
    const healthHeaders = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(healthHeaders?.authorization).toBeUndefined();
  });

  test("known failure codes map 1:1 onto bridge error codes", async () => {
    const { client } = mockClient(() => toolFailure("TARGET_ACTIVE", "codex task busy"));
    const adapter = new CodexHostAdapter(client);
    try {
      await adapter.send("controller-1", "prompt");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeCoreError);
      expect((error as BridgeCoreError).code).toBe("TARGET_ACTIVE");
    }
  });

  test("DELIVERY_UNKNOWN propagates verbatim and is never retried by the adapter", async () => {
    const { client } = mockClient(() => toolFailure("DELIVERY_UNKNOWN", "do not resend automatically"));
    const adapter = new CodexHostAdapter(client);
    try {
      await adapter.send("controller-1", "prompt");
      expect.unreachable();
    } catch (error) {
      expect((error as BridgeCoreError).code).toBe("DELIVERY_UNKNOWN");
    }
  });

  test("unknown failure codes degrade to HOST_OFFLINE, never to a delivery outcome", async () => {
    const { client } = mockClient(() => toolFailure("SOMETHING_NEW", "future code"));
    const adapter = new CodexHostAdapter(client);
    try {
      await adapter.send("controller-1", "prompt");
      expect.unreachable();
    } catch (error) {
      expect((error as BridgeCoreError).code).toBe("HOST_OFFLINE");
    }
  });

  test("401/403 surface as AUTH_REQUIRED", async () => {
    const fetchImpl = (async () => new Response("no", { status: 401 })) as typeof fetch;
    const client = new DevSpaceMcpClient({ baseUrl: "http://127.0.0.1:17676/mcp", bearerToken: "x", fetchImpl });
    try {
      await client.callTool("codex_bridge_status", { controllerId: "c1" });
      expect.unreachable();
    } catch (error) {
      expect((error as BridgeCoreError).code).toBe("AUTH_REQUIRED");
    }
  });

  test("bearer token never appears in the request URL", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: toolResult({ ok: true, state: "READABLE" }) }), { status: 200 });
    }) as typeof fetch;
    const client = new DevSpaceMcpClient({ baseUrl: "http://127.0.0.1:17676/mcp", bearerToken: "super-secret-token", fetchImpl });
    await client.callTool("codex_bridge_status", { controllerId: "c1" });
    expect(seen.every(url => !url.includes("super-secret-token"))).toBe(true);
  });

  test("codex host adapter unwraps status payloads", async () => {
    const { client } = mockClient(() =>
      toolResult({ ok: true, bindingId: "b-1", state: "READABLE", codex: { status: "idle" } }),
    );
    const adapter = new CodexHostAdapter(client);
    const status = await adapter.status("controller-1");
    expect(status.bindingId).toBe("b-1");
    expect(status.state).toBe("READABLE");
    expect(status.codex?.status).toBe("idle");
  });

  test("send enforces the 512 KiB boundary before any network call", async () => {
    const { client, calls } = mockClient(() => toolResult({ ok: true, state: "DELIVERED" }));
    const adapter = new CodexHostAdapter(client);
    await expect(adapter.send("c1", "x".repeat(512 * 1024 + 1))).rejects.toThrow(BridgeCoreError);
    expect(calls).toHaveLength(0);
  });

  test("a retired session id is dropped: the next call re-initializes instead of failing forever", async () => {
    const sent: string[] = [];
    let retired = false;
    let minted = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body ?? "{}"));
      sent.push(`${body.method}:${headers["mcp-session-id"] ?? "none"}`);
      if (body.method === "initialize") {
        minted += 1;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
          status: 200,
          headers: { "mcp-session-id": `session-${minted}` },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      // A DevSpace restart retires the minted id, so any call still presenting
      // session-1 is rejected until the client mints a new one.
      if (retired && headers["mcp-session-id"] === "session-1") return new Response("no such session", { status: 404 });
      retired = true;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: toolResult({ ok: true, state: "READABLE" }) }), { status: 200 });
    }) as typeof fetch;
    const client = new DevSpaceMcpClient({ baseUrl: "http://127.0.0.1:17676/mcp", bearerToken: "x", fetchImpl });
    await client.callTool("codex_bridge_status", { controllerId: "c1" });
    await expect(client.callTool("codex_bridge_status", { controllerId: "c1" })).rejects.toThrow(BridgeCoreError);
    await client.callTool("codex_bridge_status", { controllerId: "c1" });
    expect(sent).toEqual([
      "initialize:none",
      "notifications/initialized:session-1",
      "tools/call:session-1",
      "tools/call:session-1",
      "initialize:none",
      "notifications/initialized:session-2",
      "tools/call:session-2",
    ]);
  });

  test("a shared SSE stream is matched by request id, not by the first response frame", async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200 });
      }
      const other = { jsonrpc: "2.0", id: 99, result: toolResult({ ok: true, state: "ANSWER-TO-ANOTHER-CALL" }) };
      const mine = { jsonrpc: "2.0", id: body.id, result: toolResult({ ok: true, state: "READABLE" }) };
      return new Response(
        `data: ${JSON.stringify(other)}\n\ndata: ${JSON.stringify(mine)}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const client = new DevSpaceMcpClient({ baseUrl: "http://127.0.0.1:17676/mcp", bearerToken: "x", fetchImpl });
    const status = await new CodexHostAdapter(client).status("c1");
    expect(status.state).toBe("READABLE");
  });
});
