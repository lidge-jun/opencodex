import { afterEach, beforeEach, expect, test } from "bun:test";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { CODEX_RESPONSES_HTTP_URL, prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";

const usage = { input_tokens: 3, output_tokens: 4, total_tokens: 7 };
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let savedProxyEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
});

afterEach(() => {
  for (const key of proxyKeys) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
});

function request() {
  const init: RequestInit = {
    method: "POST", signal: AbortSignal.timeout(3000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-model", stream: true, input: [] }),
  };
  return { init, prepared: prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, init)! };
}

type MetadataPlan = { before?: Record<string, string>; after?: Record<string, string> };
type EventPayload = { type: string; response?: { usage?: typeof usage }; headers?: Record<string, string> };

/** Real Bun upgrade and production exchange, with no credentials or provider traffic. */
async function withLoopback(
  headers: Record<string, string>,
  plan: (index: number) => MetadataPlan,
  run: (fixture: {
    next(hold?: boolean): Promise<{ response: Response; events: EventPayload[]; body: string }>;
    connections(): number;
    creates: Record<string, unknown>[];
    quotas: Headers[];
  }) => Promise<void>,
) {
  let connections = 0;
  let fallbacks = 0;
  const creates: Record<string, unknown>[] = [];
  const quotas: Headers[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      if (server.upgrade(req, { headers: new Headers(headers) })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open() { connections++; },
      message(ws, message) {
        creates.push(JSON.parse(String(message)));
        const { before, after } = plan(creates.length - 1);
        const id = `response-${creates.length}`;
        const send = (event: unknown) => ws.send(JSON.stringify(event));
        if (before) send({ type: "codex.response.metadata", headers: before });
        send({ type: "response.created", response: { id, status: "in_progress", output: [] } });
        if (after) send({ type: "codex.response.metadata", headers: after });
        send({ type: "response.done", response: { id, status: "completed", output: [], usage } });
      },
    },
  });
  const session = new CodexWsSession(`ws://127.0.0.1:${server.port}`, request().prepared.headers, true);
  try {
    await run({
      connections: () => connections, creates, quotas,
      async next(hold = false) {
        expect(session.reserve()).toBe(true);
        const { init, prepared } = request();
        const response = await codexWsExchange({
          session, url: CODEX_RESPONSES_HTTP_URL, init, prepared, bunVersion: Bun.version,
          onQuota: value => quotas.push(value),
          ...(hold ? { preOutputRefusalHold: { maxMs: 1000, until: Date.now() + 1000 } } : {}),
          sseFallback: (async () => { fallbacks++; throw new Error("unexpected HTTP fallback"); }) as typeof fetch,
        });
        const body = await response.text();
        const events: EventPayload[] = body.split("\n").filter(line => line.startsWith("data: "))
          .map(line => JSON.parse(line.slice(6)));
        expect(response.status).toBe(200);
        expect(events.find(event => event.type === "response.completed")?.response?.usage).toEqual(usage);
        return { response, events, body };
      },
    });
    expect(fallbacks).toBe(0);
    expect(creates.every(frame => frame.type === "response.create")).toBe(true);
  } finally {
    session.dispose();
    await server.stop(true);
  }
}

test("upgrade-only reasoning inclusion survives both first and reused exchanges", async () => {
  await withLoopback({ "x-reasoning-included": "true" }, () => ({}), async fixture => {
    for (let index = 0; index < 2; index++) {
      const { response, events } = await fixture.next();
      expect(response.headers.get("x-reasoning-included")).toBe("true");
      expect(events.some(event => event.type === "codex.response.metadata")).toBe(false);
    }
    expect(fixture.connections()).toBe(1);
    expect(fixture.creates).toHaveLength(2);
  });
});

