import { describe, expect, test } from "bun:test";
import { cmdAccount } from "../../src/cli/account";
import type { AccountDeps } from "../../src/cli/account-api";
import type { OcxConfig } from "../../src/types";

/**
 * `ocx account list --json` carries the slot identity contract from the account-list API.
 * Kept out of the #180 matrix file, which sits at its file-size ratchet cap.
 */
function deps(accounts: Array<Record<string, unknown>>): AccountDeps {
  return {
    baseUrl: "http://127.0.0.1:10100",
    loadConfigImpl: () => ({
      port: 10100,
      defaultProvider: "openai",
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward", codexAccountMode: "pool" } },
    }) as unknown as OcxConfig,
    fetchImpl: (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/codex-auth/accounts") return Response.json({ accounts });
      if (path === "/api/codex-auth/active") return Response.json({ activeCodexAccountId: "__main__" });
      return Response.json({});
    }) as unknown as typeof fetch,
  };
}

async function runJson(args: string[], accounts: Array<Record<string, unknown>>) {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try {
    const code = await cmdAccount(args, deps(accounts));
    return { code, rows: (JSON.parse(lines.join("\n")) as { accounts: Array<Record<string, unknown>> }).accounts };
  } finally {
    console.log = log;
  }
}

describe("ocx account list: slot identity", () => {
  test("official --json output carries the upstream join contract", async () => {
    const key = `uai1_${"a".repeat(64)}`;
    const result = await runJson(["list", "openai", "--json"], [
      { id: "__main__", slotId: "__main__", slotKind: "native-main", upstreamAccountKey: key,
        email: "main@example.test", plan: "pro" },
      { id: "chatgpt_1", slotId: "chatgpt_1", slotKind: "pool", upstreamAccountKey: key,
        email: "pool@example.test", plan: "pro" },
    ]);
    expect(result.code).toBe(0);
    expect(result.rows.filter(row => row.provider === "openai")
      .map(row => [row.slotId, row.slotKind, row.upstreamAccountKey])).toEqual([
      ["__main__", "native-main", key],
      ["chatgpt_1", "pool", key],
    ]);
  });
});
