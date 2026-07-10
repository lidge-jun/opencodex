import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { setDraining } from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const TEST_DIR = join(import.meta.dir, ".tmp-images-proxy-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;

function forwardConfig(baseUrl: string, hostname?: string): OcxConfig {
  return {
    port: 0,
    hostname,
    defaultProvider: "images-forward",
    providers: {
      "images-forward": {
        adapter: "openai-responses",
        baseUrl,
        authMode: "forward",
      },
    },
  };
}

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-images-proxy-codex-");
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
});

afterEach(() => {
  setDraining(false);
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("standalone Images proxy", () => {
  test("POST /v1/images/generations forwards the Codex Images contract", async () => {
    const rawBody = JSON.stringify({
      model: "gpt-image-2",
      prompt: "a small red regression fox",
      background: "auto",
      quality: "auto",
      size: "auto",
    });
    const seen: {
      path?: string;
      body?: string;
      authorization?: string | null;
      accountId?: string | null;
      contentType?: string | null;
      version?: string | null;
    } = {};
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.path = new URL(req.url).pathname;
        seen.body = await req.text();
        seen.authorization = req.headers.get("authorization");
        seen.accountId = req.headers.get("chatgpt-account-id");
        seen.contentType = req.headers.get("content-type");
        seen.version = req.headers.get("version");
        return Response.json({ created: 1, data: [{ b64_json: "AA==" }] });
      },
    });
    saveConfig(forwardConfig(`${upstream.url.toString().replace(/\/$/, "")}/backend-api/codex`));

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/images/generations", server.url), {
        method: "POST",
        headers: {
          authorization: "Bearer caller-token",
          "chatgpt-account-id": "acct-caller",
          "content-type": "application/json",
          version: "0.1.0",
        },
        body: rawBody,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ created: 1, data: [{ b64_json: "AA==" }] });
      expect(seen).toEqual({
        path: "/backend-api/codex/images/generations",
        body: rawBody,
        authorization: "Bearer caller-token",
        accountId: "acct-caller",
        contentType: "application/json",
        version: "0.1.0",
      });
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("POST /v1/images/edits preserves Codex JSON and compatible multipart bodies", async () => {
    const seen: Array<{ path: string; body: string; contentType: string | null }> = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({
          path: new URL(req.url).pathname,
          body: await req.text(),
          contentType: req.headers.get("content-type"),
        });
        return Response.json({ created: 2, data: [{ b64_json: "AQ==" }] });
      },
    });
    saveConfig(forwardConfig(`${upstream.url.toString().replace(/\/$/, "")}/backend-api/codex`));

    const server = startServer(0);
    try {
      const jsonBody = JSON.stringify({
        model: "gpt-image-2",
        prompt: "edit this",
        images: [{ image_url: "data:image/png;base64,AA==" }],
      });
      const jsonResponse = await fetch(new URL("/v1/images/edits", server.url), {
        method: "POST",
        headers: {
          authorization: "Bearer caller-token",
          "content-type": "application/json",
        },
        body: jsonBody,
      });
      expect(jsonResponse.status).toBe(200);
      await jsonResponse.text();

      const boundary = "ocx-images-boundary";
      const multipartBody = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="prompt"',
        "",
        "compatible multipart edit",
        `--${boundary}--`,
        "",
      ].join("\r\n");
      const multipartResponse = await fetch(new URL("/v1/images/edits", server.url), {
        method: "POST",
        headers: {
          authorization: "Bearer caller-token",
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartBody,
      });
      expect(multipartResponse.status).toBe(200);
      await multipartResponse.text();

      expect(seen).toEqual([
        {
          path: "/backend-api/codex/images/edits",
          body: jsonBody,
          contentType: "application/json",
        },
        {
          path: "/backend-api/codex/images/edits",
          body: multipartBody,
          contentType: `multipart/form-data; boundary=${boundary}`,
        },
      ]);
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("drain, data-plane auth, and origin gates reject before upstream work", async () => {
    let upstreamCalls = 0;
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        upstreamCalls += 1;
        return Response.json({ data: [{ b64_json: "never" }] });
      },
    });
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-images-secret";
    saveConfig(forwardConfig(
      `${upstream.url.toString().replace(/\/$/, "")}/backend-api/codex`,
      "0.0.0.0",
    ));

    const server = startServer(0);
    const endpoint = `http://127.0.0.1:${server.port}/v1/images/generations`;
    try {
      const missingAuth = await fetch(endpoint, { method: "POST", body: "{}" });
      expect(missingAuth.status).toBe(401);

      const rejectedOrigin = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-opencodex-api-key": "local-images-secret",
          origin: "https://attacker.example",
        },
        body: "{}",
      });
      expect(rejectedOrigin.status).toBe(403);

      setDraining(true);
      const draining = await fetch(endpoint, { method: "POST", body: "{}" });
      expect(draining.status).toBe(503);
      expect(draining.headers.get("retry-after")).toBe("5");
      expect(draining.headers.get("access-control-allow-headers")).toContain("X-OpenCodex-API-Key");
      expect(await draining.text()).toBe("Service shutting down");
      expect(upstreamCalls).toBe(0);
    } finally {
      setDraining(false);
      await server.stop(true);
      await upstream.stop(true);
    }
  });
});