test.each(["before", "after", "absent"] as const)("%s metadata keeps the existing header commit boundary", async timing => {
  await withLoopback({}, () => timing === "absent" ? {} : { [timing]: { "x-reasoning-included": "true" } }, async fixture => {
    const { response, events } = await fixture.next();
    expect(response.headers.get("x-reasoning-included")).toBe(timing === "before" ? "true" : null);
    const metadata = events.filter(event => event.type === "codex.response.metadata");
    expect(metadata).toHaveLength(timing === "absent" ? 0 : 1);
    if (metadata.length) expect(metadata[0]?.headers?.["x-reasoning-included"]).toBe("true");
  });
});

test("per-response metadata overrides the upgrade default without contaminating socket reuse", async () => {
  await withLoopback({ "x-reasoning-included": "false" }, index => index === 0
    ? { before: { "x-reasoning-included": "true" } } : {}, async fixture => {
    const first = await fixture.next();
    const second = await fixture.next();
    expect(first.response.headers.get("x-reasoning-included")).toBe("true");
    expect(second.response.headers.get("x-reasoning-included")).toBe("false");
    expect(second.events.some(event => event.type === "codex.response.metadata")).toBe(false);
    expect(fixture.connections()).toBe(1);
  });
});

test("a refusal hold keeps the upgrade header frozen before late metadata", async () => {
  await withLoopback({ "x-reasoning-included": "true" }, () => ({ after: { "x-reasoning-included": "false" } }), async fixture => {
    const { response, events } = await fixture.next(true);
    expect(response.headers.get("x-reasoning-included")).toBe("true");
    expect(events.find(event => event.type === "codex.response.metadata")?.headers?.["x-reasoning-included"]).toBe("false");
  });
});

test("upgrade capture does not replay credentials, framing, or response-scoped headers", async () => {
  await withLoopback({
    "x-reasoning-included": "true", authorization: "fixture-secret", "set-cookie": "fixture-cookie=value",
    "x-request-id": "upgrade-request", "openai-model": "upgrade-model", "x-models-etag": "upgrade-catalog",
    "x-codex-turn-state": "upgrade-turn", "x-codex-primary-used-percent": "19", "x-codex-credits-balance": "7",
  }, () => ({}), async fixture => {
    const { response, body } = await fixture.next();
    expect(response.headers.get("x-reasoning-included")).toBe("true");
    for (const name of ["authorization", "set-cookie", "connection", "upgrade", "sec-websocket-accept", "content-length",
      "x-request-id", "openai-model", "x-models-etag", "x-codex-turn-state", "x-codex-primary-used-percent", "x-codex-credits-balance"]) {
      expect(response.headers.has(name)).toBe(false);
    }
    expect(body).not.toContain("fixture-secret");
    expect(body).not.toContain("fixture-cookie");
    expect(fixture.quotas).toHaveLength(0);
  });
});

test("an invalid 101 handshake cannot contaminate the HTTP fallback", async () => {
  const answered = new WeakSet<object>();
  const listener = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      data(socket) {
        if (answered.has(socket)) return;
        answered.add(socket);
        socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
          + "Sec-WebSocket-Accept: invalid-fixture-accept\r\nx-reasoning-included: true\r\n\r\n");
      },
    },
  });
  const { init, prepared } = request();
  const session = new CodexWsSession(`ws://127.0.0.1:${listener.port}`, prepared.headers);
  let handshakes = 0;
  let fallbacks = 0;
  session.socket.addEventListener("handshake", () => { handshakes++; });
  const fallback = new Response("fallback-body", { headers: { "x-request-id": "http-fallback" } });
  try {
    expect(session.reserve()).toBe(true);
    const response = await codexWsExchange({
      session, url: CODEX_RESPONSES_HTTP_URL, init, prepared, bunVersion: Bun.version,
      sseFallback: (async () => { fallbacks++; return fallback; }) as typeof fetch,
    });
    expect(handshakes).toBe(1);
    expect(session.opened).toBe(false);
    expect(fallbacks).toBe(1);
    expect(response).toBe(fallback);
    expect(response.headers.has("x-reasoning-included")).toBe(false);
    expect(response.headers.get("x-request-id")).toBe("http-fallback");
    expect(await response.text()).toBe("fallback-body");
  } finally {
    session.dispose();
    listener.stop(true);
  }
});
