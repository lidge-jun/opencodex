import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagementContext } from "../../src/server/management/context";
import {
  handleAnthropicResetGrantRoutes,
  type AnthropicResetGrantRouteDeps,
} from "../../src/server/management/anthropic-reset-grant-routes";

// Upstream is always an injected fake here. A real claim spends a one-time reset.

const TOKEN = "fake-oauth-access-for-route-tests";
const ORG = "cbbef438-0000-4000-8000-00000000abcd";
const EMAIL = "owner@example.com";
const GRANT = "opus55-launch-promax-20260921";
const OP = "8a6e0804-2bd0-4672-b79d-d97027f9071a";
const OP2 = "5c1f7a55-9b1e-4d8e-a0c4-2f5b3c9d7e61";

function grantBlock(overrides: Record<string, unknown> = {}) {
  return {
    eligible: true,
    at_limit: false,
    grants: [{
      id: GRANT, label: "Launch reset", resets_total: 1, resets_left: 1,
      starts_at: "2026-09-22T16:00:00+00:00", ends_at: "2026-10-22T16:00:00+00:00",
      clears: ["five_hour", "seven_day"], paused: false, usable_now: true, use_requires_limit: false,
      percent_used: { five_hour: 3, seven_day: 14 },
    }],
    next_grant_id: GRANT,
    event_props: { tier: "claude_max_20x" },
    ...overrides,
  };
}

interface Upstream {
  claims: Array<{ url: string; body: Record<string, unknown> }>;
  reads: number;
  status: () => Response;
  claim: () => Response | Promise<Response>;
}

function upstream(): Upstream & { fetchFn: typeof globalThis.fetch } {
  const state: Upstream = {
    claims: [],
    reads: 0,
    status: () => Response.json({ cedar_ember: grantBlock() }),
    claim: () => Response.json({ result: "reset", resets_left: 0, cleared: ["five_hour", "seven_day"] }),
  };
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/api/oauth/profile")) {
      return Response.json({ account: { email: EMAIL }, organization: { uuid: ORG, name: "Org of " + EMAIL } });
    }
    if (url.includes("/api/oauth/usage")) {
      state.reads += 1;
      return state.status();
    }
    if (url.includes("/reset_rate_limits")) {
      state.claims.push({ url, body: JSON.parse(String(init.body)) });
      return state.claim();
    }
    throw new Error("unexpected upstream " + url);
  }) as unknown as typeof globalThis.fetch;
  return Object.assign(state, { fetchFn });
}

let dir: string;
let journalPath: string;
let responses: string[];
let logs: string[];
let spies: Array<{ mockRestore: () => void }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anthropic-reset-routes-"));
  journalPath = join(dir, "anthropic-reset-grant-ledger.json");
  responses = [];
  logs = [];
  spies = (["log", "info", "warn", "error", "debug"] as const).map(level =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); }));
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  // Privacy: nothing the fakes handed out may surface in a response or a log line.
  for (const text of [...responses, ...logs]) {
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ORG);
    expect(text).not.toContain(EMAIL);
  }
  expect(logs).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

function deps(up: { fetchFn: typeof globalThis.fetch }, overrides: Partial<AnthropicResetGrantRouteDeps> = {}): AnthropicResetGrantRouteDeps {
  return {
    fetchFn: up.fetchFn,
    journalPath,
    listAccountIds: () => ["acct-1", "acct-2"],
    activeAccountId: () => "acct-1",
    accessTokenFor: async () => TOKEN,
    ...overrides,
  };
}

