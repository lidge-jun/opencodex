import { expect, test } from "bun:test";
import { cmdPause } from "../../src/cli/account-extended";
import type { AccountDeps } from "../../src/cli/account-api";
import { repoPath } from "../helpers/repo-root";

async function run(requested: string, options: { failWrite?: boolean; keys?: unknown[]; json?: boolean } = {}) {
  const lines: string[] = [], errors: string[] = [], writes: unknown[] = [];
  const log = console.log, error = console.error;
  console.log = value => { lines.push(String(value)); };
  console.error = value => { errors.push(String(value)); };
  const deps: AccountDeps = {
    baseUrl: "http://127.0.0.1:10100",
    loadConfigImpl: () => ({ providers: { fixture: { adapter: "openai", authMode: "key" } } }) as never,
    fetchImpl: (async (_url, init) => {
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        if (options.failWrite) throw new Error("fixture connection refused");
        return Response.json({ ok: true });
      }
      return Response.json({ keys: options.keys ?? [{ id: "key-1", label: "reserve" }] });
    }) as typeof fetch,
  };
  try {
    const code = await cmdPause(["fixture", requested, ...(options.json ? ["--json"] : [])], deps, true);
    return { code, lines, errors, writes };
  } finally { console.log = log; console.error = error; }
}

test("API-key target errors retain the Error prefix and identify the pool kind", async () => {
  const result = await run("missing");
  expect(result.code).toBe(1);
  expect(result.errors[0]).toBe('Error: Account not found: no API key account has the id or alias "missing"');
  expect(result.writes).toEqual([]);
});

test("ambiguous key aliases are never rewritten when they contain OAuth", async () => {
  const result = await run("OAuth reserve", { keys: [{ id: "one", label: "OAuth reserve" }, { id: "two", label: "OAuth reserve" }] });
  expect(result.errors[0]).toBe('Error: alias "OAuth reserve" names 2 accounts; use the account id');
  expect(result.writes).toEqual([]);
});

test("a failed pause transport reports an unreachable proxy and its cause", async () => {
  const result = await run("reserve", { failWrite: true });
  expect(result.code).toBe(1);
  expect(result.errors.join("\n")).toContain("Proxy not reachable.");
  expect(result.errors.join("\n")).toContain("fixture connection refused");
});

test("API-key pause JSON uses the same two-space indentation as the other pools", async () => {
  const result = await run("reserve", { json: true });
  expect(result.code).toBe(0);
  expect(result.lines).toEqual([JSON.stringify({ ok: true, provider: "fixture", id: "key-1", paused: true }, null, 2)]);
  expect(result.writes).toEqual([{ name: "fixture", id: "key-1", paused: true }]);
});

test("the defensive pause usage fallback also names API-key pools", async () => {
  const source = await Bun.file(repoPath("src/cli/account-extended.ts")).text();
  const fallback = source.split("\n").find(line => line.includes("${verb} applies to"));
  expect(fallback).toContain('applies to the openai Codex account pool, a generic OAuth provider, or an API-key pool');
});
