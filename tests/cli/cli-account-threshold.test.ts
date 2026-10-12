import { expect, test } from "bun:test";
import { cmdAccount } from "../../src/cli/account";
import type { OcxConfig } from "../../src/types";

const codexAccounts: Array<Record<string, unknown>> = [{ id: "__main__", isMain: true }];
async function run(args: string[]): Promise<{ code: number; stderr: string }> {
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = (...values: unknown[]) => { errors.push(values.map(String).join(" ")); };
  try {
    const code = await cmdAccount(args, {
      baseUrl: "http://localhost:10100",
      loadConfigImpl: () => ({
        port: 10100, defaultProvider: "openai",
        providers: { openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" } },
      } as OcxConfig),
      fetchImpl: (async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/codex-auth/active") return Response.json(
          init?.method === "PUT" ? { ok: true } : { activeId: "__main__", autoSwitchThreshold: 80 },
        );
        if (path === "/api/codex-auth/accounts") return Response.json({ accounts: codexAccounts });
        throw new Error("Unexpected account API path: " + path);
      }) as typeof fetch,
    });
    return { code, stderr: errors.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

  test("use openai omits the pin warning when the selected account disables usage switching", async () => {
    codexAccounts[0]!.autoSwitchThresholdOverride = 0;

    const result = await run(["use", "openai", "main"]);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("may override this pin");
  });
