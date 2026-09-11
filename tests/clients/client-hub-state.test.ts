/**
 * A connected client's hub-state read and its 0600 cache (#4236).
 *
 * The invariant every case here defends is one sentence: when the hub cannot be read, the
 * answer is "unavailable" — never the client's own local provider and login state. That silent
 * degradation is the defect being fixed, and it is invisible in output, because local state
 * renders exactly like hub state. So the cases enumerate every way the read can fail (404 from
 * an old hub, 401, unreachable, non-JSON, malformed JSON, wrong schema, oversized body) and
 * assert the resolution is `cache` or `unavailable` with a reason, with `state` null whenever
 * there is nothing true to show.
 *
 * The owner stamp gets its own case because it is the difference between a stale file and a
 * LIE: after a disconnect and a reconnect to a different hub, an unstamped cache would present
 * the previous hub's providers as this one's.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchHubState, HubClientError } from "../../src/client/hub-client";
import {
  hubStateCachePath,
  hubStateFailureReason,
  readCachedHubState,
  resolveHubState,
  writeCachedHubState,
  type HubStateOwner,
} from "../../src/client/hub-state";
import { parseHubStateBody, type HubStateDTO } from "../../src/remote/hub-state";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";

const OWNER: HubStateOwner = {
  serverUrl: "https://hub.example.test:8443",
  apiKeyId: "client-one",
  connectedAt: "2026-09-01T00:00:00.000Z",
};

function hubState(overrides: Partial<HubStateDTO> = {}): HubStateDTO {
  return {
    schemaVersion: 1,
    runtimeRole: "hub",
    hubVersion: "2.51.0",
    origin: "https://hub.example.test:8443",
    providers: [{ name: "xai", adapter: "openai-chat", authMode: "oauth", hasCredential: true, disabled: false }],
    oauth: [{ provider: "xai", loggedIn: true }],
    subagentModels: ["xai/grok-4.6"],
    truncated: false,
    claudeCode: { enabled: true },
    ...overrides,
  };
}

function jsonFetch(body: unknown, init: { status?: number; contentType?: string } = {}): typeof fetch {
  return (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "application/json" },
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-client-hub-state-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

describe("fetchHubState", () => {
  test("parses a well-formed hub response", async () => {
    const state = await fetchHubState(OWNER.serverUrl, "ocx_data_x", { fetchImpl: jsonFetch(hubState()) });
    expect(state.providers[0]?.name).toBe("xai");
    expect(state.subagentModels).toEqual(["xai/grok-4.6"]);
  });

  test("an old hub's 404 is version skew, not a missing hub", async () => {
    // The distinct code is what lets the CLI say "upgrade the hub" instead of printing a
    // generic failure that reads like a client bug.
    const error = await fetchHubState(OWNER.serverUrl, "ocx_data_x", {
      fetchImpl: jsonFetch({ error: { code: "not_found" } }, { status: 404 }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubClientError);
    expect((error as HubClientError).code).toBe("hub_state_unsupported");
  });

  test.each([
    [401, "hub_state_unauthorized"],
    [500, "hub_state_http_500"],
  ] as const)("status %i surfaces as %s", async (status, code) => {
    const error = await fetchHubState(OWNER.serverUrl, "ocx_data_x", {
      fetchImpl: jsonFetch({ error: {} }, { status }),
    }).catch((e: unknown) => e);
    expect((error as HubClientError).code).toBe(code);
  });

  test("a non-JSON content type is refused without reading the body", async () => {
    const error = await fetchHubState(OWNER.serverUrl, "ocx_data_x", {
      fetchImpl: jsonFetch("<html>hello</html>", { contentType: "text/html" }),
    }).catch((e: unknown) => e);
    expect((error as HubClientError).code).toBe("hub_state_content_type_invalid");
  });

  test.each([
    ["malformed JSON", "{not json", "hub_state_invalid"],
    ["a foreign document", JSON.stringify({ schemaVersion: 1, models: [] }), "hub_state_schema_invalid"],
    ["a future schema", JSON.stringify({ ...hubState(), schemaVersion: 2 }), "hub_state_schema_invalid"],
    ["a non-hub role", JSON.stringify({ ...hubState(), runtimeRole: "standalone" }), "hub_state_schema_invalid"],
    ["a provider row with no booleans", JSON.stringify({ ...hubState(), providers: [{ name: "x", adapter: "y" }] }), "hub_state_schema_invalid"],
  ])("%s is refused (%#)", async (_label, body, code) => {
    const error = await fetchHubState(OWNER.serverUrl, "ocx_data_x", {
      fetchImpl: jsonFetch(body),
    }).catch((e: unknown) => e);
    expect((error as HubClientError).code).toBe(code);
  });

  test("an oversized roster is refused rather than truncated", async () => {
    const body = hubState({ subagentModels: Array.from({ length: 64 }, (_, i) => `m-${i}`) });
    const error = await fetchHubState(OWNER.serverUrl, "ocx_data_x", {
      fetchImpl: jsonFetch(body),
    }).catch((e: unknown) => e);
    expect((error as HubClientError).code).toBe("hub_state_schema_invalid");
  });

  test("the truncation flag crosses the wire, and an older hub's document still parses", async () => {
    const flagged = await fetchHubState(OWNER.serverUrl, "ocx_data_x", {
      fetchImpl: jsonFetch(hubState({ truncated: true })),
    });
    expect(flagged.truncated).toBe(true);
    // A hub that predates the flag sends no `truncated` key. Refusing that document would turn
    // an honesty field into a compatibility break; absent reads as "nothing was dropped".
    const { truncated: _dropped, ...withoutFlag } = hubState();
    const older = await fetchHubState(OWNER.serverUrl, "ocx_data_x", { fetchImpl: jsonFetch(withoutFlag) });
    expect(older.truncated).toBe(false);
    // A present non-boolean is still refused, like every other field in this contract.
    expect(parseHubStateBody({ ...hubState(), truncated: "yes" })).toBeNull();
  });
});

describe("hubStateFailureReason", () => {
  // Every code `fetchHubState` throws needs a sentence: this string is printed verbatim in the
  // `ocx status` banner, and `state unavailable (hub_state_http_507)` sends an operator hunting
  // for a client bug when the hub has answered and said something.
  test.each([
    ["hub_state_content_type_invalid", "the hub's state response was not JSON"],
    ["hub_state_http_507", "the hub answered HTTP 507 to the state request"],
    ["hub_state_http_502", "the hub answered HTTP 502 to the state request"],
  ] as const)("%s renders as a sentence", (code, expected) => {
    expect(hubStateFailureReason(new HubClientError(code, "raw"))).toBe(expected);
  });

  test("an unknown code still falls back to the code rather than inventing a status", () => {
    expect(hubStateFailureReason(new HubClientError("hub_state_http_oops", "raw"))).toBe("hub_state_http_oops");
    expect(hubStateFailureReason(new HubClientError("something_else", "raw"))).toBe("something_else");
  });

  test("the sentences reach the resolution, not just the helper", async () => {
    const contentType = await resolveHubState({
      owner: OWNER,
      token: "ocx_data_x",
      fetchImpl: jsonFetch("<html>captive portal</html>", { contentType: "text/html" }),
    });
    expect(contentType.stateSource).toBe("unavailable");
    expect(contentType.reason).toBe("the hub's state response was not JSON");
    const overSized = await resolveHubState({
      owner: OWNER,
      token: "ocx_data_x",
      fetchImpl: jsonFetch({ error: {} }, { status: 507 }),
    });
    expect(overSized.stateSource).toBe("unavailable");
    expect(overSized.reason).toBe("the hub answered HTTP 507 to the state request");
  });
});

describe("resolveHubState", () => {
  test("a live read reports stateSource hub and writes an owner-stamped 0600 cache", async () => {
    const resolved = await resolveHubState({
      owner: OWNER,
      token: "ocx_data_x",
      fetchImpl: jsonFetch(hubState()),
      now: Date.parse("2026-09-11T12:00:00.000Z"),
    });
    expect(resolved.stateSource).toBe("hub");
    expect(resolved.reason).toBeUndefined();
    expect(resolved.state?.oauth[0]).toEqual({ provider: "xai", loggedIn: true });
    expect(resolved.fetchedAt).toBe("2026-09-11T12:00:00.000Z");
    const mode = lstatSync(hubStateCachePath()).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
    expect(JSON.parse(readFileSync(hubStateCachePath(), "utf8")).owner).toEqual(OWNER);
  });

  test("an unreachable hub falls back to the cache and says why", async () => {
    writeCachedHubState(OWNER, hubState(), "2026-09-11T11:00:00.000Z");
    const resolved = await resolveHubState({
      owner: OWNER,
      token: "ocx_data_x",
      fetchImpl: (() => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      now: Date.parse("2026-09-11T12:00:00.000Z"),
    });
    expect(resolved.stateSource).toBe("cache");
    expect(resolved.reason).toBe("the hub is unreachable");
    expect(resolved.ageSeconds).toBe(3600);
    // Still the HUB's providers. A cache is stale hub state; local state is not hub state.
    expect(resolved.state?.providers[0]?.name).toBe("xai");
  });

  test("with no cache an unreachable hub is unavailable, never local state", async () => {
    const resolved = await resolveHubState({
      owner: OWNER,
      token: "ocx_data_x",
      fetchImpl: (() => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(resolved.stateSource).toBe("unavailable");
    expect(resolved.state).toBeNull();
    expect(resolved.reason).toBe("the hub is unreachable");
  });

  test("an old hub is unavailable with an upgrade instruction", async () => {
    const resolved = await resolveHubState({
      owner: OWNER,
      token: "ocx_data_x",
      fetchImpl: jsonFetch({ error: {} }, { status: 404 }),
    });
    expect(resolved.stateSource).toBe("unavailable");
    expect(resolved.reason).toContain("upgrade the hub");
  });

  test("a missing data token never becomes a live read", async () => {
    let called = false;
    const resolved = await resolveHubState({
      owner: OWNER,
      token: null,
      fetchImpl: (() => { called = true; throw new Error("should not be called"); }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(resolved.stateSource).toBe("unavailable");
    expect(resolved.reason).toBe("this client has no usable data-plane token");
  });

  test("allowNetwork false reads only the cache", async () => {
    writeCachedHubState(OWNER, hubState(), "2026-09-11T11:59:30.000Z");
    let called = false;
    const resolved = await resolveHubState({
      owner: OWNER,
      token: "ocx_data_x",
      allowNetwork: false,
      fetchImpl: (() => { called = true; throw new Error("should not be called"); }) as unknown as typeof fetch,
      now: Date.parse("2026-09-11T12:00:00.000Z"),
    });
    expect(called).toBe(false);
    expect(resolved.stateSource).toBe("cache");
    expect(resolved.ageSeconds).toBe(30);
  });

  test("another hub's cache is discarded rather than shown as this hub's", async () => {
    writeCachedHubState(
      { serverUrl: "https://other-hub.example.test", apiKeyId: "client-one", connectedAt: OWNER.connectedAt },
      hubState(),
      "2026-09-11T11:00:00.000Z",
    );
    expect(readCachedHubState(OWNER)).toBeNull();
    const resolved = await resolveHubState({
      owner: OWNER,
      token: "ocx_data_x",
      fetchImpl: (() => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(resolved.stateSource).toBe("unavailable");
  });

  test("a rotated apiKeyId invalidates the cache", () => {
    writeCachedHubState(OWNER, hubState(), "2026-09-11T11:00:00.000Z");
    expect(readCachedHubState({ ...OWNER, apiKeyId: "client-two" })).toBeNull();
  });

  test("a malformed or symlinked cache file is ignored", () => {
    writeFileSync(hubStateCachePath(), "{not json");
    expect(readCachedHubState(OWNER)).toBeNull();
    writeFileSync(join(testHome, "elsewhere.json"), JSON.stringify({
      version: 1, owner: OWNER, fetchedAt: "2026-09-11T11:00:00.000Z", state: hubState(),
    }));
    removeTreeWithRetry(hubStateCachePath());
    symlinkSync(join(testHome, "elsewhere.json"), hubStateCachePath());
    expect(readCachedHubState(OWNER)).toBeNull();
  });
});
