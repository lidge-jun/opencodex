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
  codexHome = installIsolatedCodexHome("ocx-stream-hosted-codex-");
  home = mkdtempSync(join(tmpdir(), "ocx-stream-hosted-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearComboRecallForTests();
  clearResponseStateForTests();
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  await flushResponseState();
  clearResponseStateForTests();
  release();
  setRelayPlatformForTests(undefined);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome.restore();
  removeTreeWithRetry(home);
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearComboRecallForTests();
});

function frame(event: Record<string, unknown>) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function run(tools: unknown[], choice: unknown, output: unknown[], preferImage = false, committed = false) {
  const sent: Array<Record<string, unknown>> = [];
  const providers: OcxConfig["providers"] = {};
  for (const name of ["a", "b"]) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      sent.push(await req.json() as Record<string, unknown>);
      const response = { id: "resp_hosted", object: "response", model: "m1", status: "completed", output, usage };
      return new Response([
        frame({ type: "response.created", response: { ...response, status: "in_progress", output: [] } }),
        ...(committed ? [frame({ type: "response.output_text.delta", delta: "committed fixture" })] : []),
        ...output.map(item => frame({ type: "response.output_item.done", output_index: 0, item })),
        frame({ type: "response.completed", response }),
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    servers.push(server);
    providers[name] = { ...provider("openai-responses", `${server.url.toString().replace(/\/$/, "")}/v1`, `key-${name}`),
      ...(preferImage ? { modelPreferHostedTools: { m1: ["image_generation"] } } : {}) };
  }
  const config = { port: 0, defaultProvider: "a", providers,
    combos: { fixture: { strategy: "failover", targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] } } } as OcxConfig;
  const models: string[] = [];
  const statuses: string[] = [];
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/fixture", input: "Use the declared fixture tool", stream: true, store: false,
      tools, tool_choice: choice }),
  }), config, { model: "", provider: "" }, {
    onResponseComplete: model => { models.push(model); },
    onNativePassthroughTerminal: status => { statuses.push(status); },
  });
  const text = await response.text();
  const terminals = text.split(/\r?\n/).filter(line => line.startsWith("data: {"))
    .map(line => JSON.parse(line.slice(6))).filter(event => ["response.completed", "response.failed"].includes(event.type));
  return { sent, models, statuses, terminals, text };
}

describe("combo streaming outbound hosted-tool contract (#7456)", () => {
  // win32 selects the eager rewrite owner; linux selects the tee owner without changing process.platform.
  for (const platform of ["win32", "linux"] as const) {
    for (const choice of [{ type: "function", name: "image_gen.imagegen" }, "required"]) {
      test(`${platform}: hosted image substitution satisfies ${JSON.stringify(choice)}`, async () => {
        setRelayPlatformForTests(platform);
        const call = { type: "image_generation_call", id: "ig_fixture", status: "completed", result: "c3ludGhldGlj" };
        const result = await run([imageTool], choice, [call], true);
        expect(result.sent).toHaveLength(1);
        expect(result.sent[0]!.tools).toEqual([{ type: "image_generation" }]);
        expect(result.sent[0]!.tool_choice).toEqual(choice === "required" ? "required" : { type: "image_generation" });
        expect(result.terminals).toMatchObject([{ type: "response.completed", response: { status: "completed", output: [call], usage } }]);
        expect(result.text).not.toContain("required_tool_contract_unsatisfied");
        expect(result.models).toEqual(["m1"]);
        expect(result.statuses).toEqual(["completed"]);
      });
    }
    for (const [type, callType] of [["web_search", "web_search_call"], ["code_interpreter", "code_interpreter_call"]]) {
      for (const choice of ["required", { type }]) {
        test(`${platform}: declared ${type} completes for ${JSON.stringify(choice)}`, async () => {
          setRelayPlatformForTests(platform);
          const call = { type: callType, id: "hosted_fixture", status: "completed" };
          const result = await run([{ type }], choice, [call]);
          expect(result.sent).toHaveLength(1);
          expect(result.terminals).toMatchObject([{ type: "response.completed", response: { output: [call] } }]);
          expect(result.models).toEqual(["m1"]);
          expect(result.statuses).toEqual(["completed"]);
        });
      }
    }
    test(`${platform}: unrelated named function is not satisfied by hosted image execution`, async () => {
      setRelayPlatformForTests(platform);
      const marker = { ...imageTool, name: "marker_func" };
      const result = await run([imageTool, marker], { type: "function", name: "marker_func" },
        [{ type: "image_generation_call", id: "ig_unrelated", status: "completed" }], true);
      expect(result.sent).toHaveLength(1);
      expect(result.terminals).toMatchObject([{ type: "response.failed", response: { error: { code: "required_tool_contract_unsatisfied" } } }]);
      expect(result.models).toEqual([]);
      expect(result.statuses).toEqual(["failed"]);
    });
    test(`${platform}: substituted required tool still fails when no call completes after commitment`, async () => {
      setRelayPlatformForTests(platform);
      const result = await run([imageTool], "required", [], true, true);
      expect(result.sent).toHaveLength(1);
      expect(result.terminals).toMatchObject([{ type: "response.failed", response: { error: { code: "required_tool_contract_unsatisfied" } } }]);
      expect(result.models).toEqual([]);
      expect(result.statuses).toEqual(["failed"]);
    });
  }
});
