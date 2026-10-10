// CLI surface for the Grok reset-coupon management endpoints. The management
// routes have their own coverage; this file pins the account-auth subcommand
// contract: local flag validation refuses before any fetch, and the read path
// reaches the coupon listing endpoint and prints the tokens.
import { describe, expect, test } from "bun:test";
import { handleAccountAuthCommand } from "../../../src/cli/account-auth";
import type { RuntimeApiDeps } from "../../../src/cli/runtime-api";

interface Captured {
  method: string;
  path: string;
  body: unknown;
}

function deps(respond: (captured: Captured) => unknown, calls: Captured[]): RuntimeApiDeps {
  return {
    baseUrl: "http://127.0.0.1:10100",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const captured: Captured = {
        method: init?.method ?? "GET",
        path: `${parsed.pathname}${parsed.search}`,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(captured);
      const reply = respond(captured);
      return reply instanceof Response ? reply : new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch,
  };
}

function capture(): { lines: string[]; errors: string[]; restore: () => void } {
  const lines: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  return { lines, errors, restore: () => { console.log = log; console.error = err; } };
}

describe("ocx account grok-reset-coupons", () => {
  test("consume mints a stable operation id before sending", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      expect(await handleAccountAuthCommand("grok-reset-coupons", ["main", "--consume", "--yes"],
        deps(() => ({ code: "redeemed" }), calls))).toBe(0);
    } finally { out.restore(); }
    expect(calls).toHaveLength(1);
    expect((calls[0].body as { operationId: string }).operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test("an uncertain response prints the same operation id instead of encouraging a new spend", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      expect(await handleAccountAuthCommand("grok-reset-coupons", ["main", "--consume", "--yes"], deps(c =>
        new Response(JSON.stringify({ operationId: (c.body as { operationId: string }).operationId,
          error: { code: "attempt_unresolved" } }), { status: 502 }), calls))).toBeGreaterThan(0);
    } finally { out.restore(); }
    expect(calls).toHaveLength(1);
    expect(out.errors.join("\n")).toContain(`--operation-id ${(calls[0].body as { operationId: string }).operationId}`);
  });

  test("a changed operation preserves its client-minted recovery id without another POST", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      expect(await handleAccountAuthCommand("grok-reset-coupons", ["main", "--consume", "--yes"], deps(() =>
        new Response(JSON.stringify({ error: { code: "operation_state_changed" } }), { status: 409 }), calls))).toBeGreaterThan(0);
    } finally { out.restore(); }
    expect(calls).toHaveLength(1);
    expect(out.errors.join("\n")).toContain(`--operation-id ${(calls[0].body as { operationId: string }).operationId}`);
  });

  test("a lost response retains its client-minted operation id without another POST", async () => {
    const calls: Captured[] = [];
    const out = capture();
    try {
      expect(await handleAccountAuthCommand("grok-reset-coupons", ["main", "--consume", "--yes"],
        deps(() => { throw new Error("fixture connection lost after dispatch"); }, calls))).toBeGreaterThan(0);
    } finally { out.restore(); }
    expect(calls).toHaveLength(1);
    expect(out.errors.join("\n")).toContain(`--operation-id ${(calls[0].body as { operationId: string }).operationId}`);
  });

  test("--consume without --yes refuses locally, before any fetch", async () => {
    const calls: Captured[] = [];
    const out = capture();
    let code: number;
    try {
      code = await handleAccountAuthCommand("grok-reset-coupons", ["--consume"], deps(() => ({}), calls));
    } finally {
      out.restore();
    }
    expect(code).toBe(2);
    expect(out.errors.join("\n")).toContain("--yes");
    expect(calls).toHaveLength(0);
  });

  test("--operation-id that is not a UUIDv4 refuses before any fetch", async () => {
    const calls: Captured[] = [];
    const out = capture();
    let code: number;
    try {
      code = await handleAccountAuthCommand(
        "grok-reset-coupons",
        ["main", "--consume", "--yes", "--operation-id", "nope"],
        deps(() => ({}), calls),
      );
    } finally {
      out.restore();
    }
    expect(code).toBe(2);
    expect(out.errors.join("\n")).toContain("UUIDv4");
    expect(calls).toHaveLength(0);
  });

  test("a read GETs the coupon list for the account and prints the tokens", async () => {
    const calls: Captured[] = [];
    const out = capture();
    let code: number;
    try {
      code = await handleAccountAuthCommand(
        "grok-reset-coupons",
        ["main", "--json"],
        deps(() => ({
          accountId: "__main__",
          tokens: [{ tokenId: "tok-1", validityStart: "2026-09-01", validityEnd: "2026-10-01" }],
          remaining: 1,
        }), calls),
      );
    } finally {
      out.restore();
    }
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/api/grok/reset-coupons?accountId=__main__");
    expect(out.lines.join("\n")).toContain("tok-1");
  });
});
