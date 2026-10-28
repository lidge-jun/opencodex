import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { comboProviderFactory } from "../helpers/combo-provider";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { setRelayPlatformForTests } from "../../src/server/responses/passthrough-delivery";
import { handleResponses } from "../../src/server/responses";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import type { OcxConfig } from "../../src/types";

const provider = comboProviderFactory(() => undefined);
const imageTool = { type: "function", name: "image_gen.imagegen", parameters: { type: "object", properties: {} } };
const usage = { input_tokens: 7, output_tokens: 2, total_tokens: 9 };
let home: string;
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;
let release: () => void;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  codexHome = installIsolatedCodexHome("ocx-send-contract-codex-");
  home = mkdtempSync(join(tmpdir(), "ocx-send-contract-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  resetProviderRequestPacingForTest();
  clearComboSelectionState(); clearComboTargetCooldowns(); clearComboRecallForTests(); clearResponseStateForTests();
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  await flushResponseState(); clearResponseStateForTests();
  release(); setRelayPlatformForTests(undefined); resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome.restore(); removeTreeWithRetry(home);
  clearComboSelectionState(); clearComboTargetCooldowns(); clearComboRecallForTests();
});

const frame = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
type Mode = "queued-image" | "preset-image" | "removed-image" | "filtered";
async function run(mode: Mode, committed = false) {
  const sent: Array<{ target: string; choice: unknown; tools: unknown }> = [];
  const providers: OcxConfig["providers"] = {};
  for (const target of ["a", "b"]) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const body = await req.json() as Record<string, unknown>;
      sent.push({ target, choice: body.tool_choice, tools: body.tools });
      const output = mode === "filtered"
        ? target === "a" ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "missing search" }] }]
          : [{ type: "web_search_call", id: "ws_backup", status: "completed" }]
        : [{ type: "image_generation_call", id: "ig_fixture", status: "completed", result: "c3ludGhldGlj" }];
      const response = { id: `resp_${target}`, object: "response", model: target === "a" ? "m1" : "m2", status: "completed", output, usage };
      return new Response([
        frame({ type: "response.created", response: { ...response, status: "in_progress", output: [] } }),
        ...(committed ? [frame({ type: "response.output_text.delta", delta: "committed fixture" })] : []),
        frame({ type: "response.completed", response }),
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    servers.push(server);
    providers[target] = { ...provider("openai-responses", `${server.url.toString().replace(/\/$/, "")}/v1`, `key-${target}`),
      ...(target === "a" && mode === "filtered" ? { unsupportedHostedTools: ["web_search"] } : {}),
      ...(target === "a" && mode !== "filtered" ? {
        apiKeySelectionRevision: "initial", requestPacing: { enabled: true, maxConcurrentRequests: 1 },
        ...(mode !== "queued-image" ? { modelPreferHostedTools: { m1: ["image_generation"] } } : {}),
      } : {}),
    };
  }
  const config = { port: 0, defaultProvider: "a", providers,
    combos: { fixture: { strategy: "failover", targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] } } } as OcxConfig;
  const slot = mode !== "filtered" ? await waitForProviderRequestSlot("a", providers.a!) : undefined;
  const models: string[] = [], statuses: string[] = [];
  const pending = handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/fixture", input: "Use the declared fixture tool", stream: true, store: false,
      tools: mode === "filtered" ? [{ type: "web_search" }] : [imageTool],
      tool_choice: mode === "filtered" ? "required" : { type: "function", name: "image_gen.imagegen" } }),
  }), config, { model: "", provider: "" }, {
    onResponseComplete: model => { models.push(model); },
    onNativePassthroughTerminal: status => { statuses.push(status); },
  });
  void pending.catch(() => {});
  try {
    if (slot) {
      const deadline = Date.now() + 2_000;
      while (providerRequestPacingStatus("a", providers.a!).queued !== 1) {
        if (Date.now() >= deadline) throw new Error("fixture never queued");
        await Bun.sleep(5);
      }
      expect(sent).toEqual([]);
      providers.a!.modelPreferHostedTools = mode === "removed-image" ? {} : { m1: ["image_generation"] };
      providers.a!.apiKeySelectionRevision = "rebuilt";
      slot.release();
    }
    const response = await pending;
    const text = await response.text();
    const terminals = text.split(/\r?\n/).filter(line => line.startsWith("data: {"))
      .map(line => JSON.parse(line.slice(6))).filter(event => ["response.completed", "response.failed"].includes(event.type));
    return { sent, models, statuses, terminals, text };
  } finally { slot?.release(); await pending.catch(() => undefined); }
}

describe("combo caller contract and physical-send substitutions (#7456)", () => {
  for (const platform of ["win32", "linux"] as const) {
    for (const mode of ["queued-image", "preset-image"] as const) {
      test(`${platform}: ${mode} accepts the substitution from the actual send`, async () => {
        setRelayPlatformForTests(platform);
        const result = await run(mode);
        expect(result.sent).toEqual([{ target: "a", choice: { type: "image_generation" }, tools: [{ type: "image_generation" }] }]);
        expect(result.terminals).toMatchObject([{ type: "response.completed", response: { status: "completed", usage } }]);
        expect(result.models).toEqual(["m1"]); expect(result.statuses).toEqual(["completed"]);
      });
    }
    test(`${platform}: rebuild removes stale substitution authority`, async () => {
      setRelayPlatformForTests(platform);
      const result = await run("removed-image");
      expect(result.sent).toHaveLength(1);
      expect(result.sent[0]!.choice).toEqual({ type: "function", name: "image_gen__imagegen" });
      expect(result.terminals).toMatchObject([{ type: "response.failed", response: { error: { code: "required_tool_contract_unsatisfied" } } }]);
      expect(result.models).toEqual([]); expect(result.statuses).toEqual(["failed"]);
    });
    for (const committed of [false, true]) {
      test(`${platform}: filtered required search ${committed ? "fails after commitment" : "hops before commitment"}`, async () => {
        setRelayPlatformForTests(platform);
        const result = await run("filtered", committed);
        expect(result.sent[0]).toEqual({ target: "a", choice: "none", tools: [] });
        if (committed) {
          expect(result.sent).toHaveLength(1);
          expect(result.terminals).toMatchObject([{ type: "response.failed", response: { error: { code: "required_tool_contract_unsatisfied" }, usage } }]);
          expect(result.text).toContain("committed fixture");
          expect(result.models).toEqual([]); expect(result.statuses).toEqual(["failed"]);
        } else {
          expect(result.sent).toEqual([{ target: "a", choice: "none", tools: [] },
            { target: "b", choice: "required", tools: [{ type: "web_search" }] }]);
          expect(result.terminals).toMatchObject([{ type: "response.completed", response: { id: "resp_b" } }]);
          expect(result.text).not.toContain("missing search");
          expect(result.models).toEqual(["m2"]); expect(result.statuses).toEqual(["completed"]);
        }
      });
    }
  }
});
