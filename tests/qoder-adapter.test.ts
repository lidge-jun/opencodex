import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { buildQoderArgs, buildQoderChildEnv, createQoderAdapter } from "../src/adapters/qoder/adapter";
import { clearQoderBinaryCache, QODER_GLOBAL_PROFILE } from "../src/adapters/qoder/profiles";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const enc = new TextEncoder();
beforeEach(() => clearQoderBinaryCache());

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "qoder", baseUrl: "https://qoder.com", apiKey: "qoder-pat", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], ...overrides } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return { modelId: "Qwen3.8-Max", stream: true, options: {}, context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, ...overrides } as OcxParsedRequest;
}

function fakeChild(frames: string[]): ChildProcess {
  const child = new EventEmitter() as ChildProcess & { killed: boolean; exitCode: number | null };
  child.stdout = Readable.from(frames.map(frame => enc.encode(frame)));
  child.stderr = Readable.from([]);
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; return true; };
  setTimeout(() => { child.exitCode = 0; child.emit("close", 0); }, 2);
  return child;
}

describe("qoder adapter", () => {
  test("uses only the Global PAT and disables tools, MCP, settings hooks, and persistence", () => {
    const env = buildQoderChildEnv(QODER_GLOBAL_PROFILE, "qoder-pat");
    expect(env.QODER_PERSONAL_ACCESS_TOKEN).toBe("qoder-pat");
    expect(Object.keys(env).filter(key => key.startsWith("QODER"))).toEqual(["QODER_PERSONAL_ACCESS_TOKEN"]);
    const args = buildQoderArgs(parsed({ options: { reasoning: "high" } }), provider());
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("high");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("fails closed before spawn for a non-canonical destination", async () => {
    let spawned = 0;
    const adapter = createQoderAdapter(provider({ baseUrl: "https://evil.example.test" }), { which: () => "/bin/qoder", spawn: () => { spawned++; return fakeChild([]); } });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "non_canonical_destination" });
  });

  test("rejects unverified image input instead of silently dropping or forwarding it", async () => {
    let spawned = 0;
    const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => { spawned++; return fakeChild([]); } });
    const request = parsed({ context: { messages: [{ role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,AA==" }], timestamp: 0 }] } });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "unsupported_input_modality" });
  });

  test("maps Qoder credit exhaustion to a non-retryable 429", async () => {
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: () => fakeChild([
        '{"type":"assistant","message":{"content":[{"type":"text","text":"limit"}]} }\n',
        '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["You reached your credit usage limit"],"error_code":118}\n',
      ]),
      killGraceMs: 10,
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", status: 429, errorType: "insufficient_quota", code: "insufficient_quota", retryable: false });
  });
});
