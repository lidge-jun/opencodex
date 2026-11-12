import { describe, expect, test } from "bun:test";
import { runLinkCommand } from "../../src/cli/link";
import { LOOPBACK_REQUIRED_MESSAGE, NO_ELIGIBLE_LINKS_MESSAGE, OLD_HOME_MESSAGE, RUNTIME_ROLE_CLIENT_MESSAGE, validateChildJob } from "../../src/cli/link-child-ops";
import type { LinkCheckDeps } from "../../src/cli/link-child-ops";

const LINK = "lnk_0123456789abcdef";
const OTHER = "lnk_fedcba9876543210";
const JOB = "ljob_0123456789abcdef";

type Call = { url: string; method: string; body: string | null };

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
  return { stdout, stderr, restore() { console.log = log; console.error = error; } };
}

function job(state: "queued" | "running" | "done", items: Array<{ linkId?: string; state: string; reason?: string | null } & Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { schema: "ocx.link.child-job/1", jobId: JOB, op: "observe", trigger: "manual", restart: "none", state, createdAt: "2026-11-11T00:00:00.000Z",
    finishedAt: state === "done" ? "2026-11-11T00:00:05.000Z" : null, ...extra,
    items: items.map(({ linkId, state: itemState, reason, ...rest }) => ({ linkId: linkId ?? LINK, alias: "child-a", state: itemState, reason: reason ?? null,
      startedAt: null, finishedAt: null, ...rest })) };
}

function deps(routes: (call: Call) => { status?: number; body: unknown }, extra: Partial<LinkCheckDeps> = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const value: LinkCheckDeps = {
    baseUrl: "http://127.0.0.1:19101",
    readAdminToken: () => "ocx_admin_test-token",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null };
      calls.push(call);
      const answer = routes(call);
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    sleep: async ms => { sleeps.push(ms); },
    ...extra,
  };
  return { value, calls, sleeps };
}

async function run(args: string[], d: ReturnType<typeof deps>) {
  const output = capture();
  try {
    const code = await runLinkCommand(["check", ...args], d.value);
    return { code, stdout: output.stdout, stderr: output.stderr };
  } finally { output.restore(); }
}

