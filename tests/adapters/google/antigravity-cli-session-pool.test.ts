import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createAntigravityCliAdapter } from "../../../src/adapters/antigravity-cli/adapter";
import {
  ANTIGRAVITY_CLI_PROFILE,
  clearAntigravityCliBinaryCache,
} from "../../../src/adapters/antigravity-cli/profiles";
import { ANTIGRAVITY_MCP_TOOL_PREFIX } from "../../../src/adapters/antigravity-cli/protocol";
import {
  AntigravitySessionPool,
  buildAntigravitySessionSignature,
  removeAntigravityPathSyncBestEffort,
  WarmAntigravitySession,
} from "../../../src/adapters/antigravity-cli/session-pool";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const BRIDGED_READ_TOOL = `${ANTIGRAVITY_MCP_TOOL_PREFIX}read_file`;
const tempDirsToClean: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

beforeEach(() => clearAntigravityCliBinaryCache());

afterEach(() => {
  while (tempDirsToClean.length > 0) {
    const dir = tempDirsToClean.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

interface InteractiveChild extends EventEmitter {
  pid?: number;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
  cwd: string;
  env: Record<string, string | undefined>;
  writtenLines: string[];
  emitStdoutFrame: (frame: Record<string, unknown>) => void;
  crash: (code?: number) => void;
}

function createInteractiveChild(options: {
  pid?: number;
  cwd: string;
  env?: Record<string, string | undefined>;
  onStdinLine?: (line: string, child: InteractiveChild) => void;
} ): InteractiveChild {
  const child = new EventEmitter() as InteractiveChild;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.pid = options.pid ?? 61001;
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.exitCode = null;
  child.cwd = options.cwd;
  child.env = options.env ?? {};
  child.writtenLines = [];

  let stdinBuf = "";
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinBuf += String(chunk);
      let nl = stdinBuf.indexOf("\n");
      while (nl >= 0) {
        const line = stdinBuf.slice(0, nl);
        stdinBuf = stdinBuf.slice(nl + 1);
        if (line.length > 0) {
          child.writtenLines.push(line);
          options.onStdinLine?.(line, child);
        }
        nl = stdinBuf.indexOf("\n");
      }
      cb();
    },
  });

  child.emitStdoutFrame = frame => {
    if (!stdout.writableEnded) stdout.write(`${JSON.stringify(frame)}\n`);
  };
  child.crash = (code = 1) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    stdout.end();
    stderr.end();
    queueMicrotask(() => child.emit("close", code));
  };
  child.kill = () => {
    child.killed = true;
    stdout.end();
    stderr.end();
    if (child.exitCode === null) {
      child.exitCode = 143;
      queueMicrotask(() => child.emit("close", 143));
    }
    return true;
  };
  return child;
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "antigravity-cli",
    baseUrl: ANTIGRAVITY_CLI_PROFILE.canonicalBaseUrl,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    ...overrides,
  } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "gemini-4-carbon",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    },
    ...overrides,
  } as OcxParsedRequest;
}

function toolRequest(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return parsed({
    context: {
      messages: [{ role: "user", content: "Read README.md", timestamp: 0 }],
      tools: [{
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
    },
    ...overrides,
  });
}

async function runTurn(
  adapter: ReturnType<typeof createAntigravityCliAdapter>,
  req: OcxParsedRequest,
  abortSignal?: AbortSignal,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(
    req,
    {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
      ...(abortSignal ? { abortSignal } : {}),
    },
    event => events.push(event),
  );
  return events;
}

function pollUntil(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("pollUntil timed out"));
      setTimeout(check, 5);
    };
    check();
  });
}

