import { describe, expect, test } from "bun:test";
import { handleAccountAuthCommand } from "../../src/cli/account-auth";

interface Sent { path: string; body?: Record<string, unknown> }
async function run(command: "login" | "cancel", args: string[]) {
  const sent: Sent[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...parts) => { logs.push(parts.join(" ")); };
  console.error = (...parts) => { errors.push(parts.join(" ")); };
  try {
    const code = await handleAccountAuthCommand(command, args, {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        sent.push({ path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
        return new Response(JSON.stringify({ flowId: "flow-1", method: "google", state: "pending", userCode: "ABCD", verificationUri: "https://example.test/verify" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    return { code, sent, logs: logs.join("\n"), errors: errors.join("\n") };
  } finally { console.log = originalLog; console.error = originalError; }
}

describe("Kiro CLI native device login", () => {
  test("--method starts native flow and prints only the public view", async () => {
    const result = await run("login", ["kiro", "--method", "google", "--no-wait", "--json"]);
    expect(result.code).toBe(0);
    expect(result.sent).toEqual([{ path: "/api/oauth/login", body: { provider: "kiro", method: "google" } }]);
    expect(result.logs).toContain("flow-1");
    expect(result.logs).not.toMatch(/private-|clientSecret|refreshToken|deviceCode/);
  });
  test("--method with --reauth is a usage error without a request", async () => {
    const result = await run("login", ["kiro", "--method", "google", "--reauth"]);
    expect(result.code).toBe(2);
    expect(result.sent).toHaveLength(0);
  });
  test("cancel by flow targets native Kiro flow", async () => {
    const result = await run("cancel", ["kiro", "--flow", "flow-1", "--json"]);
    expect(result.code).toBe(0);
    expect(result.sent).toEqual([{ path: "/api/oauth/login/cancel", body: { provider: "kiro", flowId: "flow-1" } }]);
  });
});
