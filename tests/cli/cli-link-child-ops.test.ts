import { describe, expect, spyOn, test } from "bun:test";
import { runLinkCommand } from "../../src/cli/link";
import { CHILD_ITEM_WAIT_MS, LOOPBACK_REQUIRED_MESSAGE, OLD_HOME_MESSAGE, linkCheckExitCode, validateChildJob,
  type LinkCheckDeps } from "../../src/cli/link-child-ops";
import { runCapabilities } from "../../src/cli/capabilities-command";

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

type Item = { state: string; reason?: string | null } & Record<string, unknown>;
function job(op: string, state: "queued" | "running" | "done", items: Item[], extra: Record<string, unknown> = {}) {
  return { schema: "ocx.link.child-job/1", jobId: JOB, op, trigger: "manual", restart: "none", state, createdAt: "2026-11-11T00:00:00.000Z",
    finishedAt: state === "done" ? "2026-11-11T00:00:05.000Z" : null, ...extra,
    items: items.map(({ state: itemState, reason, ...rest }) => ({ linkId: LINK, alias: "child-a", state: itemState, reason: reason ?? null,
      startedAt: null, finishedAt: itemState === "queued" || itemState === "running" ? null : "2026-11-11T00:00:05.000Z", ...rest })) };
}

/** POST answers post(); every job GET answers the next of polls (the last repeats). */
function deps(post: () => { status?: number; body: unknown }, polls: unknown[] = [], extra: Partial<LinkCheckDeps> = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...polls];
  const value: LinkCheckDeps = {
    baseUrl: "http://127.0.0.1:19101",
    readAdminToken: () => "ocx_admin_test-token",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null };
      calls.push(call);
      const answer = call.method === "POST" ? post() : { status: 200, body: { job: queue.length > 1 ? queue.shift() : queue[0] } };
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    sleep: async ms => { sleeps.push(ms); },
    ...extra,
  };
  return { value, calls, sleeps };
}
const accepted = (body: unknown) => () => ({ status: 202, body: { job: body } });

async function run(args: string[], d: ReturnType<typeof deps>) {
  const output = capture();
  try {
    const code = await runLinkCommand(args, d.value);
    return { code, stdout: output.stdout, stderr: output.stderr };
  } finally { output.restore(); }
}

describe("ocx link update|sync|restart-codex arguments", () => {
  test.each([
    [["update", "--yes"]],
    [["update", "--all", "--link-id", LINK, "--yes"]],
    [["update", "--link-id", "lnk_bad", "--yes"]],
    [["update", "--link-id", LINK]],
    [["update", "--all"]],
    [["sync", "--link-id", LINK, "--restart-app-server-only", "--restart-codex", "--yes"]],
    [["sync", "--all", "--restart-app-server-only"]],
    [["sync", "--link-id", LINK, "--link-id", OTHER, "--restart-app-server-only"]],
    [["sync", "--link-id", LINK, "--restart-codex"]],
    [["sync", "--link-id", LINK, "--yes"]],
    [["restart-codex", "--link-id", LINK]],
    [["restart-codex", "--all", "--yes"]],
    [["restart-codex", "--link-id", LINK, "--scope", "foo", "--yes"]],
    [["restart-codex", "--link-id", LINK, "--link-id", OTHER, "--yes"]],
    [["sync", "--link-id", LINK, "stray"]],
  ])("%j is a usage error with no request", async args => {
    const d = deps(accepted(job("sync", "done", [{ state: "succeeded" }])));
    expect((await run(args, d)).code).toBe(2);
    expect(d.calls).toEqual([]);
  });

  test("bodies", async () => {
    const cases: Array<[string[], unknown]> = [
      [["update", "--link-id", LINK, "--link-id", OTHER, "--yes"], { op: "update", linkIds: [LINK, OTHER] }],
      [["update", "--all", "--yes"], { op: "update", linkIds: "all" }],
      [["sync", "--all"], { op: "sync", linkIds: "all" }],
      [["sync", "--link-id", LINK, "--link-id", OTHER], { op: "sync", linkIds: [LINK, OTHER] }],
      [["sync", "--link-id", LINK, "--restart-app-server-only"], { op: "sync", linkIds: [LINK], restart: "app-server" }],
      [["sync", "--link-id", LINK, "--restart-codex", "--yes"], { op: "sync", linkIds: [LINK], restart: "codex" }],
      [["restart-codex", "--link-id", LINK, "--yes"], { op: "restart-codex", linkIds: [LINK], restart: "app-server" }],
      [["restart-codex", "--link-id", LINK, "--scope", "codex", "--yes", "--json"], { op: "restart-codex", linkIds: [LINK], restart: "codex" }],
    ];
    for (const [args, body] of cases) {
      const d = deps(accepted(job("sync", "done", [{ state: "succeeded" }])));
      expect((await run([...args, "--no-wait"], d)).code).toBe(0);
      expect(JSON.parse(d.calls[0]!.body!)).toEqual(body);
    }
  });
});