describe("ocx link check", () => {
  test("usage errors exit 2", async () => {
    for (const args of [[], ["--all", "--link-id", LINK], ["--link-id", "lnk_bad"], ["--link-id"], ["--bogus", "--all"]]) {
      const d = deps(() => ({ body: {} }));
      expect((await run(args, d)).code).toBe(2);
      expect(d.calls).toEqual([]);
    }
  });

  test("exit mapping 0/6/1 from fake job documents", async () => {
    const cases: Array<[string[], number]> = [[["succeeded"], 0], [["up-to-date", "succeeded"], 0], [["succeeded", "owner-action"], 6],
      [["busy"], 6], [["offline"], 6], [["refused"], 6], [["unsupported"], 6], [["failed", "busy"], 1], [["uncertain"], 1], [["teleported"], 1]];
    for (const [states, expected] of cases) {
      const d = deps(() => ({ status: 202, body: { job: job("done", states.map(state => ({ state }))) } }));
      const result = await run(["--all"], d);
      expect({ states, code: result.code }).toEqual({ states, code: expected });
      expect(JSON.parse(result.stdout.at(-1)!).items.map((item: { state: string }) => item.state)).toEqual(states);
    }
  });

  test("posts the observe body and polls the job to done", async () => {
    let reads = 0;
    const d = deps(call => call.method === "POST"
      ? { status: 202, body: { job: job("running", [{ state: "running" }, { linkId: OTHER, state: "queued" }]) } }
      : { body: { job: ++reads < 2 ? job("running", [{ state: "succeeded" }, { linkId: OTHER, state: "running" }]) : job("done", [{ state: "succeeded" }, { linkId: OTHER, state: "succeeded" }]) } });
    const result = await run(["--link-id", LINK, "--link-id", OTHER, "--json"], d);
    expect(result.code).toBe(0);
    expect(d.calls[0]).toEqual({ url: "http://127.0.0.1:19101/api/link/children/operations", method: "POST", body: JSON.stringify({ op: "observe", linkIds: [LINK, OTHER] }) });
    expect(d.calls.slice(1).map(call => call.url)).toEqual([`http://127.0.0.1:19101/api/link/children/jobs/${JOB}`, `http://127.0.0.1:19101/api/link/children/jobs/${JOB}`]);
    expect(d.sleeps).toEqual([2_000, 2_000]);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!).state).toBe("done");
  });

  test("--no-wait prints the queued job", async () => {
    const d = deps(() => ({ status: 202, body: { job: job("queued", [{ state: "queued" }]) } }));
    const result = await run(["--all", "--no-wait"], d);
    expect(result.code).toBe(0);
    expect(d.calls).toHaveLength(1);
    expect(JSON.parse(d.calls[0]!.body!)).toEqual({ op: "observe", linkIds: "all" });
    expect(JSON.parse(result.stdout[0]!)).toMatchObject({ jobId: JOB, state: "queued" });
  });

  test("a job past its deadline prints the job and exits 1", async () => {
    let clock = 0;
    const d = deps(() => ({ status: 202, body: { job: job("running", [{ state: "running" }]) } }),
      { now: () => clock, sleep: async () => { clock += 60_000; } });
    const result = await run(["--link-id", LINK], d);
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("job_still_running");
    expect(JSON.parse(result.stdout[0]!).state).toBe("running");
    // ceil(1/3) × 120 s + 30 s = 150 s: three 60 s waits, then the deadline check fails.
    expect(d.calls).toHaveLength(4);
  });

  test("a check queued behind another job past wp2's 150 s budget still waits for its item", async () => {
    let clock = 0;
    let polls = 0;
    const d = deps(call => {
      if (call.method === "POST") return { status: 202, body: { job: job("queued", [{ state: "queued" }]) } };
      polls += 1;
      return { body: { job: polls < 6 ? job("running", [{ state: "queued" }]) : polls < 7 ? job("running", [{ state: "running" }]) : job("done", [{ state: "succeeded", finishedAt: "2026-11-11T00:10:00.000Z" }]) } };
    }, { now: () => clock, sleep: async () => { clock += 60_000; } });
    const result = await run(["--link-id", LINK], d);
    expect(result.code).toBe(0);
    expect(clock).toBeGreaterThan(150_000);
  });

  test("a Home not bound to loopback: 403 names the dashboard and exits 1", async () => {
    const result = await run(["--all"], deps(() => ({ status: 403, body: { error: { code: "admin_loopback_required", message: "x" } } })));
    expect(result.code).toBe(1);
    expect(result.stderr[0]).toBe(`Error: ${LOOPBACK_REQUIRED_MESSAGE}`);
  });

  test("old Home 404 message", async () => {
    const d = deps(() => ({ status: 404, body: { error: "not found" } }));
    const result = await run(["--all"], d);
    expect(result.code).toBe(4);
    expect(result.stderr[0]).toBe(`Error: ${OLD_HOME_MESSAGE}`);
  });

  test("a new Home's link_not_found keeps its own message; 409 exits 5", async () => {
    const missing = await run(["--link-id", LINK], deps(() => ({ status: 404, body: { error: { code: "link_not_found", message: "x" } } })));
    expect(missing.code).toBe(4);
    expect(missing.stderr[0]).toBe("Error: Link management request failed (404)");
    const busy = await run(["--link-id", LINK], deps(() => ({ status: 409, body: { error: { code: "link_operation_in_progress", message: "x" } } })));
    expect(busy.code).toBe(5);
  });

  test("other 409 answers carry an explicit message and still exit 5", async () => {
    const none = await run(["--all"], deps(() => ({ status: 409, body: { error: { code: "no_eligible_links", message: "x" } } })));
    expect(none.code).toBe(5);
    expect(none.stderr[0]).toBe(`Error: ${NO_ELIGIBLE_LINKS_MESSAGE}`);
    const child = await run(["--all"], deps(() => ({ status: 409, body: { error: { code: "runtime_role_client", message: "x" } } })));
    expect(child.code).toBe(5);
    expect(child.stderr[0]).toBe(`Error: ${RUNTIME_ROLE_CLIENT_MESSAGE}`);
  });

  test("job validator tolerance", () => {
    const later = job("done", [{ state: "succeeded", sync: { state: "synced", reason: null, extra: 1 }, restart: { outcome: "deferred-by-quantum", future: true },
      hint: "clock-skew", fromVersion: "2.97.0", toVersion: "2.100.0", unknownItemKey: "x" }], { policy: { auto: true } });
    const parsed = validateChildJob(later);
    expect(parsed).not.toHaveProperty("policy");
    expect(parsed.items[0]).toEqual({ linkId: LINK, alias: "child-a", state: "succeeded", reason: null, startedAt: null, finishedAt: null,
      hint: "clock-skew", fromVersion: "2.97.0", toVersion: "2.100.0", sync: { state: "synced", reason: null }, restart: { outcome: "deferred-by-quantum" } } as never);
    expect(validateChildJob(job("done", [{ state: "frozen" }])).items[0]?.state).toBe("frozen" as never);
    expect(() => validateChildJob({ ...job("done", []), items: {} })).toThrow(/items/);
    expect(() => validateChildJob({ ...job("done", []), jobId: 7 })).toThrow(/jobId/);
    expect(() => validateChildJob({ ...job("done", []), schema: "ocx.link.child-job/2" })).toThrow(/schema/);
    expect(() => validateChildJob(job("done", [{ state: "succeeded", restart: "yes" }]))).toThrow(/restart/);
  });
});

