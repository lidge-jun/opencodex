import { describe, expect, test } from "bun:test";
import { handleStorageCommand } from "../src/cli/storage";
import { handleInspectCommand, handleIntegrationCommand } from "../src/cli/inspect";

/**
 * wp7: the storage, inspect, and native-integration routes had no CLI caller at all.
 *
 * The assertions here are about REQUESTS, not sentences. Three of these verbs delete or move
 * operator data, and the property that matters is that an unconfirmed invocation issues no
 * mutating request -- a verb that prints "nothing was deleted" while having called the delete
 * route is the exact failure this file exists to catch.
 */
interface Call { method: string; path: string; body: unknown }

function harness(respond: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    calls.push({
      method: init?.method ?? "GET",
      path: parsed.pathname + parsed.search,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const { status = 200, json } = respond(calls[calls.length - 1]!);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, deps: { baseUrl: "http://cli.test", fetchImpl } };
}

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return { out, err, restore: () => { console.log = log; console.error = error; } };
}

const PREVIEW = { percent: 25, count: 3, bytes: 3 * 1024 * 1024, digest: "digest-abc", candidates: [{ relPath: "archived_sessions/a.jsonl", bytes: 1024 * 1024 }] };

describe("ocx storage cleanup", () => {
  test("without --yes it previews and issues NO mutating request", async () => {
    const { calls, deps } = harness(() => ({ json: PREVIEW }));
    const cap = capture();
    let code: number;
    try { code = await handleStorageCommand(["cleanup", "--percent", "25"], deps); } finally { cap.restore(); }

    expect(code).toBe(0);
    // Exactly one call, and it is the preview.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/api/storage/cleanup/preview");
    // The assertion that matters: the deleting route was never touched.
    expect(calls.some(c => c.path === "/api/storage/cleanup")).toBe(false);
    expect(cap.out.join("\n")).toContain("Nothing was deleted");
    expect(cap.out.join("\n")).toContain("archived_sessions/a.jsonl");
  });

  test("with --yes it previews FIRST and forwards that digest", async () => {
    const { calls, deps } = harness(call => call.path === "/api/storage/cleanup/preview"
      ? { json: PREVIEW }
      : { json: { ok: true, count: 3, bytes: PREVIEW.bytes } });
    const cap = capture();
    let code: number;
    try { code = await handleStorageCommand(["cleanup", "--percent", "25", "--yes"], deps); } finally { cap.restore(); }

    expect(code).toBe(0);
    expect(calls.map(c => c.path)).toEqual(["/api/storage/cleanup/preview", "/api/storage/cleanup"]);
    // The digest binds the run to the preview it was authorized against; the server rejects a
    // stale one with 409, so forwarding it is not optional politeness.
    expect(calls[1]?.body).toEqual({ percent: 25, mode: "quarantine", digest: "digest-abc" });
  });

  test("--mode permanent is forwarded, and an invalid mode never reaches the server", async () => {
    const ok = harness(call => call.path.endsWith("preview") ? { json: PREVIEW } : { json: { ok: true } });
    const cap = capture();
    try { await handleStorageCommand(["cleanup", "--percent", "10", "--mode", "permanent", "--yes"], ok.deps); } finally { cap.restore(); }
    expect(ok.calls[1]?.body).toMatchObject({ mode: "permanent" });

    const bad = harness(() => ({ json: PREVIEW }));
    const cap2 = capture();
    let code: number;
    try { code = await handleStorageCommand(["cleanup", "--percent", "10", "--mode", "nonsense", "--yes"], bad.deps); } finally { cap2.restore(); }
    expect(code).not.toBe(0);
    expect(bad.calls).toHaveLength(0);
  });

  test("a missing percent is refused locally rather than sent as NaN", async () => {
    const { calls, deps } = harness(() => ({ json: PREVIEW }));
    const cap = capture();
    let code: number;
    try { code = await handleStorageCommand(["cleanup", "--yes"], deps); } finally { cap.restore(); }
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("a preview with no digest refuses to run instead of sending an empty one", async () => {
    const { calls, deps } = harness(() => ({ json: { percent: 25, count: 0, bytes: 0 } }));
    const cap = capture();
    let code: number;
    try { code = await handleStorageCommand(["cleanup", "--percent", "25", "--yes"], deps); } finally { cap.restore(); }
    expect(code).not.toBe(0);
    expect(calls.some(c => c.path === "/api/storage/cleanup")).toBe(false);
  });
});

describe("ocx storage trash and policy", () => {
  test("trash list reads, and restore without --yes sends nothing", async () => {
    const list = harness(() => ({ json: { entries: [] } }));
    const cap = capture();
    try { await handleStorageCommand(["trash", "list"], list.deps); } finally { cap.restore(); }
    expect(list.calls[0]).toMatchObject({ method: "GET", path: "/api/storage/trash" });

    const restore = harness(() => ({ json: { ok: true } }));
    const cap2 = capture();
    let code: number;
    try { code = await handleStorageCommand(["trash", "restore", "batch-1"], restore.deps); } finally { cap2.restore(); }
    expect(code).not.toBe(0);
    expect(restore.calls).toHaveLength(0);
  });

  test("trash restore --yes targets the named entry", async () => {
    const { calls, deps } = harness(() => ({ json: { ok: true, count: 3 } }));
    const cap = capture();
    try { await handleStorageCommand(["trash", "restore", "batch-1", "--yes"], deps); } finally { cap.restore(); }
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/storage/trash/restore", body: { id: "batch-1" } });
  });

  test("policy run without --yes sends nothing", async () => {
    const { calls, deps } = harness(() => ({ json: { ok: true, started: true } }));
    const cap = capture();
    let code: number;
    try { code = await handleStorageCommand(["policy", "run"], deps); } finally { cap.restore(); }
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("policy set sends only the fields given, so it cannot enable implicitly", async () => {
    const { calls, deps } = harness(() => ({ json: { ok: true, policy: {} } }));
    const cap = capture();
    try { await handleStorageCommand(["policy", "set", "--percent", "40"], deps); } finally { cap.restore(); }
    expect(calls[0]?.method).toBe("PUT");
    // `enabled` is absent, which the server reads as "keep the stored value". Sending
    // `enabled: false` here would silently disable a policy the operator never mentioned.
    // The percent travels inside `target`: the PUT contract has no top-level `percent`, so
    // that shape was accepted, dropped, and left the stored target in place.
    expect(calls[0]?.body).toEqual({ target: { removeOldestPercent: 40 } });
  });

  test("--percent reaches the server in the shape the policy target actually reads", async () => {
    // A top-level `percent` round-trips as HTTP 200 while changing nothing:
    // `normalizeStorageCleanupPolicy` reads only `target`, so a policy still holding the
    // default 25% stayed at 25% after `--percent 10` reported success — cleanup remained
    // authorized to delete more than the operator asked for.
    const { calls, deps } = harness(() => ({ json: { ok: true, policy: {} } }));
    const cap = capture();
    try { await handleStorageCommand(["policy", "set", "--percent", "10"], deps); } finally { cap.restore(); }
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body).toEqual({ target: { removeOldestPercent: 10 } });
    expect(body).not.toHaveProperty("percent");
  });

  test("an out-of-range percent is still sent so the server can name the rejection", async () => {
    // Rejecting locally would duplicate the server's 1-100 vocabulary. A named 400 is a
    // refused write; the defect being fixed here was a silent accepted one.
    const { calls, deps } = harness(() => ({ json: { ok: true, policy: {} } }));
    const cap = capture();
    try { await handleStorageCommand(["policy", "set", "--percent", "0"], deps); } finally { cap.restore(); }
    expect(calls[0]?.body).toEqual({ target: { removeOldestPercent: 0 } });
  });

  test("policy set with no fields is refused rather than sent as an empty write", async () => {
    const { calls, deps } = harness(() => ({ json: { ok: true } }));
    const cap = capture();
    let code: number;
    try { code = await handleStorageCommand(["policy", "set"], deps); } finally { cap.restore(); }
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("ocx storage keeps its old meaning", () => {
  test("a bare invocation and a leading flag both read the report", async () => {
    // `ocx storage` and `ocx storage --json` were an alias of `observe storage` before this
    // module existed. A leading flag must not be parsed as a subcommand name.
    for (const argv of [[], ["--json"]]) {
      const { calls, deps } = harness(() => ({ json: { codexHome: "/tmp", total: { bytes: 1 } } }));
      const cap = capture();
      let code: number;
      try { code = await handleStorageCommand(argv, deps); } finally { cap.restore(); }
      expect(code).toBe(0);
      expect(calls[0]).toMatchObject({ method: "GET", path: "/api/storage" });
    }
  });

  test("codex-logs still reaches the log-guard route", async () => {
    // Doctor and the published Log Guard guides still tell the operator to run
    // `ocx storage codex-logs repair`. Treating that as an unknown subcommand
    // would make the documented recovery path exit 2.
    const { calls, deps } = harness(() => ({ json: { ok: true } }));
    const cap = capture();
    let code: number;
    try { code = await handleStorageCommand(["codex-logs", "status"], deps); } finally { cap.restore(); }
    expect(code).toBe(0);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/storage/codex-logs" });
  });
});

describe("ocx inspect", () => {
  test("star reads only, and says the CLI cannot star", async () => {
    const { calls, deps } = harness(() => ({ json: { state: "not-starred", repo: "o/r" } }));
    const cap = capture();
    try { await handleInspectCommand(["star"], deps); } finally { cap.restore(); }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    // No POST, ever: it spends the operator GitHub identity and requires a dashboard session.
    expect(calls.every(c => c.method === "GET")).toBe(true);
    expect(cap.out.join("\n")).toContain("only you can do it");
  });

  test("pacing scopes to one provider when named, and to all when not", async () => {
    const named = harness(() => ({ json: { provider: "xai" } }));
    const cap = capture();
    try { await handleInspectCommand(["pacing", "--name", "xai"], named.deps); } finally { cap.restore(); }
    expect(named.calls[0]?.path).toBe("/api/provider-request-pacing?name=xai");

    const all = harness(() => ({ json: {} }));
    const cap2 = capture();
    try { await handleInspectCommand(["pacing"], all.deps); } finally { cap2.restore(); }
    expect(all.calls[0]?.path).toBe("/api/provider-request-pacing");
  });

  test("client-config requires --client and never guesses one", async () => {
    const { calls, deps } = harness(() => ({ json: {} }));
    const cap = capture();
    let code: number;
    try { code = await handleInspectCommand(["client-config"], deps); } finally { cap.restore(); }
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("codex-prompt --text hits the text route and prints it verbatim", async () => {
    const { calls, deps } = harness(() => ({ json: "You are Codex." }));
    const cap = capture();
    try { await handleInspectCommand(["codex-prompt", "--text"], deps); } finally { cap.restore(); }
    expect(calls[0]?.path).toBe("/api/codex-prompt/text");
    expect(cap.out.join("\n")).toBe("You are Codex.");
  });
});

describe("ocx integration native", () => {
  const CLIENTS = { clients: [
    { clientId: "claude", state: "current", installed: true, desiredEnabled: true, configPath: "/c.json", disableBlocked: null },
    { clientId: "grok", state: "stale", installed: false, desiredEnabled: false, configPath: "/g.toml", disableBlocked: "in use" },
  ] };

  test("the list renders per-client state instead of an item count", async () => {
    // The shared flattener rendered this array as `clients: 2 item(s)`, discarding every
    // column the operator asked for.
    const { deps } = harness(() => ({ json: CLIENTS }));
    const cap = capture();
    try { await handleIntegrationCommand(["native", "list"], deps); } finally { cap.restore(); }
    const out = cap.out.join("\n");
    expect(out).not.toContain("item(s)");
    expect(out).toContain("claude");
    expect(out).toContain("grok");
    expect(out).toContain("stale");
    // A blocked disable explains why a toggle did not take effect, so it is never dropped.
    expect(out).toContain("disable blocked: in use");
  });

  test("a toggle PUTs the per-client route with a boolean", async () => {
    const { calls, deps } = harness(() => ({ json: { ok: true } }));
    const cap = capture();
    try { await handleIntegrationCommand(["native", "claude-desktop", "off"], deps); } finally { cap.restore(); }
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/native-integrations/claude-desktop",
      body: { enabled: false },
    });
  });

  test("an unknown client and a missing on/off are both refused locally", async () => {
    for (const argv of [["native", "emacs", "on"], ["native", "codex"], ["native", "codex", "maybe"]]) {
      const { calls, deps } = harness(() => ({ json: { ok: true } }));
      const cap = capture();
      let code: number;
      try { code = await handleIntegrationCommand(argv, deps); } finally { cap.restore(); }
      expect(code).not.toBe(0);
      expect(calls).toHaveLength(0);
    }
  });
});