describe("ocx link child operation results", () => {
  test("--no-wait prints the queued job and does not poll; the default polls until done", async () => {
    const queued = job("sync", "queued", [{ state: "queued" }]);
    const quick = deps(accepted(queued));
    const noWait = await run(["sync", "--link-id", LINK, "--no-wait"], quick);
    expect(noWait.code).toBe(0);
    expect(quick.calls).toHaveLength(1);
    expect(JSON.parse(noWait.stdout[0]!)).toMatchObject({ state: "queued" });
    const waiting = deps(accepted(queued), [job("sync", "running", [{ state: "running" }]), job("sync", "done", [{ state: "succeeded" }])]);
    const waited = await run(["sync", "--link-id", LINK], waiting);
    expect(waited.code).toBe(0);
    expect(waiting.calls.map(call => call.method + " " + new URL(call.url).pathname)).toEqual(["POST /api/link/children/operations",
      "GET /api/link/children/jobs/" + JOB, "GET /api/link/children/jobs/" + JOB]);
    expect(waiting.sleeps).toEqual([2_000, 2_000]);
  });

  test.each([
    ["every item succeeded", [{ state: "succeeded" }, { state: "up-to-date" }], 0],
    ["a restart that went out", [{ state: "succeeded", restart: { requested: "app-server", outcome: "requested" } }], 0],
    ["owner-action", [{ state: "succeeded" }, { state: "owner-action", reason: "legacy-ocx" }], 6],
    ["a withheld restart", [{ state: "succeeded", reason: "restart-skipped:link-active", restart: { requested: "app-server", outcome: "skipped" } }], 6],
    ["a kept update whose sync failed", [{ state: "succeeded", reason: "post-update-sync-failed" }], 6],
    ["a restart reported unsupported", [{ state: "succeeded", restart: { requested: "app-server", outcome: "unsupported" } }], 6],
    ["a busy restart", [{ state: "busy", reason: "restart-skipped:link-active" }], 6],
    ["an uncertain item", [{ state: "succeeded" }, { state: "uncertain", reason: "restart-result-unknown" }], 1],
    ["a failed item", [{ state: "failed", reason: "rolled-back" }], 1],
    ["an unknown item state", [{ state: "deferred" }], 1],
  ] as const)("%s", async (_name, items, exit) => {
    const d = deps(accepted(job("update", "done", items as unknown as Item[])));
    expect((await run(["update", "--all", "--yes"], d)).code).toBe(exit);
  });

  test("a document from a later Home validates: unknown keys dropped, restart.requested and an unknown outcome kept", async () => {
    const later = job("sync", "done", [{ state: "succeeded", restart: { requested: "app-server", outcome: "deferred", future: 1 }, unknownItemKey: true }], { policy: {} });
    const d = deps(accepted(later));
    const result = await run(["sync", "--link-id", LINK, "--restart-app-server-only"], d);
    expect(result.code).toBe(6);
    expect(JSON.parse(result.stdout[0]!).items[0].restart).toEqual({ requested: "app-server", outcome: "deferred" });
    expect(validateChildJob(later).items[0]).not.toHaveProperty("unknownItemKey");
    for (const broken of [{ ...later, jobId: 7 }, { ...later, items: {} }, { ...later, schema: "ocx.link.child-job/2" }]) {
      expect((await run(["sync", "--link-id", LINK], deps(accepted(broken)))).code).toBe(1);
    }
  });

  test("refusals: 409 exits 5, an older Home exits 4 with the update message, link_not_found keeps the route's", async () => {
    expect((await run(["sync", "--link-id", LINK], deps(() => ({ status: 409, body: { error: { code: "link_operation_in_progress", message: "x" } } })))).code).toBe(5);
    const noRoute = await run(["update", "--all", "--yes"], deps(() => ({ status: 404, body: { error: "not found" } })));
    expect(noRoute.code).toBe(4);
    expect(noRoute.stderr[0]).toBe("Error: " + OLD_HOME_MESSAGE);
    const missing = await run(["sync", "--link-id", LINK], deps(() => ({ status: 404, body: { error: { code: "link_not_found", message: "x" } } })));
    expect(missing.code).toBe(4);
    expect(missing.stderr[0]).not.toContain(OLD_HOME_MESSAGE);
    const lost = await run(["sync", "--link-id", LINK], deps(accepted(job("sync", "running", [{ state: "running" }])),
      [{ error: { code: "job_not_found", message: "The job was not found." } }], {
        fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
          ? new Response(JSON.stringify({ job: job("sync", "running", [{ state: "running" }]) }), { status: 202 })
          : new Response(JSON.stringify({ error: { code: "job_not_found", message: "The job was not found." } }), { status: 404 })) as typeof fetch,
      }));
    expect(lost.code).toBe(4);
  });

  test("Revision 6 F3: a Home that only observes answers 400 invalid_body; update and sync name the older Home", async () => {
    for (const args of [["update", "--link-id", LINK, "--yes"], ["sync", "--all"]]) {
      const old = await run(args, deps(() => ({ status: 400, body: { error: { code: "invalid_body", message: "The body must be exactly {op:\"observe\", linkIds}." } } })));
      expect(old.code).toBe(4);
      expect(old.stderr[0]).toBe("Error: " + OLD_HOME_MESSAGE);
    }
  });

  test("a Home not bound to loopback answers 403: the CLI names the dashboard and exits 1", async () => {
    for (const args of [["sync", "--link-id", LINK], ["check", "--all"]]) {
      const result = await run(args, deps(() => ({ status: 403, body: { error: { code: "admin_loopback_required", message: "x" } } })));
      expect(result.code).toBe(1);
      expect(result.stderr[0]).toBe("Error: " + LOOPBACK_REQUIRED_MESSAGE);
    }
  });
});

