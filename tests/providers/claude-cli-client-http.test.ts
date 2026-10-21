import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCliAdapter } from "../../src/adapters/claude-cli/adapter";
import { getAdapterDefinition } from "../../src/adapters/registry";
import { handleResponses } from "../../src/server/responses";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { buildDshClientConfig } from "../../src/clients/config-export/dsh";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig } from "../../src/types";

test("Codex/DSH Responses and Pi Chat retain host-owned tools, inclusive usage and abort cleanup", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-claude-http-"));
  const fixture = join(home, "fixture.txt");
  writeFileSync(fixture, "PROBE_FILE_CONTENT_42");
  const definition = getAdapterDefinition("claude-cli")! as any;
  const originalCreate = definition.create;
  const releaseSpend = acquireOwnedSpendHome();
  const children: number[] = [];
  const ownedChildren: ReturnType<typeof spawn>[] = [];
  const closed = new Set<number>();
  let hostReads = 0;
  const config = { port: 0, defaultProvider: "claude-cli", providers: {
    "claude-cli": { adapter: "claude-cli", baseUrl: "https://api.anthropic.com", authMode: "key", selectedModels: ["claude-sonnet-5-5"] },
  } } as OcxConfig;
  definition.create = (provider: any) => createClaudeCliAdapter(provider, {
    which: () => process.execPath,
    killGraceMs: 20,
    timeoutMs: 5000,
    spawn: (_command, args, options) => {
      const child = spawn(process.execPath, [join(import.meta.dir, "../fixtures/claude-efficiency-cli.ts"), JSON.stringify(args), fixture, process.env.OCX_EFFICIENCY_NEGATIVE_CONTROL ?? ""], options);
      children.push(child.pid!);
      ownedChildren.push(child);
      child.on("close", () => closed.add(child.pid!));
      return child;
    },
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => req.url.endsWith("/responses")
    ? handleResponses(req, config, { model: "", provider: "" })
    : handleChatCompletions(req, config, { model: "", provider: "" }) });
  const base = `http://127.0.0.1:${server.port}/v1`;
  const model = "claude-cli/claude-sonnet-5-5";
  const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  const responseTools = [{ type: "function", name: "read_text", description: "Read the test fixture", parameters: schema }];
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await res.json() as any;
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(value)}`);
    return value;
  };
  try {
    expect(server.port).not.toBe(10100);
    const exported = buildDshClientConfig({ baseUrl: base, models: [{ namespaced: model, provider: "claude-cli", id: "claude-sonnet-5-5", displayName: "Sonnet 5.5", inputModalities: ["text"] }], config });
    expect(exported["llm-pi-ai"].providers.opencodex!.api).toBe("openai-responses");
    expect(exported["llm-pi-ai"].providers.opencodex!.models[0]!.name).toBe("Sonnet 5.5 (claude-cli)");
    const first = await post("responses", { model, stream: false, store: true, input: [{ role: "user", content: "Read the fixture using read_text." }], tools: responseTools });
    const call = first.output.find((item: any) => item.type === "function_call");
    expect(call.name).toBe("read_text");
    expect(JSON.parse(call.arguments).path).toBe(fixture);
    expect(hostReads).toBe(0);
    const content = readFileSync(fixture, "utf8"); hostReads++;
    const second = await post("responses", { model, stream: false, previous_response_id: first.id, input: [{ type: "function_call_output", call_id: call.call_id, output: content }], tools: responseTools });
    expect(JSON.stringify(second.output)).toContain(content);
    expect(second.usage.input_tokens).toBe(112);
    const chatTools = [{ type: "function", function: { name: "read_text", description: "Read the test fixture", parameters: schema } }];
    const messages: any[] = [{ role: "user", content: "Read the fixture using read_text." }];
    const chatFirst = await post("chat/completions", { model, stream: false, messages, tools: chatTools });
    const reply = chatFirst.choices[0].message;
    expect(reply.tool_calls[0].function.name).toBe("read_text");
    expect(JSON.parse(reply.tool_calls[0].function.arguments).path).toBe(fixture);
    messages.push(reply, { role: "tool", tool_call_id: reply.tool_calls[0].id, content: readFileSync(fixture, "utf8") }); hostReads++;
    const chatSecond = await post("chat/completions", { model, stream: false, messages, tools: chatTools });
    expect(chatSecond.choices[0].message.content).toBe(content);
    expect(chatSecond.usage.prompt_tokens).toBe(112);
    const controller = new AbortController();
    const previousChildren = children.length;
    const waiting = fetch(`${base}/responses`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: true, input: "WAIT_FOR_ABORT", tools: responseTools }) }).then(res => res.text()).catch(() => "aborted");
    const deadline = Date.now() + 2500;
    while (children.length === previousChildren && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(children.length).toBe(previousChildren + 1);
    controller.abort();
    await waiting;
    const cleanupDeadline = Date.now() + 2500;
    while (closed.size < children.length && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(closed.size).toBe(children.length);
    for (const pid of children) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    try {
      await server.stop(true);
      for (const child of ownedChildren) {
        if (child.exitCode === null && child.signalCode === null) {
          const childClosed = new Promise<void>(resolve => child.once("close", () => resolve()));
          child.kill();
          await Promise.race([childClosed, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Owned fixture cleanup timed out")), 2500))]);
        }
      }
    } finally {
      definition.create = originalCreate;
      releaseSpend();
      rmSync(home, { recursive: true, force: true });
    }
  }
}, 20000);
