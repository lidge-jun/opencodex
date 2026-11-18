import { expect, test } from "bun:test";
import { runLinkCommand } from "../../src/cli/link";
const row = { id: "lnk_0123456789abcdef", alias: "child", direction: "client-initiated", state: "connected", since: "2026-11-07T00:00:00.000Z", reason: null, tunnelPort: 19200,
  lastApplyAt: null, runtimeStartedAt: 1794000000000, appliedCodexSettingsDigest: null, reportedAt: 1794000001000,
  appliedRouteIntentDigest: "a".repeat(64), routeClientOutcomes: [
    { client: "aside", outcome: "current", source: "local", target: "u0,u1", message: "private-fixture-diagnostic" },
    { client: "pi", outcome: "failed", target: "/fixture/private/pi/models.json", message: "private-fixture-failure" },
  ] };
test("link status JSON carries digest and sanitized per-client outcomes", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  let code: number;
  try {
    code = await runLinkCommand(["status", "--json"], { baseUrl: "http://127.0.0.1:19101", readAdminToken: () => "test-token",
      fetchImpl: (async () => Response.json({ role: "home", listener: { state: "listening", port: 19100 }, links: [row], child: null })) as typeof fetch });
  } finally { console.log = log; }
  expect(code!).toBe(0);
  expect(JSON.parse(lines[0]!).links[0]).toEqual({ ...row, routeClientOutcomes: [
    { client: "aside", outcome: "current", source: "local", target: "u0,u1" }, { client: "pi", outcome: "failed" },
  ] });
  expect(lines[0]).not.toContain("private-fixture");
  expect(lines[0]).not.toContain("/fixture/private");
});
