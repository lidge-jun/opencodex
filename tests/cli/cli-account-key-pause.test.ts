import { expect, test } from "bun:test";
import { cmdPause } from "../../src/cli/account-extended";
import type { AccountDeps } from "../../src/cli/account-api";
import { repoPath } from "../helpers/repo-root";

async function run(requested: string, options: { failWrite?: boolean; keys?: unknown[]; json?: boolean; pauseResponse?: unknown; paused?: boolean } = {}) {
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
        return Response.json(options.pauseResponse ?? { ok: true });
      }
      return Response.json({ keys: options.keys ?? [{ id: "key-1", label: "reserve" }] });
    }) as typeof fetch,
  };
  try {
    const paused = options.paused ?? true;
    const code = await cmdPause(["fixture", requested, ...(options.json ? ["--json"] : [])], deps, paused);
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
  expect(result.lines).toEqual([JSON.stringify({ ok: true, provider: "fixture", id: "key-1", paused: true, activeAccountId: null, activeAccountChanged: false }, null, 2)]);
  expect(result.writes).toEqual([{ name: "fixture", id: "key-1", paused: true }]);
});

test("API-key pause JSON infers the next active account when the active key is paused", async () => {
  const result = await run("primary", {
    json: true,
    keys: [{ id: "key-1", label: "primary", active: true }, { id: "key-2", label: "backup" }],
  });
  expect(result.code).toBe(0);
  expect(result.lines).toEqual([JSON.stringify({
    ok: true, provider: "fixture", id: "key-1", paused: true,
    activeAccountId: "key-2", activeAccountChanged: true,
  }, null, 2)]);
});

test("API-key pause JSON preserves an authoritative null active-key result", async () => {
  const result = await run("primary", {
    json: true,
    keys: [{ id: "key-1", label: "primary", active: true }, { id: "key-2", label: "backup" }],
    pauseResponse: { ok: true, activeAccountId: null, activeAccountChanged: true },
  });
  expect(result.code).toBe(0);
  expect(result.lines).toEqual([JSON.stringify({
    ok: true, provider: "fixture", id: "key-1", paused: true,
    activeAccountId: null, activeAccountChanged: true,
  }, null, 2)]);
});

test("the defensive pause usage fallback also names API-key pools", async () => {
  const source = await Bun.file(repoPath("src/cli/account-extended.ts")).text();
  const fallback = source.split("\n").find(line => line.includes("${verb} applies to"));
  expect(fallback).toContain('applies to the openai Codex account pool, a generic OAuth provider, or an API-key pool');
});

test("API-key pause prints active account handoff notice on stderr when activeAccountChanged is true", async () => {
  const lines: string[] = [], errors: string[] = [];
  const log = console.log, error = console.error;
  console.log = value => { lines.push(String(value)); };
  console.error = value => { errors.push(String(value)); };
  const deps: AccountDeps = {
    baseUrl: "http://127.0.0.1:10100",
    loadConfigImpl: () => ({ providers: { "google-vertex": { adapter: "google", authMode: "key" } } }) as never,
    fetchImpl: (async (_url, init) => {
      if (init?.method === "PUT") return Response.json({ ok: true, activeId: "key-2", activeAccountId: "key-2", activeAccountChanged: true });
      return Response.json({ keys: [{ id: "key-1", label: "primary" }, { id: "key-2", label: "backup" }] });
    }) as typeof fetch,
  };
  try {
    const code = await cmdPause(["google-vertex", "primary"], deps, true);
    expect(code).toBe(0);
    expect(lines).toEqual(["google-vertex: account paused"]);
    expect(errors).toEqual(["Active account changed to key-2."]);
  } finally { console.log = log; console.error = error; }
});

test("API-key pause prioritizes authoritative server active state over stale roster", async () => {
  const result = await run("key-B", {
    json: true,
    keys: [
      { id: "key-A", label: "key-A", active: true },
      { id: "key-B", label: "key-B" },
      { id: "key-C", label: "key-C" },
    ],
    pauseResponse: { ok: true, activeAccountId: "key-C", activeAccountChanged: false },
  });
  expect(result.code).toBe(0);
  expect(result.writes).toEqual([{ name: "fixture", id: "key-B", paused: true }]);
  expect(result.lines).toEqual([JSON.stringify({
    ok: true, provider: "fixture", id: "key-B", paused: true,
    activeAccountId: "key-C", activeAccountChanged: false,
  }, null, 2)]);
  expect(result.errors).toEqual([]);
});

test("API-key resume preserves healthy active key and honors authoritative false", async () => {
  const result = await run("key-B", {
    paused: false,
    json: false,
    keys: [
      { id: "key-A", label: "key-A", active: true },
      { id: "key-B", label: "key-B", disabled: true },
    ],
    pauseResponse: { ok: true, activeAccountId: "key-A", activeAccountChanged: false },
  });
  expect(result.code).toBe(0);
  expect(result.writes).toEqual([{ name: "fixture", id: "key-B", paused: false }]);
  expect(result.lines).toEqual(["fixture: account resumed"]);
  expect(result.errors).toEqual([]);
});
