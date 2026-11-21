import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { oauthAccountLogLabel } from "../../src/codex/account-label";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { managementFetch as fetch } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function pool(prefix: string, email: string) {
  return {
    activeAccountId: `${prefix}1`,
    accounts: [1, 2].map(n => ({
      id: `${prefix}${n}`,
      credential: { access: `t${n}`, refresh: `r${n}`, expires: 9999999999999, email: `${prefix}${n}@${email}`, accountId: `acct-${prefix}${n}`, source: "oauth" },
    })),
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-oauth-log-label-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-oauth-log-label-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig({
    port: 0, hostname: "127.0.0.1", defaultProvider: "xai",
    providers: {
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
    },
  } as unknown as OcxConfig);
  writeFileSync(join(testDir, "auth.json"), JSON.stringify({ xai: pool("xa", "example.test"), anthropic: pool("an", "example.test") }), { mode: 0o600 });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("GET /api/oauth/accounts logLabel", () => {
  test("a generic OAuth provider's accounts carry the label request rows use", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts?provider=xai", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { accounts: Array<{ id: string; logLabel?: string }> };
      expect(body.accounts.map(a => [a.id, a.logLabel])).toEqual([
        ["xa1", oauthAccountLogLabel("xa1", "xai")],
        ["xa2", oauthAccountLogLabel("xa2", "xai")],
      ]);
      expect(body.accounts[0]!.logLabel).toMatch(/^o[a-f0-9]{6}$/);
    } finally { await server.stop(true); }
  }, 30_000);

  test("the Anthropic pool does not get a generic label", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts?provider=anthropic", server.url));
      const body = await res.json() as { accounts: Array<{ logLabel?: string }> };
      expect(body.accounts).toHaveLength(2);
      expect(body.accounts.every(a => a.logLabel === undefined)).toBe(true);
    } finally { await server.stop(true); }
  }, 30_000);
});