async function call(
  method: string,
  path: string,
  routeDeps: AnthropicResetGrantRouteDeps,
  body?: unknown,
  principal: ManagementContext["principal"] | "absent" = "gui-session",
): Promise<{ status: number; json: Record<string, any> }> {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const req = new Request(url, {
    method,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  // "absent" models direct dispatch, where the context carries no principal at all.
  const ctx = { req, url, config: {}, deps: {}, ...(principal === "absent" ? {} : { principal }) } as unknown as ManagementContext;
  const response = await handleAnthropicResetGrantRoutes(ctx, routeDeps);
  if (!response) throw new Error("route not handled");
  const text = await response.text();
  responses.push(text);
  return { status: response.status, json: JSON.parse(text) };
}

const consume = (routeDeps: AnthropicResetGrantRouteDeps, body: Record<string, unknown> = { accountId: "acct-1", grantId: GRANT, operationId: OP }, principal?: ManagementContext["principal"] | "absent") =>
  call("POST", "/api/anthropic/reset-grants/consume", routeDeps, body, principal);

describe("GET /api/anthropic/reset-grants", () => {
  test("returns the parsed grants for the requested account", async () => {
    const up = upstream();
    const { status, json } = await call("GET", "/api/anthropic/reset-grants?accountId=acct-2", deps(up));
    expect(status).toBe(200);
    expect(json).toMatchObject({ accountId: "acct-2", eligible: true, pendingOperation: null, journalAvailable: true });
    expect(json.grants[0]).toMatchObject({ id: GRANT, resetsLeft: 1, usableNow: true });
    expect(JSON.stringify(json)).not.toContain("claude_max_20x");
  });

  test("unknown account, token failure, and upstream failures use fixed codes", async () => {
    const up = upstream();
    expect((await call("GET", "/api/anthropic/reset-grants?accountId=nope", deps(up))).json.error.code).toBe("no_account");
    const noToken = await call("GET", "/api/anthropic/reset-grants", deps(up, { accessTokenFor: async () => { throw new Error(`refresh failed for ${EMAIL} with ${TOKEN}`); } }));
    expect(noToken).toMatchObject({ status: 401, json: { error: { code: "auth_failed" } } });
    up.status = () => new Response(`upstream said ${EMAIL}`, { status: 500 });
    expect(await call("GET", "/api/anthropic/reset-grants", deps(up))).toMatchObject({ status: 502, json: { error: { code: "upstream_unavailable" } } });
    up.status = () => Response.json({ cedar_ember: { eligible: "maybe" } });
    expect((await call("GET", "/api/anthropic/reset-grants", deps(up))).status).toBe(502);
  });

  test("other methods are refused", async () => {
    expect((await call("DELETE", "/api/anthropic/reset-grants", deps(upstream()))).status).toBe(405);
    expect((await call("GET", "/api/anthropic/reset-grants/consume", deps(upstream()))).status).toBe(405);
  });
});

describe("POST /api/anthropic/reset-grants/consume", () => {
  test("the admin token alone cannot spend a reset", async () => {
    const up = upstream();
    const result = await consume(deps(up), undefined, "admin-token");
    expect(result).toMatchObject({ status: 403, json: { error: { code: "session_required" } } });
    const direct = await consume(deps(up), undefined, "absent");
    expect(direct.status).toBe(403);
    expect(up.claims).toEqual([]);
  });

  test("malformed bodies are refused before any upstream call", async () => {
    const up = upstream();
    expect((await call("POST", "/api/anthropic/reset-grants/consume", deps(up), "{nope")).json.error.code).toBe("invalid_json");
    expect((await consume(deps(up), { accountId: "acct-1", grantId: "BAD ID", operationId: OP })).json.error.code).toBe("invalid_grant_id");
    expect((await consume(deps(up), { accountId: "acct-1", grantId: GRANT, operationId: "123" })).json.error.code).toBe("invalid_operation_id");
    expect((await consume(deps(up), { grantId: GRANT, operationId: OP })).json.error.code).toBe("no_account");
    expect((await consume(deps(up), { accountId: "acct-9", grantId: GRANT, operationId: OP })).json.error.code).toBe("no_account");
    expect(up.claims).toEqual([]);
  });

  test("a grant the fresh read does not offer is refused without a claim", async () => {
    const up = upstream();
    up.status = () => Response.json({ cedar_ember: grantBlock({ at_limit: false, grants: [{ ...grantBlock().grants[0], use_requires_limit: true }] }) });
    expect(await consume(deps(up))).toMatchObject({ status: 409, json: { error: { code: "grant_not_usable", reason: "not_limited" } } });
    up.status = () => Response.json({ cedar_ember: grantBlock({ eligible: false }) });
    expect((await consume(deps(up))).json.error.reason).toBe("ineligible");
    expect(up.claims).toEqual([]);
  });

  test("a spend posts once with the operation id as request id and then replays", async () => {
    const up = upstream();
    const first = await consume(deps(up));
    expect(first).toMatchObject({ status: 200, json: { code: "reset", replayed: false, resetsLeft: 0, operationId: OP } });
    expect(up.claims).toHaveLength(1);
    expect(up.claims[0].url).toBe(`https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`);
    expect(up.claims[0].body).toEqual({ program: "cedar_ember", grant_id: GRANT, request_id: OP });
    const again = await consume(deps(up));
    expect(again).toMatchObject({ status: 200, json: { code: "reset", replayed: true } });
    expect(up.claims).toHaveLength(1);
  });

  test("a refusal that proves nothing ran settles as that code", async () => {
    const up = upstream();
    up.claim = () => new Response("", { status: 429 });
    expect((await consume(deps(up))).json).toMatchObject({ code: "rate_limited", replayed: false });
  });

  test("an unknown outcome keeps the id; only the same id may retry, and it re-sends the same request id", async () => {
    const up = upstream();
    up.claim = () => { throw new TypeError("network down"); };
    const lost = await consume(deps(up));
    expect(lost).toMatchObject({ status: 502, json: { error: { code: "unknown_outcome", operationId: OP } } });

    const pending = await call("GET", "/api/anthropic/reset-grants", deps(up));
    expect(pending.json.pendingOperation).toMatchObject({ operationId: OP, grantId: GRANT });

    const fresh = await consume(deps(up), { accountId: "acct-1", grantId: GRANT, operationId: OP2 });
    expect(fresh).toMatchObject({ status: 409, json: { error: { code: "unresolved_prior_operation", pendingOperationId: OP } } });

    up.claim = () => Response.json({ result: "reset", resets_left: 0 });
    const readsBeforeRetry = up.reads;
    const retried = await consume(deps(up));
    expect(retried).toMatchObject({ status: 200, json: { code: "reset", replayed: false } });
    expect(up.claims.map(claim => claim.body.request_id)).toEqual([OP, OP]);
    // A same-id retry is not re-gated: that attempt was gated when it began.
    expect(up.reads).toBe(readsBeforeRetry);
  });

  test("an answer that cannot be journaled fails closed", async () => {
    const up = upstream();
    up.claim = () => {
      // Replace the journal with a directory so the settlement write cannot land.
      rmSync(journalPath, { force: true });
      mkdirSync(journalPath);
      return Response.json({ result: "reset", resets_left: 0 });
    };
    const result = await consume(deps(up));
    expect(result).toMatchObject({ status: 500, json: { error: { code: "journal_write_failed", operationId: OP } } });
    expect(result.json.code).toBeUndefined();
  });

  test("a journal that cannot be read refuses before any claim", async () => {
    const up = upstream();
    mkdirSync(journalPath);
    expect((await consume(deps(up))).status).toBe(503);
    expect(up.claims).toEqual([]);
  });
});
