import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import type { NativeMainRefreshDependencies } from "../src/codex/main-account";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

let directory: string;
let previousHome: string | undefined;

function jwt(offset: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + offset })).toString("base64url")}.signature`;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ocx-responses-refresh-"));
  previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  mkdirSync(directory, { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  rmSync(directory, { recursive: true, force: true });
});

test("replays one native-main 401 with the refreshed bearer", async () => {
  const stale = jwt(3_600);
  const fresh = jwt(7_200);
  const observedBearers: string[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      observedBearers.push(req.headers.get("authorization") ?? "");
      if (observedBearers.length === 1) return Response.json({ error: { message: "expired" } }, { status: 401 });
      return Response.json({ id: "resp_1", object: "response", status: "completed", output: [] });
    },
  });
  try {
    writeFileSync(join(directory, "auth.json"), JSON.stringify({ tokens: { access_token: stale, refresh_token: "refresh", account_id: "main" } }));
    const config = {
      defaultProvider: "openai",
      activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
      providers: { openai: {
        adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool",
        fetch: (_input: RequestInfo | URL, init?: RequestInit) => fetch(`http://127.0.0.1:${upstream.port}`, init),
      } },
      codexAccounts: [],
    } as unknown as OcxConfig;
    const dependencies: NativeMainRefreshDependencies = Object.freeze({
      refreshToken: async () => ({ access: fresh, refresh: "refresh-2", expires: Date.now() + 3_600_000, accountId: "main" }),
    });
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5", input: "hello", stream: false }),
    }), config, { model: "", provider: "" }, { nativeMainRefreshDependencies: dependencies });
    expect(response.status).toBe(200);
    expect(observedBearers).toEqual([`Bearer ${stale}`, `Bearer ${fresh}`]);
  } finally {
    upstream.stop(true);
  }
});
