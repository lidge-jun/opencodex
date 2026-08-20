import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeMainRefreshDependencies } from "../src/codex/main-account";
import { handleResponsesCompact } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

let directory: string;
let previousHome: string | undefined;

function jwt(offset: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + offset })).toString("base64url")}.signature`;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ocx-compact-refresh-"));
  previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  mkdirSync(directory, { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  rmSync(directory, { recursive: true, force: true });
});

test("substitutes a refreshed native credential before compact upstream I/O", async () => {
  const fresh = jwt(3_600);
  const observedBearers: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
    observedBearers.push(req.headers.get("authorization") ?? "");
    return Response.json({ id: "compact_1", output: [] });
  } });
  try {
    writeFileSync(join(directory, "auth.json"), JSON.stringify({ tokens: { access_token: jwt(-60), refresh_token: "refresh", account_id: "main" } }));
    const config = {
      defaultProvider: "openai",
      providers: { openai: {
        adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct",
        fetch: (_input: RequestInfo | URL, init?: RequestInit) => fetch(`http://127.0.0.1:${upstream.port}`, init),
      } },
      codexAccounts: [],
    } as unknown as OcxConfig;
    const dependencies: NativeMainRefreshDependencies = Object.freeze({
      refreshToken: async () => ({ access: fresh, refresh: "refresh-2", expires: Date.now() + 3_600_000, accountId: "main" }),
    });
    const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admission" },
      body: JSON.stringify({ model: "openai/gpt-5", input: [] }),
    }), config, { model: "", provider: "" }, undefined, {
      admission: { source: "bearer" } as never,
      nativeMainRefreshDependencies: dependencies,
    });
    expect(response.status).toBe(200);
    expect(observedBearers).toEqual([`Bearer ${fresh}`]);
  } finally {
    upstream.stop(true);
  }
});
