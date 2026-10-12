import { describe, expect, test } from "bun:test";
import { handleAccountAuthCommand } from "../../src/cli/account-auth";

interface SentRequest { path: string; body: unknown }

async function runCancel(args: string[]): Promise<{ code: number | null; errors: string; requests: SentRequest[] }> {
  const requests: SentRequest[] = [];
  const errors: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
  console.log = () => {};
  try {
    const code = await handleAccountAuthCommand("cancel", args, {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true, cancelled: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    return { code, errors: errors.join("\n"), requests };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

describe("account cancel flow selection", () => {
  test("Codex aliases require --flow before a request", async () => {
    for (const provider of ["openai", "codex", "chatgpt"]) {
      const result = await runCancel([provider]);
      expect(result.code).toBe(2);
      expect(result.errors).toContain("--flow <flow-id>");
      expect(result.requests).toHaveLength(0);
    }
  });

  test("Codex sends its flow ID and generic OAuth keeps provider cancellation", async () => {
    const codex = await runCancel(["openai", "--flow", "flow-owned"]);
    expect(codex.code).toBe(0);
    expect(codex.requests).toEqual([{ path: "/api/codex-auth/login/cancel", body: { flowId: "flow-owned" } }]);

    const generic = await runCancel(["anthropic"]);
    expect(generic.code).toBe(0);
    expect(generic.requests).toEqual([{ path: "/api/oauth/login/cancel", body: { provider: "anthropic" } }]);
  });
});
