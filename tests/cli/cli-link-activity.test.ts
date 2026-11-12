import { describe, expect, test } from "bun:test";
import { runLinkCommand, type LinkCliDeps } from "../../src/cli/link";
import { RUNTIME_ROLE_CLIENT_MESSAGE, parseChildOpArgs, validateChildJob } from "../../src/cli/link-child-ops";
import { CliUsageError } from "../../src/cli/runtime-api";
import { validateChildOps, validateLinkWs } from "../../src/cli/link-status-child";

// Lane T5d3a: `ocx link activity clear` and the holds a status row carries (owner decision D8).

const LINK = "lnk_0123456789abcdef";
type Call = { url: string; method: string; body: string | null };

function deps(answer: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const value: LinkCliDeps = {
    baseUrl: "http://127.0.0.1:19101",
    readAdminToken: () => "ocx_admin_test-token",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null };
      calls.push(call);
      const { status, body } = answer(call);
      return new Response(JSON.stringify(body), { status: status ?? 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  };
  return { value, calls };
}

async function run(args: string[], d: ReturnType<typeof deps>) {
  const stdout: string[] = [], stderr: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...parts: unknown[]) => { stdout.push(parts.map(String).join(" ")); };
  console.error = (...parts: unknown[]) => { stderr.push(parts.map(String).join(" ")); };
  try { return { code: await runLinkCommand(["activity", ...args], d.value), stdout, stderr }; }
  finally { console.log = log; console.error = error; }
}

const CLEARED = { holds: [{ since: 1, reasons: ["running-unknown"], pendingResults: 0, runningTurns: 0, runningUnknown: 1 }], unknown: "crash" };

describe("ocx link activity clear", () => {
  test("sends exactly {linkId} and says what was cleared", async () => {
    const d = deps(() => ({ body: { linkId: LINK, cleared: CLEARED } }));
    const result = await run(["clear", "--link-id", LINK], d);
    expect(result.code).toBe(0);
    expect(d.calls).toEqual([{ url: "http://127.0.0.1:19101/api/link/children/activity/clear", method: "POST", body: JSON.stringify({ linkId: LINK }) }]);
    expect(result.stdout).toEqual([`Cleared 1 activity hold and the unknown state (crash) on ${LINK}; automatic and activity-gated restarts of this Child may run again.`]);
  });

  test("--json prints the document; a link with nothing held says so", async () => {
    const json = await run(["clear", "--link-id", LINK, "--json"], deps(() => ({ body: { linkId: LINK, cleared: CLEARED } })));
    expect(JSON.parse(json.stdout.join("\n"))).toEqual({ linkId: LINK, cleared: CLEARED });
    const none = await run(["clear", "--link-id", LINK], deps(() => ({ body: { linkId: LINK, cleared: null } })));
    expect(none.stdout).toEqual([`Nothing held ${LINK}.`]);
  });

  test.each([[[]], [["clear"]], [["clear", "--link-id", "lnk_x"]], [["list", "--link-id", LINK]], [["clear", "--link-id", LINK, "--all"]]])(
    "usage error %p exits 2 and sends nothing", async args => {
      const d = deps(() => ({ body: {} }));
      expect((await run(args as string[], d)).code).toBe(2);
      expect(d.calls).toEqual([]);
    });

  test("refusals keep their exit codes and messages", async () => {
    const child = await run(["clear", "--link-id", LINK], deps(() => ({ status: 409, body: { error: { code: "runtime_role_client", message: "x" } } })));
    expect(child.code).toBe(5);
    expect(child.stderr.join("\n")).toContain(RUNTIME_ROLE_CLIENT_MESSAGE);
    expect((await run(["clear", "--link-id", LINK], deps(() => ({ status: 503, body: { error: { code: "activity_holds_write_failed", message: "x" } } })))).code).toBe(1);
    expect((await run(["clear", "--link-id", LINK], deps(() => ({ body: { linkId: "lnk_ffffffffffffffff", cleared: null } })))).code).toBe(1);
  });
});

