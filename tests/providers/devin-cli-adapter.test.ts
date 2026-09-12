import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  ACP_SESSION_NEW_ID,
  acpUpdateToEvents,
  buildAcpPrompt,
  initializeFrame,
  mapAcpStopReason,
  mapAcpUsage,
  permissionResponseFrame,
  sessionNewFrame,
  sessionPromptFrame,
} from "../../src/adapters/devin-cli/acp";
import { DEVIN_CLI_BIN_ENV, resolveDevinCliBinary } from "../../src/adapters/devin-cli/binary";
import { createDevinCliAdapter } from "../../src/adapters/devin-cli/adapter";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { DEVIN_CLI_MODELS, DEVIN_CLI_MODEL_CONTEXT_WINDOWS, DEVIN_CLI_DEFAULT_MODEL } from "../../src/adapters/devin-cli/models";
import { DEVIN_MODEL_CONTEXT_WINDOWS } from "../../src/adapters/devin/live-models";
import { formatProviderDisplayName, providerIconSrc } from "../../gui/src/provider-icons";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

describe("devin-cli registration", () => {
  test("is an account provider sourced from the installed CLI", () => {
    const entry = PROVIDER_REGISTRY.find((row) => row.id === "devin-cli");
    // The preset streams over Cognition's api-server now: the CLI's own
    // credentials.toml holds an ordinary devin-session-token, so there is no
    // reason to spawn a child to reach the same models.
    expect(entry?.adapter).toBe("devin");
    // `oauth` classifies the ACCOUNT, not the transport, and is what puts the row
    // in the dashboard Accounts tab beside `devin`.
    expect(entry?.authKind).toBe("oauth");
    // Off, or the row is drawn twice: an Accounts login row and a preset tile.
    expect(entry?.dashboardPreset).toBe(false);
    // The ACP adapter is still registered and still constructible — it is simply
    // no longer what this provider id resolves to.
    expect(createDevinCliAdapter({ adapter: "devin-cli", baseUrl: "https://cli.devin.ai" }).name).toBe("devin-cli");
  });

  test("both Devin providers render the Devin mark and a readable name", () => {
    // Neither id had an icon alias, so the dashboard drew a coloured initial
    // tile for both, and the title-cased fallback turned the local one into
    // "Devin Cli".
    expect(providerIconSrc("devin")).toBe("/provider-icons/devin.svg");
    expect(providerIconSrc("devin-cli")).toBe("/provider-icons/devin.svg");
    const englishT = ((_key: string, fallback?: string) => fallback ?? "") as Parameters<typeof formatProviderDisplayName>[1];
    expect(formatProviderDisplayName("devin", englishT)).toBe("Devin");
    expect(formatProviderDisplayName("devin-cli", englishT)).toBe("Devin CLI");
  });

  test("every CLI model carries its context window", () => {
    // The provider shipped without a window table at all, so the picker used the
    // 128k default for the whole roster — including `swe-2`, the default model,
    // whose real window is 262k. A model added to the roster without a window
    // silently reintroduces that, so the table is checked against the roster
    // rather than by spot-checking one id.
    for (const model of DEVIN_CLI_MODELS) {
      expect(DEVIN_CLI_MODEL_CONTEXT_WINDOWS[model]).toBeGreaterThan(0);
    }
    expect(Object.keys(DEVIN_CLI_MODEL_CONTEXT_WINDOWS).sort()).toEqual([...DEVIN_CLI_MODELS].sort());
    expect(DEVIN_CLI_MODEL_CONTEXT_WINDOWS[DEVIN_CLI_DEFAULT_MODEL]).toBe(262_000);

    // The PRESET no longer uses this table: it streams over the cloud transport,
    // so its windows come from the shared Devin table and, at runtime, from the
    // account's own catalog through live discovery. The table above still governs
    // the ACP roster for a custom-named row that selects that adapter.
    const entry = PROVIDER_REGISTRY.find((row) => row.id === "devin-cli");
    expect(entry?.modelContextWindows).toBe(DEVIN_MODEL_CONTEXT_WINDOWS);
    expect(entry?.liveModels).toBe(true);
  });
});

