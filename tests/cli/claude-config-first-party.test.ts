import { expect, test } from "bun:test";
import { handleClaudeConfigCommand } from "../../src/cli/integrations";

for (const [value, expected] of [["on", true], ["off", false]] as const) {
  test(`--first-party ${value} sends only cliFirstParty`, async () => {
    const requests: unknown[] = [];
    const code = await handleClaudeConfigCommand(["set", "--first-party", value], {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      },
    });
    expect(code).toBe(0);
    expect(requests).toEqual([{ cliFirstParty: expected }]);
  });
}

test("--first-party off tells the operator when Claude Desktop keeps the shared proxy env", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    const code = await handleClaudeConfigCommand(["set", "--first-party", "off"], {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: async () => Response.json({ ok: true, warnings: ["shared_proxy_retained"] }),
    });
    expect(code).toBe(0);
  } finally {
    console.log = original;
  }
  expect(lines[0]).toBe("Claude Code settings updated.");
  expect(lines[1]).toContain("ocx claude desktop apply --gateway");
});

for (const args of [
  ["set", "--first-party", "maybe"],
  ["set", "--first-party", "on", "--system-env", "on"],
]) {
  test(`--first-party rejects invalid combination ${args.join(" ")}`, async () => {
    let requests = 0;
    const code = await handleClaudeConfigCommand(args, {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: async () => { requests++; return Response.json({ ok: true }); },
    });
    expect(code).not.toBe(0);
    expect(requests).toBe(0);
  });
}
