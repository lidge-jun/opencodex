/**
 * `ocx api protocols | explain | policy` (PF-12): argv parsing, the request each sends to the
 * protocol management routes, `--json`, and the route-registry parity that replaced the
 * deferred-verb exemptions.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { handleApiCommand } from "../../src/cli/api-protocols";
import { capabilitiesForRoute, CAPABILITIES } from "../../src/cli/capabilities";
import { DISPATCH_COMMANDS } from "../../src/cli/dispatch";
import { findCommand } from "../../src/cli/registry";
import { MANAGEMENT_ROUTES } from "../../src/server/management/route-registry";

type Recorded = { url: string; method: string; body: unknown; contentType: string | null };

const INFO = {
  schemaVersion: 1,
  contractVersion: "c1",
  policyRevision: "p1-00000000",
  surfaces: {
    responses: { enabled: true, source: "fixed" },
    chat: { enabled: true, source: "fixed" },
    messages: { enabled: false, source: "api-surfaces" },
  },
  settings: {
    unrepresentable: "legacy",
    rollout: { nativeChatCombos: false, managedMessagesNative: false, managedMessagesNativeOAuth: false, directEncoders: false, shadowPlan: false },
  },
  features: ["request.tools", "request.seed"],
};

const PLAN = {
  schemaVersion: 1,
  basis: "preview",
  contractVersion: "c1",
  policyRevision: "p1-00000000",
  inbound: "chat",
  requestedModel: "m1",
  routeKind: "direct",
  mode: "native",
  reasonCodes: ["same-wire-native"],
  candidates: [{
    provider: "a", model: "m1", adapter: "openai-chat", upstream: "chat", mode: "native",
    requestPath: ["chat", "chat"], responsePath: ["chat", "chat"], fidelity: "preserved",
    reasonCodes: ["same-wire-native"], featureEffects: [], unknownFeatures: [], eligible: true,
  }],
  guaranteedFeatures: ["request.seed"],
  partialFeatures: [],
};

let log: Mock<typeof console.log>;
let error: Mock<typeof console.error>;

beforeEach(() => {
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  error.mockRestore();
});

function fakeRuntime(respond: (request: Recorded) => unknown = () => INFO) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : null;
    const request: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      body: raw === null ? null : JSON.parse(raw),
      contentType: new Headers(init?.headers).get("content-type"),
    };
    requests.push(request);
    return new Response(JSON.stringify(respond(request)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { requests, deps: { baseUrl: "http://127.0.0.1:9", fetchImpl } };
}

const printed = (): string => log.mock.calls.flat().join("\n");

describe("ocx api protocols", () => {
  test("reads GET /api/protocols and prints the policy as text", async () => {
    const { requests, deps } = fakeRuntime();
    expect(await handleApiCommand(["protocols"], deps)).toBe(0);
    // The shared runtime request helper sets its JSON content type on every call, GET included.
    expect(requests.map(r => [r.method, r.url, r.body])).toEqual([["GET", "http://127.0.0.1:9/api/protocols", null]]);
    expect(printed()).toContain("API messages: closed (api-surfaces)");
    expect(printed()).toContain("Rollout shadowPlan: off");
  });

  test("--provider adds the encoded query and --json prints the payload unchanged", async () => {
    const { requests, deps } = fakeRuntime();
    expect(await handleApiCommand(["protocols", "--json", "--provider", "my provider"], deps)).toBe(0);
    expect(requests[0]!.url).toBe("http://127.0.0.1:9/api/protocols?provider=my%20provider");
    expect(JSON.parse(printed())).toEqual(INFO);
  });

  test("an unexpected argument is usage (exit 2) and sends nothing", async () => {
    const { requests, deps } = fakeRuntime();
    expect(await handleApiCommand(["protocols", "extra"], deps)).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe("ocx api explain", () => {
  test("posts model, inbound and deduplicated features, and prints the plan", async () => {
    const { requests, deps } = fakeRuntime(() => PLAN);
    const argv = ["explain", "--model", "m1", "--inbound", "chat", "--feature", "request.seed,request.tools", "--feature", "request.seed"];
    expect(await handleApiCommand(argv, deps)).toBe(0);
    expect(requests).toEqual([{
      url: "http://127.0.0.1:9/api/protocols/plan",
      method: "POST",
      body: { model: "m1", inbound: "chat", features: ["request.seed", "request.tools"] },
      contentType: "application/json",
    }]);
    expect(printed()).toContain("chat m1: native (direct route, preview)");
    expect(printed()).toContain("a/m1: native chat > chat");
    expect(printed()).toContain("Guaranteed features: request.seed");
  });

  test("omits features when none are given and --json prints the plan", async () => {
    const { requests, deps } = fakeRuntime(() => PLAN);
    expect(await handleApiCommand(["explain", "--inbound", "messages", "--model", "m1", "--json"], deps)).toBe(0);
    expect(requests[0]!.body).toEqual({ model: "m1", inbound: "messages" });
    expect(JSON.parse(printed())).toEqual(PLAN);
  });

  test.each([
    ["a missing model", ["explain", "--inbound", "chat"]],
    ["a missing inbound", ["explain", "--model", "m1"]],
    ["an unknown inbound", ["explain", "--model", "m1", "--inbound", "anthropic"]],
    ["an unknown feature", ["explain", "--model", "m1", "--inbound", "chat", "--feature", "request.bogus"]],
  ])("%s is usage (exit 2) and sends nothing", async (_label, argv) => {
    const { requests, deps } = fakeRuntime(() => PLAN);
    expect(await handleApiCommand(argv, deps)).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe("ocx api policy", () => {
  test("a bare invocation reads and never writes", async () => {
    const { requests, deps } = fakeRuntime();
    expect(await handleApiCommand(["policy"], deps)).toBe(0);
    expect(requests.map(r => [r.method, r.url])).toEqual([["GET", "http://127.0.0.1:9/api/protocols"]]);
  });

  test("setting flags send exactly one PATCH with the matching body", async () => {
    const { requests, deps } = fakeRuntime();
    const argv = ["policy", "--messages", "off", "--unrepresentable", "reject",
      "--rollout", "shadowPlan=on", "--rollout", "directEncoders=off"];
    expect(await handleApiCommand(argv, deps)).toBe(0);
    expect(requests).toEqual([{
      url: "http://127.0.0.1:9/api/protocols/settings",
      method: "PATCH",
      body: {
        messagesEnabled: false,
        unrepresentable: "reject",
        rollout: { shadowPlan: true, directEncoders: false },
      },
      contentType: "application/json",
    }]);
    expect(printed()).toContain("Protocol settings updated.");
  });

  test("--json prints the server's answer", async () => {
    const { deps } = fakeRuntime();
    expect(await handleApiCommand(["policy", "--rollout", "shadowPlan=off", "--json"], deps)).toBe(0);
    expect(JSON.parse(printed())).toEqual(INFO);
  });

  test.each([
    ["a non on/off Messages value", ["policy", "--messages", "maybe"]],
    ["an unknown unrepresentable policy", ["policy", "--unrepresentable", "drop"]],
    ["a rollout switch without a value", ["policy", "--rollout", "shadowPlan"]],
    ["a rollout value other than on/off", ["policy", "--rollout", "shadowPlan=true"]],
    ["the same switch twice", ["policy", "--rollout", "shadowPlan=on", "--rollout", "shadowPlan=off"]],
    ["a stray argument", ["policy", "on"]],
  ])("%s is usage (exit 2) and sends nothing", async (_label, argv) => {
    const { requests, deps } = fakeRuntime();
    expect(await handleApiCommand(argv, deps)).toBe(2);
    expect(requests).toEqual([]);
  });

  test("an unknown or missing api subcommand is usage", async () => {
    const { requests, deps } = fakeRuntime();
    expect(await handleApiCommand(["plan"], deps)).toBe(2);
    expect(await handleApiCommand([], deps)).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe("protocol routes are verbed, not exempt", () => {
  const PROTOCOL_ROUTES = MANAGEMENT_ROUTES.filter(route => route.module === "server/management/protocol-routes");

  test("every protocol route is declared without an exemption and driven by an api capability", () => {
    expect(PROTOCOL_ROUTES.length).toBeGreaterThan(0);
    for (const route of PROTOCOL_ROUTES) {
      expect(route.exempt, `${route.method} ${route.path}`).toBeUndefined();
      const drivers = capabilitiesForRoute(route.path)
        .filter(cap => cap.routes.some(r => r.method === route.method && r.path === route.path));
      expect(drivers.map(cap => cap.command[0]), `${route.method} ${route.path}`).toContain("api");
    }
  });

  test("the api capabilities are registered commands with a runner, and only policy mutates", () => {
    expect(findCommand("api")?.name).toBe("api");
    expect(DISPATCH_COMMANDS.has("api")).toBe(true);
    const api = CAPABILITIES.filter(cap => cap.command[0] === "api");
    expect(api.map(cap => [cap.command.join(" "), cap.mutates])).toEqual([
      ["api protocols", false],
      ["api explain", false],
      ["api policy", true],
    ]);
  });
});
