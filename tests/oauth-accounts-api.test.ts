import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
    },
  } as OcxConfig;
}

function writeAccounts(): void {
  writeFileSync(join(testDir, "auth.json"), JSON.stringify({
    anthropic: {
      activeAccountId: "aaaa1111",
      accounts: [
        { id: "aaaa1111", credential: { access: "t1", refresh: "r1", expires: 9999999999999, email: "first@example.com", accountId: "acct-1" } },
        { id: "bbbb2222", credential: { access: "t2", refresh: "r2", expires: 9999999999999, email: "second@example.com", accountId: "acct-2" } },
      ],
    },
  }), { mode: 0o600 });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-oauth-accounts-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-oauth-accounts-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
  writeAccounts();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("multiauth accounts API", () => {
  test("GET lists masked accounts with active flag", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts?provider=anthropic", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { activeAccountId: string; accounts: Array<{ id: string; email?: string; active: boolean }> };
      expect(body.activeAccountId).toBe("aaaa1111");
      expect(body.accounts.length).toBe(2);
      const emails = body.accounts.map(a => a.email ?? "");
      expect(emails.some(e => e.includes("first@example.com"))).toBe(false); // masked
      expect(body.accounts.find(a => a.id === "aaaa1111")?.active).toBe(true);
      const raw = JSON.stringify(body);
      expect(raw.includes("t1")).toBe(false); // no tokens
    } finally {
      await server.stop(true);
    }
  });

  test("GET includes projected health with redacted healthSummary", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts?provider=anthropic", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        accounts: Array<{
          id: string;
          health?: { status: string };
          healthLabel?: string;
          healthSummary?: string;
          healthAction?: string;
        }>;
      };
      expect(body.accounts.length).toBe(2);
      for (const account of body.accounts) {
        expect(account.health).toBeDefined();
        expect(account.health?.status).toBeTruthy();
        expect(typeof account.healthLabel).toBe("string");
        expect(account.healthLabel!.length).toBeGreaterThan(0);
        expect(typeof account.healthSummary).toBe("string");
        expect(account.healthSummary!.includes(account.id)).toBe(false);
        expect(account.healthSummary!).toMatch(/account-…/);
      }
      const healthy = body.accounts.find(a => a.id === "aaaa1111");
      expect(healthy?.health?.status).toBe("healthy");
      expect(healthy?.healthLabel).toBe("Healthy");
    } finally {
      await server.stop(true);
    }
  });

  test("GET projects needsReauth health with action and redacted summary", async () => {
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      anthropic: {
        activeAccountId: "aaaa1111",
        accounts: [
          {
            id: "aaaa1111",
            needsReauth: true,
            credential: {
              access: "t1",
              refresh: "r1",
              expires: 9999999999999,
              email: "first@example.com",
              accountId: "acct-1",
            },
          },
        ],
      },
    }), { mode: 0o600 });

    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts?provider=anthropic", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        accounts: Array<{
          id: string;
          health?: { status: string; reason?: string };
          healthLabel?: string;
          healthSummary?: string;
          healthAction?: string;
        }>;
      };
      const account = body.accounts[0]!;
      expect(account.health?.status).toBe("reauth_required");
      expect(account.healthLabel).toMatch(/Reauthentication|Refresh/);
      expect(account.healthSummary).toMatch(/account-…/);
      expect(account.healthSummary).not.toContain("aaaa1111");
      expect(account.healthSummary).not.toContain("first@example.com");
      expect(account.healthAction).toContain("ocx login anthropic");
    } finally {
      await server.stop(true);
    }
  });

  test("PUT active switches; unknown account 404; unknown provider 400", async () => {
    const server = startServer(0);
    try {
      const ok = await fetch(new URL("/api/oauth/accounts/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", accountId: "bbbb2222" }),
      });
      expect(ok.status).toBe(200);
      const after = await fetch(new URL("/api/oauth/accounts?provider=anthropic", server.url)).then(r => r.json()) as { activeAccountId: string };
      expect(after.activeAccountId).toBe("bbbb2222");

      const missing = await fetch(new URL("/api/oauth/accounts/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", accountId: "nope" }),
      });
      expect(missing.status).toBe(404);

      const badProvider = await fetch(new URL("/api/oauth/accounts/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "not-a-provider", accountId: "x" }),
      });
      expect(badProvider.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("DELETE removes one account; active removal promotes the other", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts?provider=anthropic&id=aaaa1111", server.url), { method: "DELETE" });
      expect(res.status).toBe(200);
      const after = await fetch(new URL("/api/oauth/accounts?provider=anthropic", server.url)).then(r => r.json()) as { activeAccountId: string; accounts: unknown[] };
      expect(after.accounts.length).toBe(1);
      expect(after.activeAccountId).toBe("bbbb2222");
    } finally {
      await server.stop(true);
    }
  });
});