describe("acp handshake frames", () => {
  test("initialize declares protocol 1 and session/new carries cwd", () => {
    expect(initializeFrame("1.2.3")).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: 1, clientInfo: { name: "opencodex", version: "1.2.3" } },
    });
    const withModel = sessionNewFrame("/repo", "swe-2") as { id: number; params: Record<string, unknown> };
    expect(withModel.id).toBe(ACP_SESSION_NEW_ID);
    expect(withModel.params).toEqual({ cwd: "/repo", mcpServers: [], model: "swe-2" });
    // No model named means the CLI picks its own default, so the key is absent
    // rather than present and empty.
    expect((sessionNewFrame("/repo") as { params: Record<string, unknown> }).params).toEqual({ cwd: "/repo", mcpServers: [] });
    expect(sessionPromptFrame("s1", "hi")).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] },
    });
  });

  test("a permission request is refused unless the operator opted in", () => {
    // This provider runs an agent in the operator's own tree. Auto-approving
    // whatever a prompt asks for would make the proxy a remote shell.
    const options = [
      { optionId: "no", name: "Reject", kind: "reject_once" },
      { optionId: "yes", name: "Approve", kind: "allow_once" },
    ];
    expect(permissionResponseFrame(9, options)).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
    const allowed = permissionResponseFrame(9, options, true) as { result: { outcome: { optionId: string } } };
    // Positional guessing would have taken the reject here.
    expect(allowed.result.outcome.optionId).toBe("yes");
    expect(
      (permissionResponseFrame(9, [{ optionId: "accept-all", name: "Accept" }], true) as { result: { outcome: { optionId: string } } })
        .result.outcome.optionId,
    ).toBe("accept-all");
    // Nothing on offer says allow, so approving would mean selecting a
    // rejection and calling it approval.
    expect(permissionResponseFrame(9, [{ optionId: "no", kind: "reject_once" }], true)).toMatchObject({
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(permissionResponseFrame(9, undefined, true)).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
  });
});

describe("acp prompt projection", () => {
  test("system, tool calls and tool results all survive the flattening", () => {
    const parsed = {
      modelId: "swe-2",
      stream: true,
      context: {
        systemPrompt: ["be brief"],
        messages: [
          { role: "user", content: "hi", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "text", text: "looking" },
              { type: "toolCall", id: "c1", name: "lookup", arguments: { q: "x" } },
            ],
            timestamp: 2,
          },
          { role: "toolResult", toolCallId: "c1", toolName: "lookup", content: "ok", isError: false, timestamp: 3 },
        ],
        tools: [],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    const prompt = buildAcpPrompt(parsed);
    expect(prompt).toContain("[System]\nbe brief");
    expect(prompt).toContain("[User]\nhi");
    // ACP takes one string, so a dropped tool loop would lose the thread.
    expect(prompt).toContain("[call lookup id=c1]");
    expect(prompt).toContain('{"q":"x"}');
    expect(prompt).toContain("[result id=c1]");
    expect(buildAcpPrompt({ ...parsed, context: { ...parsed.context, systemPrompt: [], messages: [] } })).toBe("(empty)");
  });
});

describe("acp update mapping", () => {
  test("message and thought chunks map to their own channels", () => {
    expect(acpUpdateToEvents({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } })).toEqual([
      { type: "text_delta", text: "a" },
    ]);
    expect(acpUpdateToEvents({ sessionUpdate: "agent_thought_chunk", content: "why" })).toEqual([
      { type: "thinking_delta", thinking: "why" },
    ]);
    expect(acpUpdateToEvents({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } })).toEqual([]);
  });

  test("the CLI's own tool calls become heartbeats, never Codex client tools", () => {
    // Devin executes these itself inside its session. Emitting tool_call_start
    // would either fail the turn, because the bridge rejects a tool Codex never
    // declared, or ask Codex to run something the agent already ran. Dropping
    // them outright is not right either: a long internal tool operation would
    // read as upstream silence and get the working turn stall-aborted.
    expect(acpUpdateToEvents({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read", rawInput: { path: "a" } })).toEqual([
      { type: "heartbeat" },
    ]);
    expect(acpUpdateToEvents({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" })).toEqual([
      { type: "heartbeat" },
    ]);
    expect(acpUpdateToEvents({ sessionUpdate: "plan", entries: [] })).toEqual([{ type: "heartbeat" }]);
    expect(acpUpdateToEvents({ sessionUpdate: "something_new" })).toEqual([]);
  });

});

