import { describe, expect, test } from "bun:test";
import { handleObserveCommand } from "../../src/cli/observe";

/**
 * #4057: `ocx logs` gained an `--account` filter so an operator running several accounts behind
 * one provider can ask "which requests did this account serve?" without grepping usage.jsonl.
 *
 * The filter is applied SERVER-side, so these tests assert the query string rather than the rows:
 * filtering client-side after the row cap would silently hide older matches, and a test that only
 * checked the printed output would pass either way.
 */
describe("ocx logs --account", () => {
  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    return { lines, restore: () => { console.log = original; } };
  }

  test("sends the account label to /api/logs alongside the other filters", async () => {
    const paths: string[] = [];
    const captured = capture();
    try {
      const code = await handleObserveCommand(["logs", "--account", "p3f9a1", "--provider", "openai", "--limit", "5"], {
        baseUrl: "http://cli.test",
        fetchImpl: async input => {
          paths.push(String(input).replace("http://cli.test", ""));
          return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      expect(code).toBe(0);
    } finally {
      captured.restore();
    }
    expect(paths).toHaveLength(1);
    const query = new URLSearchParams(paths[0]!.split("?")[1] ?? "");
    expect(query.get("account")).toBe("p3f9a1");
    expect(query.get("provider")).toBe("openai");
    expect(query.get("limit")).toBe("5");
  });

  test("omits the parameter entirely when no account is requested", async () => {
    const paths: string[] = [];
    const captured = capture();
    try {
      await handleObserveCommand(["logs"], {
        baseUrl: "http://cli.test",
        fetchImpl: async input => {
          paths.push(String(input).replace("http://cli.test", ""));
          return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        },
      });
    } finally {
      captured.restore();
    }
    expect(new URLSearchParams(paths[0]!.split("?")[1] ?? "").has("account")).toBe(false);
  });

  test("human output names the account so a filtered result is distinguishable from an empty one", async () => {
    const rows = [
      { id: 1, timestamp: "2026-01-01T00:00:00.000Z", provider: "openai", model: "gpt-test", status: 200, durationMs: 12, accountLogLabel: "p3f9a1" },
      { id: 2, timestamp: "2026-01-01T00:00:01.000Z", provider: "xai", model: "grok-4.6", status: 200, durationMs: 9 },
    ];
    const captured = capture();
    try {
      await handleObserveCommand(["logs"], {
        baseUrl: "http://cli.test",
        fetchImpl: async () => new Response(JSON.stringify({ logs: rows }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      });
    } finally {
      captured.restore();
    }
    expect(captured.lines).toHaveLength(2);
    expect(captured.lines[0]).toContain("acct=p3f9a1");
    // A provider with a single account stamps no label; the column is absent rather than blank.
    expect(captured.lines[1]).not.toContain("acct=");
  });
});