const statusRow = { id: LINK, alias: "child-a", direction: "hub-initiated", state: "connected", since: "2026-11-11T00:00:00.000Z", reason: null, tunnelPort: 41000 };
const childBlock = { homeVersion: "2.100.0", runningVersion: "2.97.0", installedVersion: "2.97.0", installKind: "bun", versionSkew: "behind",
  update: { route: "orchestrated", reason: null, observedAt: "2026-11-11T00:00:00.000Z" }, catalog: { state: "current", pulledAt: 5, homeChangedAt: 4 },
  codex: null, activity: { idle: true, inFlight: 0, lastDataEndAt: null }, activeJob: null,
  lastOperation: { op: "observe", jobId: JOB, state: "succeeded", reason: null, finishedAt: "2026-11-11T00:00:05.000Z" } };

async function status(body: unknown) {
  const d = deps(() => ({ body }));
  const output = capture();
  try {
    const code = await runLinkCommand(["status", "--json"], d.value);
    return { code, calls: d.calls, stdout: output.stdout };
  } finally { output.restore(); }
}

describe("ocx link status child block", () => {
  test("status sends children=1 and accepts the block's absence", async () => {
    const result = await status({ role: "home", listener: { state: "listening", port: 19100 }, links: [statusRow], child: null });
    expect(result.code).toBe(0);
    expect(result.calls[0]?.url).toBe("http://127.0.0.1:19101/api/link/status?compatibility=1&diagnostics=1&children=1");
    expect(JSON.parse(result.stdout[0]!).links[0]).not.toHaveProperty("child");
  });

  test("status validates child", async () => {
    const result = await status({ role: "home", listener: { state: "listening", port: 19100 }, links: [{ ...statusRow, child: childBlock }], child: null });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout[0]!).links[0].child).toEqual(childBlock);
  });

  test("a later Home's extra keys, codex object and new enum values are tolerated", async () => {
    const later = { ...childBlock, childBuild: "abc", installKind: "flatpak", versionSkew: "sideways", update: { ...childBlock.update, route: "teleport", extra: 1 },
      catalog: { ...childBlock.catalog, state: "partial" }, codex: { appServers: "hibernating", staleCount: 0, catalogMatchesHome: true, reportedAt: 9, futureField: "x" } };
    const result = await status({ role: "home", listener: { state: "listening", port: 19100 }, links: [{ ...statusRow, child: later }], child: null });
    expect(result.code).toBe(0);
    const child = JSON.parse(result.stdout[0]!).links[0].child;
    expect(child).not.toHaveProperty("childBuild");
    expect(child).toMatchObject({ installKind: "unknown", versionSkew: "unknown", update: { route: "unknown" }, catalog: { state: "unknown" },
      codex: { appServers: "unknown", staleCount: 0, catalogMatchesHome: true, reportedAt: 9 } });
    expect(child.update).not.toHaveProperty("extra");
    expect(child.codex).not.toHaveProperty("futureField");
  });

  test("a known child key with the wrong type is rejected", async () => {
    for (const broken of [{ ...childBlock, activity: { ...childBlock.activity, inFlight: "1" } }, { ...childBlock, installKind: 3 },
      { ...childBlock, codex: { staleCount: -1 } }, { ...childBlock, update: null }]) {
      const result = await status({ role: "home", listener: { state: "listening", port: 19100 }, links: [{ ...statusRow, child: broken }], child: null });
      expect(result.code).toBe(1);
    }
  });
});