describe("status: a row's child.holds", () => {
  const child = (extra: Record<string, unknown>) => ({
    homeVersion: "2.100.0", runningVersion: null, installedVersion: null, installKind: null, versionSkew: "unknown",
    update: { route: null, reason: null, observedAt: null }, catalog: { state: "unknown", pulledAt: null, homeChangedAt: null }, codex: null,
    activity: { idle: false, inFlight: 1, lastDataEndAt: null }, activeJob: null, lastOperation: null, ...extra,
  });

  test("absent stays absent; present passes through with unknown reasons read as unknown", () => {
    expect(validateChildOps(child({}), 0)).not.toHaveProperty("holds");
    const view = validateChildOps(child({ holds: { holds: [{ since: 5, reasons: ["pending-results", "future-reason"], pendingResults: 2, runningTurns: 0, runningUnknown: 0, extra: 1 }], unknown: null } }), 0);
    expect(view.holds).toEqual({ holds: [{ since: 5, reasons: ["pending-results", "unknown"], pendingResults: 2, runningTurns: 0, runningUnknown: 0 }], unknown: null });
  });

  test("a wrong type is rejected", () => {
    expect(() => validateChildOps(child({ holds: { holds: "many", unknown: null } }), 0)).toThrow("child holds");
    expect(() => validateChildOps(child({ holds: { holds: [], unknown: 3 } }), 0)).toThrow("child holds.unknown");
  });
});
describe("--ignore-activity (T5d3b)", () => {
  test("a restart on one link sends ignoreActivity: true", () => {
    expect(parseChildOpArgs("sync", ["--link-id", LINK, "--restart-app-server-only", "--ignore-activity"], "usage").body)
      .toEqual({ op: "sync", linkIds: [LINK], restart: "app-server", ignoreActivity: true });
    expect(parseChildOpArgs("restart-codex", ["--link-id", LINK, "--yes", "--ignore-activity"], "usage").body)
      .toEqual({ op: "restart-codex", linkIds: [LINK], restart: "app-server", ignoreActivity: true });
  });

  test.each([
    ["sync", ["--link-id", LINK, "--ignore-activity"]],
    ["sync", ["--all", "--restart-app-server-only", "--ignore-activity"]],
    ["update", ["--link-id", LINK, "--yes", "--ignore-activity"]],
  ] as const)("%s %p without a single-link restart is a usage error", (verb, args) => {
    expect(() => parseChildOpArgs(verb, [...args], "usage")).toThrow(CliUsageError);
  });

  test("without the flag the body is unchanged", () => {
    expect(parseChildOpArgs("sync", ["--link-id", LINK, "--restart-app-server-only"], "usage").body).toEqual({ op: "sync", linkIds: [LINK], restart: "app-server" });
  });

  test("the job document keeps ignoreActivity only when the Home set it", () => {
    const doc = { schema: "ocx.link.child-job/1", jobId: "ljob_0123456789abcdef", op: "sync", trigger: "manual", restart: "app-server", state: "done",
      createdAt: "2026-11-12T00:00:00.000Z", finishedAt: "2026-11-12T00:00:01.000Z", items: [] };
    expect(validateChildJob({ ...doc, ignoreActivity: true }).ignoreActivity).toBe(true);
    expect(validateChildJob(doc)).not.toHaveProperty("ignoreActivity");
    expect(() => validateChildJob({ ...doc, ignoreActivity: "yes" })).toThrow("job ignoreActivity");
  });
});
describe("ocx link status ws block (T5e2, design 9.3)", () => {
  test("the counters pass through; unknown reason keys are kept, wrong types are rejected", () => {
    const ws = { open: 1, upgrades: 2, refused: { cap: 1, "future-reason": 3 }, closes: { idle: 1 }, holds: 0 };
    expect(validateLinkWs(ws, 0)).toEqual(ws);
    for (const bad of [null, { ...ws, open: -1 }, { ...ws, refused: [] }, { ...ws, closes: { idle: "1" } }, { ...ws, holds: 1.5 }]) {
      expect(() => validateLinkWs(bad, 0)).toThrow("link 0 ws");
    }
  });

  test("ocx link status asks for transport=1 and prints the block", async () => {
    const row = { id: LINK, alias: "a", direction: "client-initiated", state: "connected", since: "2026-11-12T00:00:00.000Z", reason: null, tunnelPort: 2222,
      ws: { open: 1, upgrades: 1, refused: {}, closes: {}, holds: 0 } };
    const d = deps(() => ({ body: { role: "home", listener: { state: "listening", port: 19100 }, links: [row], child: null } }));
    const stdout: string[] = [];
    const log = console.log;
    console.log = (...parts: unknown[]) => { stdout.push(parts.map(String).join(" ")); };
    let code: number;
    try { code = await runLinkCommand(["status", "--json"], d.value); } finally { console.log = log; }
    expect(code).toBe(0);
    expect(d.calls[0]!.url).toBe("http://127.0.0.1:19101/api/link/status?compatibility=1&diagnostics=1&children=1&transport=1&traffic=1&routes=1");
    expect(JSON.parse(stdout[0]!).links[0].ws).toEqual(row.ws);
  });
});
