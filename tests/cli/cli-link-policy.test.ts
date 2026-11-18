import { describe, expect, test } from "bun:test";
import { runLinkCommand, type LinkCliDeps } from "../../src/cli/link";
import { LOOPBACK_REQUIRED_MESSAGE, OLD_HOME_MESSAGE, RUNTIME_ROLE_CLIENT_MESSAGE } from "../../src/cli/link-child-ops";

const DEFAULTS = { catalogFanout: "auto", childCodexRestart: "never", updates: "auto-when-idle", idleAfterMs: 600_000 };
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
  try { return { code: await runLinkCommand(["policy", ...args], d.value), stdout, stderr }; }
  finally { console.log = log; console.error = error; }
}

describe("ocx link policy", () => {
  test("without flags it reads the policy and prints one line per knob", async () => {
    const d = deps(() => ({ body: { policy: DEFAULTS, warning: null } }));
    const result = await run([], d);
    expect(result.code).toBe(0);
    expect(d.calls).toEqual([{ url: "http://127.0.0.1:19101/api/link/children/policy", method: "GET", body: null }]);
    expect(result.stdout).toEqual(["catalog fan-out: auto", "Child Codex restart: never", "updates: auto-when-idle", "idle after: 10 min"]);
  });

  test("flags send one PUT with only those keys; --json prints the document", async () => {
    const d = deps(call => ({ body: { policy: { ...DEFAULTS, ...JSON.parse(call.body ?? "{}") }, warning: null } }));
    const result = await run(["--updates", "notify", "--catalog-fanout", "manual", "--child-codex-restart", "app-server-when-idle", "--idle-after-minutes", "15", "--json"], d);
    expect(result.code).toBe(0);
    expect(d.calls.map(call => call.method)).toEqual(["PUT"]);
    expect(JSON.parse(d.calls[0]!.body!)).toEqual({ updates: "notify", catalogFanout: "manual", childCodexRestart: "app-server-when-idle", idleAfterMs: 900_000 });
    expect(JSON.parse(result.stdout.join("\n"))).toEqual({ policy: { catalogFanout: "manual", childCodexRestart: "app-server-when-idle", updates: "notify", idleAfterMs: 900_000 }, warning: null });
  });

  test("an invalid policy file is reported", async () => {
    const d = deps(() => ({ body: { policy: { ...DEFAULTS, catalogFanout: "manual", updates: "off" }, warning: "policy-file-invalid" } }));
    const result = await run([], d);
    expect(result.code).toBe(0);
    expect(result.stdout.at(-1)).toBe("The policy file is invalid; automatic catalog fan-out and updates are off. To turn them back on, pass --catalog-fanout auto and an --updates mode; a setting you do not name stays off.");
  });

  test.each([
    [["--idle-after-minutes", "0"]], [["--idle-after-minutes", "61"]], [["--updates", "sometimes"]], [["--catalog-fanout", "AUTO"]],
    [["--child-codex-restart", "always"]], [["--unknown"]],
  ])("usage error %p exits 2 and sends nothing", async args => {
    const d = deps(() => ({ body: {} }));
    expect((await run(args, d)).code).toBe(2);
    expect(d.calls).toEqual([]);
  });

  test("an invalid response exits 1", async () => {
    for (const body of [{ policy: DEFAULTS }, { policy: { ...DEFAULTS, updates: "later" }, warning: null }, { policy: { ...DEFAULTS, extra: 1 }, warning: null },
      { policy: DEFAULTS, warning: "other" }, { policy: { ...DEFAULTS, idleAfterMs: "600000" }, warning: null }]) {
      expect((await run([], deps(() => ({ body })))).code).toBe(1);
    }
  });

  test("refusals: an older Home, a Child runtime, a Home not bound to loopback", async () => {
    const old = await run(["--updates", "off"], deps(() => ({ status: 404, body: { error: { code: "not_found", message: "Not found." } } })));
    expect(old.code).toBe(4);
    expect(old.stderr.join("\n")).toContain(OLD_HOME_MESSAGE);
    const child = await run(["--updates", "off"], deps(() => ({ status: 409, body: { error: { code: "runtime_role_client", message: "x" } } })));
    expect(child.code).toBe(5);
    expect(child.stderr.join("\n")).toContain(RUNTIME_ROLE_CLIENT_MESSAGE);
    const remote = await run([], deps(() => ({ status: 403, body: { error: { code: "forbidden", message: "x" } } })));
    expect(remote.code).toBe(1);
    expect(remote.stderr.join("\n")).toContain(LOOPBACK_REQUIRED_MESSAGE);
  });
});
