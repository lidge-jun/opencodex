import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { clearComboStickyState, clearComboTargetCooldowns } from "../src/combos";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstreamA: ReturnType<typeof Bun.serve> | null = null;
let upstreamB: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearComboStickyState();
  clearComboTargetCooldowns();
});

afterEach(() => {
  upstreamA?.stop(true);
  upstreamB?.stop(true);
  upstreamA = null;
  upstreamB = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  clearComboStickyState();
  clearComboTargetCooldowns();
});

describe("server combo failover (end-to-end)", () => {
  test("combo/free hops from 403 target A to 200 target B through handleResponses", async () => {
    const hits: string[] = [];

    upstreamA = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        hits.push("a");
        return new Response(JSON.stringify({
          error: { message: "this model requires a subscription, upgrade for access: https://ollama.com/upgrade" },
        }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      },
    });

    upstreamB = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        hits.push("b");
        return new Response(JSON.stringify({
          id: "chatcmpl-combo-hop",
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "ok from backup" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      },
    });

    const config: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "prov-a",
      providers: {
        "prov-a": {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstreamA.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-a-000111222333",
          models: ["model-a"],
        },
        "prov-b": {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstreamB.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-b-444555666777",
          models: ["model-b"],
        },
      },
      combos: {
        free: {
          strategy: "failover",
          targets: [
            { provider: "prov-a", model: "model-a" },
            { provider: "prov-b", model: "model-b" },
          ],
        },
      },
    } as OcxConfig;

    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "combo/free",
          input: "hello",
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as {
        model?: string;
        output?: { type: string; content?: { text?: string }[] }[];
      };
      expect(json.output?.find(o => o.type === "message")?.content?.[0]?.text).toBe("ok from backup");
      expect(hits).toEqual(["a", "b"]);
      // Wire model after hop is the backup target (namespace stripped for upstream).
      expect(json.model).toBe("model-b");
    } finally {
      server.stop(true);
    }
  });
});