describe("acp turn outcome", () => {
  test("a natural end carries no stopReason", () => {
    // The bridge reads any truthy stopReason as "this turn did not finish", so
    // reporting end_turn would cost every clean turn its final_answer phase.
    expect(mapAcpStopReason("end_turn")).toBeUndefined();
    expect(mapAcpStopReason(undefined)).toBeUndefined();
    expect(mapAcpStopReason("max_tokens")).toBe("max_tokens");
    expect(mapAcpStopReason("refusal")).toBe("refusal");
  });

  test("usage is reported only when the agent actually counted something", () => {
    expect(mapAcpUsage({ inputTokens: 10, outputTokens: 4 })).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    expect(mapAcpUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 9 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 9,
    });
    expect(mapAcpUsage({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
    expect(mapAcpUsage(undefined)).toBeUndefined();
  });
});

describe("devin cli discovery", () => {
  test("the environment override wins over every install path", () => {
    const previous = process.env[DEVIN_CLI_BIN_ENV];
    process.env[DEVIN_CLI_BIN_ENV] = "/custom/devin";
    try {
      expect(resolveDevinCliBinary({ exists: () => true, home: "/home/u", useCache: false })).toBe("/custom/devin");
    } finally {
      if (previous === undefined) delete process.env[DEVIN_CLI_BIN_ENV];
      else process.env[DEVIN_CLI_BIN_ENV] = previous;
    }
  });

  test("known install paths are preferred over a shadowed PATH entry, and absence is undefined", () => {
    const previous = process.env[DEVIN_CLI_BIN_ENV];
    const previousPath = process.env.PATH;
    delete process.env[DEVIN_CLI_BIN_ENV];
    process.env.PATH = join("/shadow", "bin");
    try {
      const expected = join("/home/u", ".local", "bin", "devin");
      const shadowed = join("/shadow", "bin", "devin");
      const exists = (p: string) => p === expected || p === shadowed;
      expect(resolveDevinCliBinary({ exists, home: "/home/u", useCache: false })).toBe(expected);
      expect(resolveDevinCliBinary({ exists: p => p === shadowed, home: "/home/u", useCache: false })).toBe(shadowed);
      expect(resolveDevinCliBinary({ exists: () => false, home: "/home/u", useCache: false })).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env[DEVIN_CLI_BIN_ENV] = previous;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

describe("devin-cli runTurn", () => {
  // A fake ACP child: stdin collects the frames the adapter sends, stdout is a
  // script the test pushes. This is the seam the coding-agent family uses, and
  // without it the abort, crash and post-terminal paths cannot fail CI.
  function fakeChild() {
    const stdinWrites: string[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & { exitCode: number | null; signalCode: string | null; killed: boolean };
    Object.assign(child, {
      stdout,
      stderr,
      stdin: Object.assign(new PassThrough(), {
        write: (chunk: string) => { stdinWrites.push(String(chunk)); return true; },
        destroyed: false,
      }),
      exitCode: null,
      signalCode: null,
      killed: false,
      // A real child emits close after being signalled; the adapter waits for
      // that rather than trusting `killed`, so the fake has to as well.
      kill: () => {
        (child as { killed: boolean }).killed = true;
        queueMicrotask(() => child.emit("close", null));
        return true;
      },
    });
    return { child, stdout, stdinWrites };
  }

  const parsed = {
    modelId: "swe-2",
    stream: true,
    context: { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] },
    options: {},
  } as unknown as OcxParsedRequest;

  async function run(script: (stdout: PassThrough, child: EventEmitter) => void) {
    const { child, stdout, stdinWrites } = fakeChild();
    const events: AdapterEvent[] = [];
    process.env[DEVIN_CLI_BIN_ENV] = "/fake/devin";
    const adapter = createDevinCliAdapter({ adapter: "devin-cli", baseUrl: "https://cli.devin.ai" }, {
      spawn: () => { queueMicrotask(() => script(stdout, child as unknown as EventEmitter)); return child; },
    });
    await adapter.runTurn!(parsed, {} as never, (e) => events.push(e));
    delete process.env[DEVIN_CLI_BIN_ENV];
    return { events, stdinWrites };
  }

  test("a complete handshake produces exactly one terminal event, carrying usage", async () => {
    const { events, stdinWrites } = await run((stdout) => {
      stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
      queueMicrotask(() => {
        stdout.write('{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}\n');
        queueMicrotask(() => {
          stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"PONG"}}}}\n');
          // The prompt reply arrives WITHOUT a trailing newline, and more
          // output follows it. Both used to break this adapter.
          stdout.write('{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":{"inputTokens":3,"outputTokens":1}}}');
          stdout.end();
        });
      });
    });
    const terminals = events.filter((e) => e.type === "done" || e.type === "error");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ type: "done", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
    // A natural end reports no stopReason.
    expect((terminals[0] as { stopReason?: string }).stopReason).toBeUndefined();
    expect(events.filter((e) => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "PONG" }]);
    expect(stdinWrites.join("")).toContain('"method":"session/prompt"');
  });

  test("a crash before the prompt reply is an error, not an empty success", async () => {
    const { events } = await run((stdout, child) => {
      stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
      queueMicrotask(() => {
        child.emit("close", 1);
      });
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect((events[0] as { message: string }).message).toMatch(/exited \(code 1\) before answering/);
  });

  test("a session/new failure reports the CLI's reason", async () => {
    const { events } = await run((stdout) => {
      stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
      queueMicrotask(() => {
        stdout.write('{"jsonrpc":"2.0","id":2,"error":{"message":"not authenticated"}}\n');
      });
    });
    expect(events).toHaveLength(1);
    expect((events[0] as { message: string }).message).toMatch(/session\/new failed: not authenticated/);
  });

  test("a malformed frame after the protocol starts fails the turn instead of vanishing", async () => {
    // A banner line before the first frame is expected noise. A broken frame
    // afterwards is corruption: swallowing it loses output, or waits out the
    // ten-minute timeout for a reply that already arrived damaged.
    const { events } = await run((stdout) => {
      stdout.write("Devin CLI v3000.10.21\n");
      stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
      queueMicrotask(() => stdout.write('{"jsonrpc":"2.0","id":2,"result":{"sessionId"\n'));
    });
    expect(events).toHaveLength(1);
    expect((events[0] as { message: string }).message).toMatch(/malformed ACP frame/);
  });
});