describe("wait deadline (Revision 5, carried item b)", () => {
  test("time spent queued spends no budget", async () => {
    let clock = 0;
    const polls = [...Array.from({ length: 20 }, () => job("sync", "running", [{ state: "queued" }])), job("sync", "running", [{ state: "running" }]),
      job("sync", "done", [{ state: "succeeded" }])];
    const d = deps(accepted(job("sync", "queued", [{ state: "queued" }])), polls, { now: () => clock, sleep: async () => { clock += 60_000; } });
    expect((await run(["sync", "--link-id", LINK], d)).code).toBe(0);
  });

  test("a running sync item gets its 420 s budget plus 30 s from the last queued poll, an update 2 100 s", async () => {
    for (const [verb, extra, budget] of [["sync", [], CHILD_ITEM_WAIT_MS.sync], ["update", ["--yes"], CHILD_ITEM_WAIT_MS.update]] as const) {
      let clock = 0;
      const d = deps(accepted(job(verb, "running", [{ state: "running" }])), [job(verb, "running", [{ state: "running" }])],
        { now: () => clock, sleep: async () => { clock += 10_000; } });
      const result = await run([verb, "--link-id", LINK, ...extra], d);
      expect(result.code).toBe(1);
      expect(result.stderr.join("\n")).toContain("job_still_running");
      expect(clock).toBe(budget + 30_000);
    }
  });

  test("a job queued forever stops at the 3 h cap", async () => {
    let clock = 0;
    const d = deps(accepted(job("sync", "queued", [{ state: "queued" }])), [job("sync", "queued", [{ state: "queued" }])],
      { now: () => clock, sleep: async () => { clock += 600_000; } });
    const result = await run(["sync", "--link-id", LINK], d);
    expect(result.code).toBe(1);
    expect(clock).toBe(10_800_000);
  });
});

describe("contract", () => {
  test("linkCheckExitCode reads the restart outcome, not only the state", () => {
    expect(linkCheckExitCode(validateChildJob(job("sync", "done", [{ state: "succeeded", restart: { requested: "codex", outcome: "not-run" } }])))).toBe(6);
  });

  test("ocx capabilities --json lists link.child-ops/1", async () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runCapabilities(["--json"])).toBe(0);
      const document = JSON.parse(String(out.mock.calls[0]![0])) as { contracts: string[]; capabilities: Array<{ command: string[] }> };
      expect(document.contracts).toContain("link.child-ops/1");
      for (const verb of ["update", "sync", "restart-codex"]) expect(document.capabilities.some(entry => entry.command.join(" ") === "link " + verb)).toBe(true);
    } finally { out.mockRestore(); }
  });
});

describe("CodeRabbit 4532654426 / 4532654389: messages an operator can act on", () => {
  test("a Home not bound to loopback: the message states the limit and offers no dashboard path", async () => {
    const result = await run(["update", "--link-id", LINK, "--yes"], deps(() => ({ status: 403, body: { error: { code: "admin_loopback_required", message: "x" } } })));
    expect(result.code).toBe(1);
    expect(result.stderr[0]).toBe("Error: Child operations from the CLI need a Home bound to loopback; on this Home they are not available, and the dashboard has no controls for them.");
  });

  test("each exit-5 conflict names its cause", async () => {
    const cases: Array<[string, string]> = [
      ["link_not_home_initiated", "This link was started from the Child, so the Home cannot run operations on it."],
      ["link_operation_in_progress", "Another operation is running on this link; wait for it to finish, then try again."],
      ["no_eligible_links", "This Home has no links."],
      ["runtime_role_client", "This machine is a Child; run Child operations on its Home."],
    ];
    for (const [code, message] of cases) {
      const result = await run(["sync", "--link-id", LINK], deps(() => ({ status: 409, body: { error: { code, message: "x" } } })));
      expect(result.code).toBe(5);
      expect(result.stderr[0]).toBe("Error: " + message);
    }
  });
});