describe("antigravity-cli Stage 4 session pool hardening, F11 streaming, and U3 truncation", () => {
  test("1) reuses warm process for tool_results and multi-block user_followup (\\n\\n separated), normalizes CRLF, clears stale queued frames, and isolates distinct sessions", async () => {
    const pool = new AntigravitySessionPool();
    const spawned: InteractiveChild[] = [];
    let activeTurn = 0;

    try {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        enableSessionPool: true,
        sessionPool: pool,
        toolBatchCoalesceMs: 10,
        spawn: (_cmd, _args, opts) => {
          const idx = spawned.length;
          const child = createInteractiveChild({
            pid: 7000 + idx,
            cwd: String(opts.cwd),
            onStdinLine: (_line, c) => {
              activeTurn += 1;
              if (idx === 0 && activeTurn === 1) {
                // Turn 1: park on tool call
                const capturePath = join(c.cwd, "captured-calls.jsonl");
                writeFileSync(capturePath, `${JSON.stringify({ seq: 1, name: "read_file", arguments: { path: "README.md" } })}\n`);
                c.emitStdoutFrame({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } });
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: {
                    step_index: 1,
                    state: "ACTIVE",
                    step_type: "tool",
                    tool_name: BRIDGED_READ_TOOL,
                    tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
                  },
                });
              } else if (idx === 0 && activeTurn === 3) {
                // Turn 3 (idle_after_stop user_followup): respond to follow-up, then push a stray stale frame after result
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: { step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "Follow-up answered." },
                });
                c.emitStdoutFrame({
                  event: "result",
                  result: { status: "SUCCESS", response: "Follow-up answered." },
                });
                queueMicrotask(() => {
                  c.emitStdoutFrame({
                    event: "step_update",
                    step_update: { step_index: 99, state: "DONE", step_type: "agent_response", text_delta: "STALE_FRAME_SHOULD_NOT_LEAK" },
                  });
                });
              } else if (idx === 0 && activeTurn === 4) {
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: { step_index: 4, state: "DONE", step_type: "agent_response", text_delta: "Turn 4 clean." },
                });
                c.emitStdoutFrame({
                  event: "result",
                  result: { status: "SUCCESS", response: "Turn 4 clean." },
                });
              } else {
                // Session B (idx === 1)
                c.emitStdoutFrame({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } });
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "Session B ok." },
                });
                c.emitStdoutFrame({
                  event: "result",
                  result: { status: "SUCCESS", response: "Session B ok." },
                });
              }
            },
          });
          spawned.push(child);
          return child as unknown as ChildProcess;
        },
      });

      // Turn 1: initial tool call on Session A
      const t1 = await runTurn(adapter, toolRequest());
      const callStart = t1.find(e => e.type === "tool_call_start") as Extract<AdapterEvent, { type: "tool_call_start" }>;
      expect(callStart.name).toBe("read_file");
      expect(spawned).toHaveLength(1);

      // Turn 2: tool_results continuation -> writes tool-results.jsonl, emits CRLF assistant text, parks idle_after_stop
      const t2Req = toolRequest({
        context: {
          messages: [
            { role: "user", content: "Read README.md", timestamp: 0 },
            { role: "assistant", content: [{ type: "toolCall", id: callStart.id, name: "read_file", arguments: { path: "README.md" } }], timestamp: 1 },
            { role: "toolResult", toolCallId: callStart.id, toolName: "read_file", content: [{ type: "text", text: "Hello README" }], timestamp: 2 },
          ],
          tools: toolRequest().context.tools,
        },
      });
      const resultsFile = join(spawned[0]!.cwd, "tool-results.jsonl");
      const t2Promise = runTurn(adapter, t2Req);
      await pollUntil(() => existsSync(resultsFile) && readFileSync(resultsFile, "utf8").includes('"seq":1'));
      activeTurn = 2;
      spawned[0]!.emitStdoutFrame({
        event: "step_update",
        step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "Line 1\r\nLine 2" },
      });
      spawned[0]!.emitStdoutFrame({
        event: "result",
        result: { status: "SUCCESS", response: "Line 1\r\nLine 2" },
      });
      const t2 = await t2Promise;
      expect(t2).toEqual([
        { type: "text_delta", text: "Line 1\r\nLine 2" },
        { type: "done", stopReason: "stop" },
      ]);
      expect(spawned).toHaveLength(1);

      // Turn 3: idle_after_stop continuation with LF-normalized echoed assistant text + TWO trailing user blocks
      const t3Req = toolRequest({
        context: {
          messages: [
            ...t2Req.context.messages,
            { role: "assistant", content: [{ type: "text", text: "Line 1\nLine 2" }], timestamp: 3 },
            { role: "user", content: "Followup block one", timestamp: 4 },
            { role: "user", content: "Followup block two", timestamp: 5 },
          ],
          tools: toolRequest().context.tools,
        },
      });
      const t3 = await runTurn(adapter, t3Req);
      expect(t3).toEqual([
        { type: "text_delta", text: "Follow-up answered." },
        { type: "done", stopReason: "stop" },
      ]);
      expect(spawned).toHaveLength(1);
      const followupFrame = JSON.parse(spawned[0]!.writtenLines.at(-1)!) as {
        event: string;
        message: { content: Array<{ type: string; text: string }> };
      };
      const joinedFollowup = followupFrame.message.content.map(part => part.text).join("");
      expect(joinedFollowup).toBe("USER:\nFollowup block one\n\nUSER:\nFollowup block two");

      // Let stray stale frame push into frameQueue while parked, then verify Turn 4 markTurnStart() clears it
      await new Promise(resolve => setTimeout(resolve, 15));
      const t4Req = toolRequest({
        context: {
          messages: [
            ...t3Req.context.messages,
            { role: "assistant", content: [{ type: "text", text: "Follow-up answered." }], timestamp: 6 },
            { role: "user", content: "Turn 4 prompt", timestamp: 7 },
          ],
          tools: toolRequest().context.tools,
        },
      });
      const t4 = await runTurn(adapter, t4Req);
      expect(t4).toEqual([
        { type: "text_delta", text: "Turn 4 clean." },
        { type: "done", stopReason: "stop" },
      ]);
      expect(spawned).toHaveLength(1);

      // Different session starting message must NOT match Session A
      const otherSessionEvents = await runTurn(
        adapter,
        toolRequest({
          context: {
            messages: [{ role: "user", content: "Completely different session", timestamp: 0 }],
            tools: toolRequest().context.tools,
          },
        }),
      );
      expect(otherSessionEvents).toEqual([
        { type: "text_delta", text: "Session B ok." },
        { type: "done", stopReason: "stop" },
      ]);
      expect(spawned).toHaveLength(2);
    } finally {
      await pool.disposeAll();
    }
  });

  test("2) never reuses warm session when tools, modelId, reasoning effort, system rules, or baseUrl change", async () => {
    const pool = new AntigravitySessionPool();
    let spawnCount = 0;

    try {
      const makeAdapter = (baseUrl = ANTIGRAVITY_CLI_PROFILE.canonicalBaseUrl) =>
        createAntigravityCliAdapter(provider({ baseUrl }), {
          which: () => "/bin/agy",
          platform: "linux",
          enableSessionPool: true,
          sessionPool: pool,
          spawn: (_cmd, _args, opts) => {
            spawnCount += 1;
            return createInteractiveChild({
              pid: 7100 + spawnCount,
              cwd: String(opts.cwd),
              onStdinLine: (_line, c) => {
                c.emitStdoutFrame({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } });
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "ok" },
                });
                c.emitStdoutFrame({ event: "result", result: { status: "SUCCESS", response: "ok" } });
              },
            }) as unknown as ChildProcess;
          },
        });

      const baseAdapter = makeAdapter();
      const baseTools = toolRequest().context.tools!;
      const baseMsgs = [
        { role: "user" as const, content: "step 1", timestamp: 0 },
      ];
      await runTurn(baseAdapter, parsed({
        modelId: "gemini-4-carbon",
        options: { reasoning: "medium" },
        context: { systemPrompt: ["Sys A"], messages: baseMsgs, tools: baseTools },
      }));
      expect(spawnCount).toBe(1);

      const followupMsgs = [
        ...baseMsgs,
        { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], timestamp: 1 },
        { role: "user" as const, content: "step 2", timestamp: 2 },
      ];

      // Tools changed
      await runTurn(baseAdapter, parsed({
        modelId: "gemini-4-carbon",
        options: { reasoning: "medium" },
        context: {
          systemPrompt: ["Sys A"],
          messages: followupMsgs,
          tools: [...baseTools, { name: "write_file", description: "Write", parameters: { type: "object", properties: {} } }],
        },
      }));
      expect(spawnCount).toBe(2);

      // modelId changed
      await runTurn(baseAdapter, parsed({
        modelId: "gemini-4-argon",
        options: { reasoning: "medium" },
        context: { systemPrompt: ["Sys A"], messages: followupMsgs, tools: baseTools },
      }));
      expect(spawnCount).toBe(3);

      // reasoning effort changed
      await runTurn(baseAdapter, parsed({
        modelId: "gemini-4-carbon",
        options: { reasoning: "high" },
        context: { systemPrompt: ["Sys A"], messages: followupMsgs, tools: baseTools },
      }));
      expect(spawnCount).toBe(4);

      // systemPrompt changed
      await runTurn(baseAdapter, parsed({
        modelId: "gemini-4-carbon",
        options: { reasoning: "medium" },
        context: { systemPrompt: ["Sys B"], messages: followupMsgs, tools: baseTools },
      }));
      expect(spawnCount).toBe(5);

      // baseUrl change invalidates signature (also verify canonical trailing-slash variant at adapter level)
      expect(
        buildAntigravitySessionSignature({
          baseUrl: "https://antigravity.google",
          resolvedModelSlug: "gemini-4-carbon-medium",
          rulesMarkdown: "Sys A",
          toolsCatalogJson: "[]",
        }),
      ).not.toBe(
        buildAntigravitySessionSignature({
          baseUrl: "https://staging.antigravity.google",
          resolvedModelSlug: "gemini-4-carbon-medium",
          rulesMarkdown: "Sys A",
          toolsCatalogJson: "[]",
        }),
      );
      const trailingSlashAdapter = makeAdapter(`${ANTIGRAVITY_CLI_PROFILE.canonicalBaseUrl}/`);
      await runTurn(trailingSlashAdapter, parsed({
        modelId: "gemini-4-carbon",
        options: { reasoning: "medium" },
        context: { systemPrompt: ["Sys A"], messages: followupMsgs, tools: baseTools },
      }));
      expect(spawnCount).toBe(6);
    } finally {
      await pool.disposeAll();
    }
  });

  test("3) enforces maxEntries=4 LRU eviction, 90s idle TTL eviction, and Windows killWindowsProcessTree (taskkill /T /F)", async () => {
    const brainRoot = makeTempDir("ocx-ag-pool-brain-");
    const scheduledTimers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const fakeSetTimeout = ((fn: () => void, ms: number) => {
      const rec = { fn, ms, cleared: false };
      scheduledTimers.push(rec);
      return rec as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const fakeClearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      const rec = handle as unknown as { cleared?: boolean };
      if (rec) rec.cleared = true;
    }) as unknown as typeof clearTimeout;

    const pool = new AntigravitySessionPool(4, 90_000);
    const children: InteractiveChild[] = [];
    const killedWinPids: number[] = [];

    try {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "C:\\agy\\agy.exe",
        platform: "win32",
        isolatedHomeDir: false,
        brainDir: brainRoot,
        enableSessionPool: true,
        sessionPool: pool,
        setTimeout: fakeSetTimeout,
        clearTimeout: fakeClearTimeout,
        killWindowsProcessTree: pid => {
          killedWinPids.push(pid);
          const target = children.find(c => c.pid === pid);
          target?.kill("SIGKILL");
        },
        spawn: (_cmd, _args, opts) => {
          const idx = children.length;
          const convId = `11111111-1111-4111-8111-${String(idx + 1).padStart(12, "0")}`;
          const child = createInteractiveChild({
            pid: 8100 + idx,
            cwd: String(opts.cwd),
            onStdinLine: (_line, c) => {
              mkdirSync(join(brainRoot, convId), { recursive: true });
              c.emitStdoutFrame({ event: "init", conversation_id: convId, init: { tools: [] } });
              c.emitStdoutFrame({
                event: "step_update",
                step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: `reply-${idx}` },
              });
              c.emitStdoutFrame({ event: "result", result: { status: "SUCCESS", response: `reply-${idx}` } });
            },
          });
          children.push(child);
          return child as unknown as ChildProcess;
        },
      });

      // Spawn S0, S1, S2, S3
      for (let i = 0; i < 4; i++) {
        await runTurn(adapter, parsed({ context: { messages: [{ role: "user", content: `session-${i}`, timestamp: 0 }] } }));
      }
      expect(pool.idleCount).toBe(4);
      expect(children).toHaveLength(4);

      // Touch S0 so S1 becomes LRU
      await runTurn(adapter, parsed({
        context: {
          messages: [
            { role: "user", content: "session-0", timestamp: 0 },
            { role: "assistant", content: [{ type: "text", text: "reply-0" }], timestamp: 1 },
            { role: "user", content: "session-0-turn2", timestamp: 2 },
          ],
        },
      }));
      expect(children).toHaveLength(4);

      // Spawn S4 -> evicts S1 (LRU), kills via Windows process tree, removes turnDir + brain/<convId>
      await runTurn(adapter, parsed({ context: { messages: [{ role: "user", content: "session-4", timestamp: 0 }] } }));
      expect(children).toHaveLength(5);
      expect(pool.idleCount).toBe(4);
      await pollUntil(() => !existsSync(children[1]!.cwd) && !existsSync(join(brainRoot, "11111111-1111-4111-8111-000000000002")));
      expect(killedWinPids).toContain(8101);
      expect(existsSync(children[0]!.cwd)).toBe(true);

      // Fire 90s TTL timers for remaining idle sessions (S2, S3, S0, S4)
      const ttlTimers = scheduledTimers.filter(t => t.ms === 90_000 && !t.cleared);
      expect(ttlTimers).toHaveLength(4);
      for (const t of ttlTimers) t.fn();

      await pollUntil(() =>
        pool.idleCount === 0
        && pool.liveCount === 0
        && children.every(c => !existsSync(c.cwd)),
      );
      expect(killedWinPids).toEqual(expect.arrayContaining([8100, 8101, 8102, 8103, 8104]));
    } finally {
      await pool.disposeAll();
    }
  });

  test("4) cleans up process, turnDir, ownedHomeDir, and brain/<id> on abort, stream error, unexpected idle exit, disposeAll(), without deleting shared isolatedHomeDir", async () => {
    // 4a. Shared isolatedHomeDir string: deletes brain/<convId> & turnDir, preserves sharedHome + marker file
    const sharedHome = makeTempDir("ocx-ag-shared-home-");
    const markerFile = join(sharedHome, "keep-shared.txt");
    writeFileSync(markerFile, "must-remain");

    const pool = new AntigravitySessionPool();
    const convA = "22222222-2222-4222-8222-000000000001";
    const convB = "22222222-2222-4222-8222-000000000002";
    const convC = "22222222-2222-4222-8222-000000000003";
    let childIdx = 0;
    const spawnedChildren: InteractiveChild[] = [];

    try {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        isolatedHomeDir: sharedHome,
        enableSessionPool: true,
        sessionPool: pool,
        spawn: (_cmd, _args, opts) => {
          const idx = childIdx++;
          const child = createInteractiveChild({
            pid: 9100 + idx,
            cwd: String(opts.cwd),
            onStdinLine: (_line, c) => {
              if (idx === 0) {
                // AbortSignal scenario
                const brainEntry = join(sharedHome, ".gemini", "antigravity-cli", "brain", convA);
                mkdirSync(brainEntry, { recursive: true });
                c.emitStdoutFrame({ event: "init", conversation_id: convA, init: { tools: [] } });
              } else if (idx === 1) {
                // Stream protocol error scenario (malformed JSON line)
                const brainEntry = join(sharedHome, ".gemini", "antigravity-cli", "brain", convB);
                mkdirSync(brainEntry, { recursive: true });
                c.emitStdoutFrame({ event: "init", conversation_id: convB, init: { tools: [] } });
                c.stdout.write("{malformed-json\n");
              } else {
                // Unexpected idle exit & disposeAll scenario
                const brainEntry = join(sharedHome, ".gemini", "antigravity-cli", "brain", convC);
                mkdirSync(brainEntry, { recursive: true });
                c.emitStdoutFrame({ event: "init", conversation_id: convC, init: { tools: [] } });
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "parked" },
                });
                c.emitStdoutFrame({ event: "result", result: { status: "SUCCESS", response: "parked" } });
              }
            },
          });
          spawnedChildren.push(child);
          return child as unknown as ChildProcess;
        },
      });

      // (a) AbortSignal cancellation mid-turn
      const ac = new AbortController();
      const abortTurn = runTurn(
        adapter,
        parsed({ context: { messages: [{ role: "user", content: "abort me", timestamp: 0 }] } }),
        ac.signal,
      );
      await pollUntil(() => existsSync(join(sharedHome, ".gemini", "antigravity-cli", "brain", convA)));
      ac.abort();
      const abortEvents = await abortTurn;
      expect(abortEvents.at(-1)).toEqual(expect.objectContaining({ type: "error" }));
      await pollUntil(() =>
        !existsSync(spawnedChildren[0]!.cwd)
        && !existsSync(join(sharedHome, ".gemini", "antigravity-cli", "brain", convA)),
      );
      expect(pool.liveCount).toBe(0);
      expect(existsSync(markerFile)).toBe(true);

      // (b) Stream error
      const errEvents = await runTurn(
        adapter,
        parsed({ context: { messages: [{ role: "user", content: "bad json", timestamp: 0 }] } }),
      );
      expect(errEvents.at(-1)).toEqual(expect.objectContaining({ type: "error", status: 502, code: "protocol_error" }));
      await pollUntil(() =>
        !existsSync(spawnedChildren[1]!.cwd)
        && !existsSync(join(sharedHome, ".gemini", "antigravity-cli", "brain", convB)),
      );
      expect(pool.liveCount).toBe(0);
      expect(existsSync(markerFile)).toBe(true);

      // (c) Unexpected idle child crash while parked -> immediately evicted & cleaned before 90s TTL
      await runTurn(
        adapter,
        parsed({ context: { messages: [{ role: "user", content: "crash while idle", timestamp: 0 }] } }),
      );
      expect(pool.idleCount).toBe(1);
      expect(pool.liveCount).toBe(1);
      spawnedChildren[2]!.crash(137);
      await pollUntil(() =>
        pool.idleCount === 0
        && pool.liveCount === 0
        && !existsSync(spawnedChildren[2]!.cwd)
        && !existsSync(join(sharedHome, ".gemini", "antigravity-cli", "brain", convC)),
      );
      expect(existsSync(markerFile)).toBe(true);

      // (d) disposeAll() tears down parked live sessions completely
      await runTurn(
        adapter,
        parsed({ context: { messages: [{ role: "user", content: "park for disposeAll", timestamp: 0 }] } }),
      );
      expect(pool.liveCount).toBe(1);
      await pool.disposeAll();
      expect(pool.liveCount).toBe(0);
      expect(pool.idleCount).toBe(0);
      expect(existsSync(spawnedChildren[3]!.cwd)).toBe(false);
      expect(existsSync(markerFile)).toBe(true);
    } finally {
      await pool.disposeAll();
    }
  });

  test("5) handles concurrent requests for the same warm session safely without sharing stdin/stdout", async () => {
    const pool = new AntigravitySessionPool();
    const children: InteractiveChild[] = [];

    try {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        enableSessionPool: true,
        sessionPool: pool,
        spawn: (_cmd, _args, opts) => {
          const idx = children.length;
          let turnNum = 0;
          const child = createInteractiveChild({
            pid: 9200 + idx,
            cwd: String(opts.cwd),
            onStdinLine: (_line, c) => {
              turnNum += 1;
              const label = idx === 0 && turnNum === 1
                ? "initial"
                : `child-${idx}-turn-${turnNum}`;
              const delayMs = idx === 0 && turnNum === 2 ? 25 : 10;
              setTimeout(() => {
                if (turnNum === 1) {
                  c.emitStdoutFrame({ event: "init", init: { tools: [] } });
                }
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: { step_index: turnNum, state: "DONE", step_type: "agent_response", text_delta: label },
                });
                c.emitStdoutFrame({ event: "result", result: { status: "SUCCESS", response: label } });
              }, delayMs);
            },
          });
          children.push(child);
          return child as unknown as ChildProcess;
        },
      });

      const t1 = await runTurn(adapter, parsed({
        context: { messages: [{ role: "user", content: "start", timestamp: 0 }] },
      }));
      expect(t1).toEqual([
        { type: "text_delta", text: "initial" },
        { type: "done", stopReason: "stop" },
      ]);
      expect(children).toHaveLength(1);

      const concurrentReq = parsed({
        context: {
          messages: [
            { role: "user", content: "start", timestamp: 0 },
            { role: "assistant", content: [{ type: "text", text: "initial" }], timestamp: 1 },
            { role: "user", content: "concurrent followup", timestamp: 2 },
          ],
        },
      });

      const [resA, resB] = await Promise.all([
        runTurn(adapter, concurrentReq),
        runTurn(adapter, concurrentReq),
      ]);
      expect(children).toHaveLength(2);
      expect(children[0]!.writtenLines).toHaveLength(2);
      expect(children[1]!.writtenLines).toHaveLength(1);
      expect(resA).toEqual([
        { type: "text_delta", text: "child-0-turn-2" },
        { type: "done", stopReason: "stop" },
      ]);
      expect(resB).toEqual([
        { type: "text_delta", text: "child-1-turn-1" },
        { type: "done", stopReason: "stop" },
      ]);
    } finally {
      await pool.disposeAll();
    }
  });

  test("6) F11 streams thinking_delta and text_delta before captured-calls.jsonl is ready, then flushes full untruncated tool_call", async () => {
    const pool = new AntigravitySessionPool();
    const longPathArg = `src/${"x".repeat(900)}.ts`;
    let captureWriteAt = 0;
    const eventTimeline: Array<{ type: string; at: number }> = [];

    try {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        enableSessionPool: true,
        sessionPool: pool,
        toolBatchCoalesceMs: 10,
        undeclaredToolGraceMs: 500,
        spawn: (_cmd, _args, opts) => {
          const child = createInteractiveChild({
            pid: 9301,
            cwd: String(opts.cwd),
            onStdinLine: (_line, c) => {
              c.emitStdoutFrame({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } });
              c.emitStdoutFrame({
                event: "step_update",
                step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", thinking_delta: "Inspecting target file..." },
              });
              c.emitStdoutFrame({
                event: "step_update",
                step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "Calling read_file now." },
              });
              setTimeout(() => {
                const capturePath = join(c.cwd, "captured-calls.jsonl");
                captureWriteAt = performance.now();
                writeFileSync(
                  capturePath,
                  `${JSON.stringify({ seq: 1, name: "read_file", arguments: { path: longPathArg } })}\n`,
                );
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: {
                    step_index: 2,
                    state: "ACTIVE",
                    step_type: "tool",
                    tool_name: BRIDGED_READ_TOOL,
                    tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: `${longPathArg.slice(0, 512)}…` } },
                  },
                });
              }, 60);
            },
          });
          return child as unknown as ChildProcess;
        },
      });

      const events: AdapterEvent[] = [];
      await adapter.runTurn!(
        toolRequest(),
        {
          headers: new Headers(),
          translatorBudget: createTestTranslatorBudget(),
        },
        event => {
          events.push(event);
          eventTimeline.push({ type: event.type, at: performance.now() });
        },
      );

      const thinkingEntry = eventTimeline.find(e => e.type === "thinking_delta");
      const textEntry = eventTimeline.find(e => e.type === "text_delta");
      expect(thinkingEntry).toBeDefined();
      expect(textEntry).toBeDefined();
      expect(captureWriteAt).toBeGreaterThan(0);
      expect(thinkingEntry!.at).toBeLessThan(captureWriteAt);
      expect(textEntry!.at).toBeLessThan(captureWriteAt);

      expect(events).toEqual([
        { type: "thinking_delta", thinking: "Inspecting target file..." },
        { type: "text_delta", text: "Calling read_file now." },
        expect.objectContaining({ type: "tool_call_start", name: "read_file" }),
        { type: "tool_call_delta", arguments: JSON.stringify({ path: longPathArg }) },
        { type: "tool_call_end" },
        { type: "done", stopReason: "tool_use", endTurn: false },
      ]);
    } finally {
      await pool.disposeAll();
    }
  });

  test("7) U3 truncates >220 KB cold-start history from head within 180k limit while allowing >320 KB warm continuation without cold restart", async () => {
    const pool = new AntigravitySessionPool();
    const coldSpawnStdin: string[] = [];
    const warmSpawnStdin: string[][] = [];

    try {
      // 7a. Cold start with >220 KB history -> head-truncated to <=180k chars, keeping latest canary
      const coldAdapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        enableSessionPool: true,
        sessionPool: pool,
        spawn: (_cmd, _args, opts) => {
          return createInteractiveChild({
            pid: 9401,
            cwd: String(opts.cwd),
            onStdinLine: (line, c) => {
              coldSpawnStdin.push(line);
              c.emitStdoutFrame({ event: "init", init: { tools: [] } });
              c.emitStdoutFrame({
                event: "step_update",
                step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "cold ok" },
              });
              c.emitStdoutFrame({ event: "result", result: { status: "SUCCESS", response: "cold ok" } });
            },
          }) as unknown as ChildProcess;
        },
      });

      const oldMessages: OcxParsedRequest["context"]["messages"] = [];
      for (let i = 0; i < 6; i++) {
        oldMessages.push({
          role: "user",
          content: `HEAD_BLOCK_${i}_${"a".repeat(38_000)}`,
          timestamp: i * 2,
        });
        oldMessages.push({
          role: "assistant",
          content: [{ type: "text", text: `ack_${i}` }],
          timestamp: i * 2 + 1,
        });
      }
      oldMessages.push({
        role: "user",
        content: "LATEST_CANARY_MUST_SURVIVE",
        timestamp: 99,
      });

      const coldEvents = await runTurn(coldAdapter, parsed({ context: { messages: oldMessages } }));
      expect(coldEvents).toEqual([
        { type: "text_delta", text: "cold ok" },
        { type: "done", stopReason: "stop" },
      ]);
      expect(coldSpawnStdin).toHaveLength(1);
      const parsedColdFrame = JSON.parse(coldSpawnStdin[0]!) as { message: { content: Array<{ text: string }> } };
      const coldPayloadText = parsedColdFrame.message.content.map(p => p.text).join("\n\n");
      expect(coldPayloadText).toContain("[Earlier conversation history omitted at a whole-message checkpoint.]");
      expect(coldPayloadText).not.toContain("HEAD_BLOCK_0_");
      expect(coldPayloadText).toContain("LATEST_CANARY_MUST_SURVIVE");
      expect(coldPayloadText.length).toBeLessThanOrEqual(180_000);

      // 7b. Warm continuation accumulates >320 KB across 3 turns without cold restart or losing turn 1
      await pool.disposeAll();
      const warmAdapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        enableSessionPool: true,
        sessionPool: pool,
        spawn: (_cmd, _args, opts) => {
          const linesForChild: string[] = [];
          warmSpawnStdin.push(linesForChild);
          let turn = 0;
          return createInteractiveChild({
            pid: 9402,
            cwd: String(opts.cwd),
            onStdinLine: (line, c) => {
              linesForChild.push(line);
              turn += 1;
              if (turn === 1) c.emitStdoutFrame({ event: "init", init: { tools: [] } });
              const reply = `warm-reply-${turn}`;
              c.emitStdoutFrame({
                event: "step_update",
                step_update: { step_index: turn, state: "DONE", step_type: "agent_response", text_delta: reply },
              });
              c.emitStdoutFrame({ event: "result", result: { status: "SUCCESS", response: reply } });
            },
          }) as unknown as ChildProcess;
        },
      });

      const chunk1 = `WARM_HEAD_${"b".repeat(120_000)}`;
      const chunk2 = `WARM_MID_${"c".repeat(110_000)}`;
      const chunk3 = `WARM_TAIL_${"d".repeat(110_000)}`; // Total > 340 KB

      const w1 = await runTurn(warmAdapter, parsed({
        context: { messages: [{ role: "user", content: chunk1, timestamp: 0 }] },
      }));
      expect(w1).toEqual([{ type: "text_delta", text: "warm-reply-1" }, { type: "done", stopReason: "stop" }]);

      const msgs2: OcxParsedRequest["context"]["messages"] = [
        { role: "user", content: chunk1, timestamp: 0 },
        { role: "assistant", content: [{ type: "text", text: "warm-reply-1" }], timestamp: 1 },
        { role: "user", content: chunk2, timestamp: 2 },
      ];
      const w2 = await runTurn(warmAdapter, parsed({ context: { messages: msgs2 } }));
      expect(w2).toEqual([{ type: "text_delta", text: "warm-reply-2" }, { type: "done", stopReason: "stop" }]);

      const msgs3: OcxParsedRequest["context"]["messages"] = [
        ...msgs2,
        { role: "assistant", content: [{ type: "text", text: "warm-reply-2" }], timestamp: 3 },
        { role: "user", content: chunk3, timestamp: 4 },
      ];
      const w3 = await runTurn(warmAdapter, parsed({ context: { messages: msgs3 } }));
      expect(w3).toEqual([{ type: "text_delta", text: "warm-reply-3" }, { type: "done", stopReason: "stop" }]);

      // Must reuse the single warm process across all 3 turns (>340 KB total) with incremental frames only
      expect(warmSpawnStdin).toHaveLength(1);
      expect(warmSpawnStdin[0]).toHaveLength(3);
      expect(warmSpawnStdin[0]![1]!).not.toContain("WARM_HEAD_");
      expect(warmSpawnStdin[0]![2]!).toContain("WARM_TAIL_");
      expect(warmSpawnStdin[0]![2]!).not.toContain("WARM_HEAD_");
      expect(warmSpawnStdin[0]![2]!).not.toContain("WARM_MID_");
    } finally {
      await pool.disposeAll();
    }
  });

  test("8) handles both cumulative and per-turn-reset agy usage baselines across warm turns", async () => {
    const pool = new AntigravitySessionPool();
    let turn = 0;

    try {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        enableSessionPool: true,
        sessionPool: pool,
        spawn: (_cmd, _args, opts) => {
          return createInteractiveChild({
            pid: 9501,
            cwd: String(opts.cwd),
            onStdinLine: (_line, c) => {
              turn += 1;
              if (turn === 1) {
                c.emitStdoutFrame({ event: "init", init: { tools: [] } });
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "r1" },
                });
                c.emitStdoutFrame({
                  event: "result",
                  result: {
                    status: "SUCCESS",
                    response: "r1",
                    usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050 },
                  },
                });
              } else if (turn === 2) {
                // Simulate agy resetting per-turn usage (250 < 1000 baseline)
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "r2" },
                });
                c.emitStdoutFrame({
                  event: "result",
                  result: {
                    status: "SUCCESS",
                    response: "r2",
                    usage: { input_tokens: 250, output_tokens: 30, total_tokens: 280 },
                  },
                });
              } else {
                // Turn 3 builds cumulatively on Turn 2's reset baseline (400 - 250 = 150)
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: { step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "r3" },
                });
                c.emitStdoutFrame({
                  event: "result",
                  result: {
                    status: "SUCCESS",
                    response: "r3",
                    usage: { input_tokens: 400, output_tokens: 50, total_tokens: 450 },
                  },
                });
              }
            },
          }) as unknown as ChildProcess;
        },
      });

      const e1 = await runTurn(adapter, parsed({
        context: { messages: [{ role: "user", content: "u1", timestamp: 0 }] },
      }));
      expect(e1.at(-1)).toEqual({
        type: "done",
        stopReason: "stop",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
      });

      const msgs2: OcxParsedRequest["context"]["messages"] = [
        { role: "user", content: "u1", timestamp: 0 },
        { role: "assistant", content: [{ type: "text", text: "r1" }], timestamp: 1 },
        { role: "user", content: "u2", timestamp: 2 },
      ];
      await runTurn(adapter, parsed({ context: { messages: msgs2 } }));

      const msgs3: OcxParsedRequest["context"]["messages"] = [
        ...msgs2,
        { role: "assistant", content: [{ type: "text", text: "r2" }], timestamp: 3 },
        { role: "user", content: "u3", timestamp: 4 },
      ];
      const e3 = await runTurn(adapter, parsed({ context: { messages: msgs3 } }));
      expect(e3.at(-1)).toEqual({
        type: "done",
        stopReason: "stop",
        usage: { inputTokens: 150, outputTokens: 20, totalTokens: 170 },
      });
    } finally {
      await pool.disposeAll();
    }
  });

  test("9) pool.disposeAllSync() kills live warm sessions and synchronously removes turnDir, ownedHomeDir, and brain/<conversationId>", () => {
    const pool = new AntigravitySessionPool();
    const turnDir = makeTempDir("ocx-ag-sync-turn-");
    const ownedHomeDir = makeTempDir("ocx-ag-sync-home-");
    const brainRoot = makeTempDir("ocx-ag-sync-brain-");
    const convId = "33333333-3333-4333-8333-000000000009";
    const brainEntry = join(brainRoot, convId);
    mkdirSync(brainEntry, { recursive: true });
    writeFileSync(join(turnDir, "settings.json"), "{}");
    writeFileSync(join(ownedHomeDir, "update.lock"), "locked");
    writeFileSync(join(brainEntry, "state.json"), "{}");

    const killedWinPids: number[] = [];
    let childRef: InteractiveChild | undefined;

    const session = new WarmAntigravitySession({
      signature: "sync-sig",
      binary: "C:\\agy\\agy.exe",
      args: ["--headless"],
      env: {},
      cwd: turnDir,
      turnDir,
      ownedHomeDir,
      effectiveHomeDir: ownedHomeDir,
      capturePath: join(turnDir, "captured-calls.jsonl"),
      resultsPath: join(turnDir, "tool-results.jsonl"),
      platform: "win32",
      brainDirOverride: brainRoot,
      killWindowsProcessTree: pid => {
        killedWinPids.push(pid);
        childRef?.kill("SIGKILL");
      },
      spawnFn: (_cmd, _args, opts) => {
        childRef = createInteractiveChild({
          pid: 9601,
          cwd: String(opts.cwd),
        });
        return childRef as unknown as ChildProcess;
      },
    });
    session.conversationId = convId;
    session.mode = "idle_after_stop";

    pool.registerLive(session);
    pool.park(session);
    expect(pool.liveCount).toBe(1);
    expect(pool.idleCount).toBe(1);

    pool.disposeAllSync();

    expect(pool.liveCount).toBe(0);
    expect(pool.idleCount).toBe(0);
    expect(session.mode).toBe("disposed");
    expect(killedWinPids).toEqual([9601]);
    expect(existsSync(turnDir)).toBe(false);
    expect(existsSync(ownedHomeDir)).toBe(false);
    expect(existsSync(brainEntry)).toBe(false);
  });

  test("10) removeAntigravityPathSyncBestEffort retries transient EBUSY/EPERM/ENOTEMPTY/EACCES errors and stays zero-overhead when unlocked", () => {
    const cleanSleeps: number[] = [];
    let cleanCalls = 0;
    removeAntigravityPathSyncBestEffort(
      "C:\\temp\\unlocked-dir",
      () => {
        cleanCalls += 1;
      },
      ms => cleanSleeps.push(ms),
    );
    expect(cleanCalls).toBe(1);
    expect(cleanSleeps).toEqual([]);

    const transientCodes = ["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"] as const;
    const retrySleeps: number[] = [];
    let attempts = 0;
    removeAntigravityPathSyncBestEffort(
      "C:\\temp\\locked-dir",
      () => {
        const idx = attempts++;
        if (idx < transientCodes.length) {
          const err = new Error(`locked:${transientCodes[idx]}`) as NodeJS.ErrnoException;
          err.code = transientCodes[idx];
          throw err;
        }
      },
      ms => retrySleeps.push(ms),
    );
    expect(attempts).toBe(5);
    expect(retrySleeps).toEqual([40, 40, 40, 40]);

    const exhaustedSleeps: number[] = [];
    let exhaustedAttempts = 0;
    expect(() =>
      removeAntigravityPathSyncBestEffort(
        "C:\\temp\\permanently-locked-dir",
        () => {
          exhaustedAttempts += 1;
          const err = new Error("still busy") as NodeJS.ErrnoException;
          err.code = "EBUSY";
          throw err;
        },
        ms => exhaustedSleeps.push(ms),
      ),
    ).not.toThrow();
    expect(exhaustedAttempts).toBe(6);
    expect(exhaustedSleeps).toEqual([40, 40, 40, 40, 40]);
  });

  test("11) preserves per-step warm tool-turn usage without subtracting usageBaseline across multi-turn Carbon sequence", async () => {
    const pool = new AntigravitySessionPool();
    const spawned: InteractiveChild[] = [];

    try {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        enableSessionPool: true,
        sessionPool: pool,
        toolBatchCoalesceMs: 10,
        spawn: (_cmd, _args, opts) => {
          const child = createInteractiveChild({
            pid: 9701,
            cwd: String(opts.cwd),
            onStdinLine: (_line, c) => {
              // Turn 0: parks on tool call with initial step_update.usage
              writeFileSync(
                join(c.cwd, "captured-calls.jsonl"),
                `${JSON.stringify({ seq: 1, name: "read_file", arguments: { path: "README.md" } })}\n`,
              );
              c.emitStdoutFrame({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } });
              c.emitStdoutFrame({
                event: "step_update",
                step_update: {
                  step_index: 1,
                  state: "DONE",
                  step_type: "agent_response",
                  usage: { input_tokens: 3187, output_tokens: 45, cache_read_tokens: 0, total_tokens: 3232 },
                },
              });
              c.emitStdoutFrame({
                event: "step_update",
                step_update: {
                  step_index: 2,
                  state: "ACTIVE",
                  step_type: "tool",
                  tool_name: BRIDGED_READ_TOOL,
                  tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
                },
              });
            },
          });
          spawned.push(child);
          return child as unknown as ChildProcess;
        },
      });

      // Turn 0
      const t0 = await runTurn(adapter, toolRequest());
      const call0 = t0.find(e => e.type === "tool_call_start") as Extract<AdapterEvent, { type: "tool_call_start" }>;
      expect(call0.name).toBe("read_file");
      expect(t0.at(-1)).toEqual({
        type: "done",
        stopReason: "tool_use",
        endTurn: false,
        usage: {
          inputTokens: 3187,
          outputTokens: 45,
          totalTokens: 3232,
        },
      });
      expect(spawned).toHaveLength(1);

      const resultsFile = join(spawned[0]!.cwd, "tool-results.jsonl");
      const captureFile = join(spawned[0]!.cwd, "captured-calls.jsonl");

      // Turn 1: resumes on warm session, per-step fields all >= Turn 0 baseline (output_tokens=45, input_tokens=3543)
      const t1Msgs: OcxParsedRequest["context"]["messages"] = [
        { role: "user", content: "Read README.md", timestamp: 0 },
        { role: "assistant", content: [{ type: "toolCall", id: call0.id, name: "read_file", arguments: { path: "README.md" } }], timestamp: 1 },
        { role: "toolResult", toolCallId: call0.id, toolName: "read_file", content: [{ type: "text", text: "README body" }], timestamp: 2 },
      ];
      const t1Promise = runTurn(adapter, toolRequest({
        context: { messages: t1Msgs, tools: toolRequest().context.tools },
      }));
      await pollUntil(() => existsSync(resultsFile) && readFileSync(resultsFile, "utf8").includes('"seq":1'));
      writeFileSync(
        captureFile,
        `${readFileSync(captureFile, "utf8")}${JSON.stringify({ seq: 2, name: "read_file", arguments: { path: "package.json" } })}\n`,
      );
      spawned[0]!.emitStdoutFrame({
        event: "step_update",
        step_update: {
          step_index: 3,
          state: "DONE",
          step_type: "agent_response",
          usage: { input_tokens: 3543, output_tokens: 45, cache_read_tokens: 3188, total_tokens: 3588 },
        },
      });
      spawned[0]!.emitStdoutFrame({
        event: "step_update",
        step_update: {
          step_index: 4,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: BRIDGED_READ_TOOL,
          tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "package.json" } },
        },
      });
      const t1 = await t1Promise;
      const call1 = t1.find(e => e.type === "tool_call_start") as Extract<AdapterEvent, { type: "tool_call_start" }>;
      expect(call1.name).toBe("read_file");
      expect(t1.at(-1)).toEqual({
        type: "done",
        stopReason: "tool_use",
        endTurn: false,
        usage: {
          inputTokens: 6731,
          outputTokens: 45,
          totalTokens: 6776,
          cachedInputTokens: 3188,
          cacheReadInputTokens: 3188,
        },
      });
      expect(spawned).toHaveLength(1);

      // Turn 2: resumes and finishes with per-step step_update.usage + cumulative result.usage
      const t2Msgs: OcxParsedRequest["context"]["messages"] = [
        ...t1Msgs,
        { role: "assistant", content: [{ type: "toolCall", id: call1.id, name: "read_file", arguments: { path: "package.json" } }], timestamp: 3 },
        { role: "toolResult", toolCallId: call1.id, toolName: "read_file", content: [{ type: "text", text: '{"name":"ocx"}' }], timestamp: 4 },
      ];
      const t2Promise = runTurn(adapter, toolRequest({
        context: { messages: t2Msgs, tools: toolRequest().context.tools },
      }));
      await pollUntil(() => readFileSync(resultsFile, "utf8").includes('"seq":2'));
      spawned[0]!.emitStdoutFrame({
        event: "step_update",
        step_update: {
          step_index: 5,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "All done.",
          usage: { input_tokens: 200, output_tokens: 60, cache_read_tokens: 6731, total_tokens: 260 },
        },
      });
      spawned[0]!.emitStdoutFrame({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "All done.",
          usage: { input_tokens: 6930, output_tokens: 150, cache_read_tokens: 9919, total_tokens: 7080 },
        },
      });
      const t2 = await t2Promise;
      expect(t2).toEqual([
        { type: "text_delta", text: "All done." },
        {
          type: "done",
          stopReason: "stop",
          usage: {
            inputTokens: 6931,
            outputTokens: 60,
            totalTokens: 6991,
            cachedInputTokens: 6731,
            cacheReadInputTokens: 6731,
          },
        },
      ]);
      expect(spawned).toHaveLength(1);
    } finally {
      await pool.disposeAll();
    }
  });

  test("10) reuses warm session across Claude Desktop mid-conversation developer reminders and trailing tool_result user reminders", async () => {
    const pool = new AntigravitySessionPool();
    const spawned: InteractiveChild[] = [];
    let resultsFile = "";

    try {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        isolatedHomeDir: false,
        enableSessionPool: true,
        sessionPool: pool,
        spawn: (_cmd, _args, opts) => {
          const cwd = String(opts.cwd);
          resultsFile = join(cwd, "tool-results.jsonl");
          let stdinCount = 0;
          const child = createInteractiveChild({
            pid: 9950 + spawned.length,
            cwd,
            onStdinLine: (line, c) => {
              stdinCount += 1;
              const parsedLine = JSON.parse(line) as { event: string; message?: { content?: Array<{ text?: string }> } };
              if (stdinCount === 1) {
                writeFileSync(
                  join(c.cwd, "captured-calls.jsonl"),
                  `${JSON.stringify({ seq: 1, name: "read_file", arguments: { path: "README.md" } })}\n`,
                );
                c.emitStdoutFrame({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } });
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: {
                    step_index: 1,
                    state: "DONE",
                    step_type: "agent_response",
                    usage: { input_tokens: 4000, output_tokens: 30, total_tokens: 4030 },
                  },
                });
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: {
                    step_index: 2,
                    state: "ACTIVE",
                    step_type: "tool",
                    tool_name: BRIDGED_READ_TOOL,
                    tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
                  },
                });
              } else {
                const followText = parsedLine.message?.content?.[0]?.text ?? "";
                const reply = `followup:${followText.includes("[System reminder]")}`;
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: {
                    step_index: 6,
                    state: "DONE",
                    step_type: "agent_response",
                    text_delta: reply,
                    usage: { input_tokens: 120, output_tokens: 20, cached_tokens: 4200, total_tokens: 140 },
                  },
                });
                c.emitStdoutFrame({
                  event: "result",
                  result: { status: "SUCCESS", response: reply },
                });
              }
            },
          });
          spawned.push(child);
          return child as unknown as ChildProcess;
        },
      });

      const styleReminder = "Learning output style is active. Remember to follow the specific guidelines for this style.";
      const tools = toolRequest().context.tools;

      // Turn 0: leading developer instruction + user turn + mid-turn developer reminder
      const t0Msgs: OcxParsedRequest["context"]["messages"] = [
        { role: "developer", content: "Initial workspace policy.", timestamp: 0 },
        { role: "user", content: "Inspect README.md", timestamp: 1 },
        { role: "developer", content: styleReminder, timestamp: 2 },
      ];
      const t0 = await runTurn(adapter, toolRequest({ context: { messages: t0Msgs, tools } }));
      const call0 = t0.find(e => e.type === "tool_call_start") as Extract<AdapterEvent, { type: "tool_call_start" }>;
      expect(call0.name).toBe("read_file");
      expect(spawned).toHaveLength(1);

      // Turn 1: toolResult + trailing <system-reminder> user block + new per-turn developer reminder
      const t1Msgs: OcxParsedRequest["context"]["messages"] = [
        ...t0Msgs,
        { role: "assistant", content: [{ type: "toolCall", id: call0.id, name: "read_file", arguments: { path: "README.md" } }], timestamp: 3 },
        { role: "toolResult", toolCallId: call0.id, toolName: "read_file", content: [{ type: "text", text: "# Hello" }], timestamp: 4 },
        { role: "user", content: "<system-reminder>Tool ran cleanly.</system-reminder>", timestamp: 5 },
        { role: "developer", content: styleReminder, timestamp: 6 },
      ];
      const t1Promise = runTurn(adapter, toolRequest({ context: { messages: t1Msgs, tools } }));
      await pollUntil(() => existsSync(resultsFile) && readFileSync(resultsFile, "utf8").includes('"seq":1'));
      const resultPayload = JSON.parse(readFileSync(resultsFile, "utf8").trim()) as { seq: number; text: string };
      expect(resultPayload.text).toContain("# Hello");
      expect(resultPayload.text).toContain("<system-reminder>Tool ran cleanly.</system-reminder>");
      expect(resultPayload.text).toContain(styleReminder);

      spawned[0]!.emitStdoutFrame({
        event: "step_update",
        step_update: {
          step_index: 3,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "README checked.",
          usage: { input_tokens: 150, output_tokens: 25, cache_read_input_tokens: 4000, total_tokens: 175 },
        },
      });
      spawned[0]!.emitStdoutFrame({
        event: "result",
        result: { status: "SUCCESS", response: "README checked." },
      });
      const t1 = await t1Promise;
      expect(spawned).toHaveLength(1);
      expect(t1.at(-1)).toEqual({
        type: "done",
        stopReason: "stop",
        usage: {
          inputTokens: 4150,
          outputTokens: 25,
          totalTokens: 4175,
          cachedInputTokens: 4000,
          cacheReadInputTokens: 4000,
        },
      });

      // Turn 2: idle_after_stop follow-up with another appended mid-turn developer reminder
      const t2Msgs: OcxParsedRequest["context"]["messages"] = [
        ...t1Msgs,
        { role: "assistant", content: [{ type: "text", text: "README checked." }], timestamp: 7 },
        { role: "user", content: "Summarize it in one line.", timestamp: 8 },
        { role: "developer", content: styleReminder, timestamp: 9 },
      ];
      const t2 = await runTurn(adapter, toolRequest({ context: { messages: t2Msgs, tools } }));
      expect(spawned).toHaveLength(1);
      expect(t2).toEqual([
        { type: "text_delta", text: "followup:true" },
        {
          type: "done",
          stopReason: "stop",
          usage: {
            inputTokens: 4320,
            outputTokens: 20,
            totalTokens: 4340,
            cachedInputTokens: 4200,
            cacheReadInputTokens: 4200,
          },
        },
      ]);
    } finally {
      await pool.disposeAll();
    }
  });

  test("12) trims cold-replay history for large system+tool overhead on mid-thread model switch and retries pre-output forged tool text", async () => {
    const pool = new AntigravitySessionPool();
    const spawnedModels: string[] = [];
    const coldPayloads: string[] = [];

    try {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        isolatedHomeDir: false,
        enableSessionPool: true,
        sessionPool: pool,
        maxPreludeRetries: 1,
        preludeRetryDelayMs: 1,
        spawn: (_cmd, args, opts) => {
          const modelIdx = args.indexOf("--model");
          const modelSlug = modelIdx >= 0 ? String(args[modelIdx + 1]) : "";
          spawnedModels.push(modelSlug);
          const attempt = spawnedModels.length;
          return createInteractiveChild({
            pid: 9980 + attempt,
            cwd: String(opts.cwd),
            onStdinLine: (line, c) => {
              const parsedLine = JSON.parse(line) as { message?: { content?: Array<{ text?: string }> } };
              coldPayloads.push((parsedLine.message?.content ?? []).map(p => p.text ?? "").join(""));
              c.emitStdoutFrame({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } });
              if (attempt === 1) {
                // Attempt 1 emits forged text tool call before any real output -> auto-retried!
                c.emitStdoutFrame({
                  event: "step_update",
                  step_update: {
                    step_index: 1,
                    state: "DONE",
                    step_type: "agent_response",
                    text_delta: `ASSISTANT:\n[Tool call: ${BRIDGED_READ_TOOL} (call_id: fake_1) with args: {}]`,
                  },
                });
                c.emitStdoutFrame({ event: "result", result: { status: "SUCCESS", response: "" } });
                return;
              }
              c.emitStdoutFrame({
                event: "step_update",
                step_update: {
                  step_index: 1,
                  state: "DONE",
                  step_type: "agent_response",
                  text_delta: "Switched to Hydrogen cleanly.",
                },
              });
              c.emitStdoutFrame({ event: "result", result: { status: "SUCCESS", response: "Switched to Hydrogen cleanly." } });
            },
          }) as unknown as ChildProcess;
        },
      });

      const bigSystem = `Workspace guide:\n${"S".repeat(130_000)}`;
      const historyMsgs: OcxParsedRequest["context"]["messages"] = [];
      for (let i = 0; i < 12; i++) {
        historyMsgs.push({ role: "user", content: `turn-${i}:${"H".repeat(14_000)}`, timestamp: i * 2 });
        historyMsgs.push({ role: "assistant", content: [{ type: "text", text: `ans-${i}` }], timestamp: i * 2 + 1 });
      }
      historyMsgs.push({ role: "user", content: "Continue on Hydrogen", timestamp: 99 });

      const events = await runTurn(
        adapter,
        toolRequest({
          modelId: "gemini-4-hydrogen",
          options: { reasoning: "medium" },
          context: {
            systemPrompt: [bigSystem],
            messages: historyMsgs,
            tools: toolRequest().context.tools,
          },
        }),
      );

      expect(spawnedModels).toEqual(["gemini-4-hydrogen-medium", "gemini-4-hydrogen-medium"]);
      expect(coldPayloads[0]!.length).toBeLessThan(110_000);
      expect(coldPayloads[0]).toContain("[Earlier conversation history omitted at a whole-message checkpoint.]");
      expect(coldPayloads[0]).toContain("Continue on Hydrogen");
      expect(events).toEqual([
        { type: "text_delta", text: "Switched to Hydrogen cleanly." },
        { type: "done", stopReason: "stop" },
      ]);
    } finally {
      await pool.disposeAll();
    }
  });
});
