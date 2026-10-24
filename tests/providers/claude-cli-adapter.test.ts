import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  buildArgs,
  buildChildEnv,
  CLAUDE_CLI_QUIET_ENV,
  createClaudeCliAdapter,
  withClaudeLoginHint,
  type SpawnFn,
} from "../../src/adapters/claude-cli/adapter";
import { CLAUDE_REPLAY_SYSTEM_PROMPT } from "../../src/adapters/claude-cli/stable-replay";
import { baseScopedEnv } from "../../src/adapters/coding-agent/turn";
import { CLAUDE_CLI_PROFILE, clearClaudeCliBinaryCache } from "../../src/adapters/claude-cli/profiles";
import { effectiveAdapterContract, getAdapterDefinition } from "../../src/adapters/registry";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { createRequestExecutionBudget, CODEX_TEXT_GUARDED_BUDGET_POLICY } from "../../src/lib/request-execution-budget";
import { createSpendReservationLedger } from "../../src/lib/spend-reservation-ledger";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { createShippedSpendLedger, spendTestJournal, spendTestPolicy, testSpendSalt } from "../helpers/shipped-spend-ledger";

const enc = new TextEncoder();

// The binary-discovery cache is module-level (a production perf seam); reset it so a test that
// reports a missing CLI cannot mask a later test's injected binary.
beforeEach(() => clearClaudeCliBinaryCache());

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
  written: string[];
}

function fakeChild(stdout: Uint8Array[], opts: { stderr?: string; exitCode?: number; emitClose?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Readable.from(stdout);
  child.stderr = Readable.from(opts.stderr ? [enc.encode(opts.stderr)] : []);
  child.written = [];
  child.stdin = new Writable({ write(chunk, _enc, cb) { child.written.push(String(chunk)); cb(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; return true; };
  if (opts.emitClose !== false) setTimeout(() => { child.exitCode = opts.exitCode ?? 0; child.emit("close", opts.exitCode ?? 0); }, 3);
  return child;
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "claude-cli",
    baseUrl: CLAUDE_CLI_PROFILE.canonicalBaseUrl,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    ...overrides,
  } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "claude-sonnet-5",
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    ...overrides,
  } as OcxParsedRequest;
}

function incoming(abortSignal?: AbortSignal) {
  return { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), ...(abortSignal ? { abortSignal } : {}) };
}

async function run(adapter: ReturnType<typeof createClaudeCliAdapter>, p: OcxParsedRequest): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(p, incoming(), e => events.push(e));
  return events;
}

// The CLI-emitted name of the one caller-owned tool the capture-only bridge advertises.
const CLAUDE_CLI_MCP_TOOL = "mcp__opencodex__read_file";

/** A request that advertises one caller-owned tool, so the turn arms the capture-only bridge. */
function claudeCliToolRequest(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return parsed({
    context: {
      messages: [{ role: "user", content: "Read the fixture", timestamp: 0 }],
      tools: [{
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }],
    },
    ...overrides,
  });
}

/** One tool_use block: start, the argument delta, and the matching stop. */
function claudeCliToolFrame(index: number, id: string | undefined, name: string, args: string): string {
  return JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", ...(id === undefined ? {} : { id }), name },
    },
  }) + "\n"
    + JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args } },
    }) + "\n"
    + JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index } }) + "\n";
}

describe("claude-cli is an official-harness provider, not a Messages relay", () => {
  test("the registry row and the adapter agree on the one canonical destination", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "claude-cli");
    expect(entry).toBeDefined();
    expect(entry!.adapter).toBe("claude-cli");
    expect(entry!.baseUrl).toBe(CLAUDE_CLI_PROFILE.canonicalBaseUrl);
    expect(entry!.defaultModel).toBe("claude-sonnet-5");
    expect(entry!.models).toContain(entry!.defaultModel!);
    expect(entry!.modelContextWindows?.[entry!.defaultModel!]).toBeGreaterThan(0);
    // Static roster: a live discovery request against this route answers 404 and is pure noise.
    expect(entry!.liveModels).toBe(false);
    // The CLI parses an image frame, but no headless turn was shown to hand those bytes to the
    // model, so the row publishes text-only models instead of the Messages API rows' image
    // modality: an advertised input the route cannot honour is how a picture gets answered blind.
    expect(entry!.noVisionModels).toEqual(entry!.models ?? []);
    expect(entry!.modelInputModalities).toBeUndefined();
  });

  test("the row is a keyless key provider, not a local runtime, and needs no dashboardPreset flag", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "claude-cli")!;
    // "local" is the Ollama / vLLM / LM Studio classification: the traffic never leaves the machine
    // and there is no credential to classify. This row's turn leaves for api.anthropic.com, and the
    // account surface answers from `authKind` (`classifyAccount` in src/cli/account-api.ts), where
    // "local" claimed there were no credentials at all — for a provider whose whole point is a
    // credential the CLI owns.
    expect(entry.authKind).toBe("key");
    // Keyless is expressed by `keyOptional`, the flag key enforcement already honors
    // (src/server/auth-cors.ts, src/providers/api-key-selection.ts) without pretending a key exists.
    expect(entry.keyOptional).toBe(true);
    // A key row must name where its credential comes from; deriveKeyLoginMap throws without this.
    expect(entry.dashboardUrl).toBeTruthy();
    // They keyed a keyless row into the picker by hand. That is what the flag was for, and key rows
    // are listed already, so it is gone rather than duplicated.
    expect(entry.dashboardPreset).toBeUndefined();
    expect(providerConfigSeed(entry)).toMatchObject({ authMode: "key", keyOptional: true });
    expect(deriveProviderPresets().find(candidate => candidate.id === "claude-cli"))
      .toMatchObject({ auth: "key", keyOptional: true });
  });

  test("the adapter inherits the shared coding-agent contract instead of a second wire", () => {
    expect(getAdapterDefinition("claude-cli")?.contractParent).toBe("codebuddy");
    expect(effectiveAdapterContract("claude-cli").wire).toBe("codebuddy");
  });
});

describe("CLI invocation spend admission", () => {
  function accounting(maxTrackedSends = 10) {
    const journal = spendTestJournal();
    const ledger = createSpendReservationLedger({ journal, salt: testSpendSalt, now: () => 2,
      policy: spendTestPolicy({ pool: { maxTokens: 50 }, maxTrackedSends }) });
    const tracker = createRequestSpendTracker({ provider: "claude-cli", spendInputEstimateTokens: 1 }, undefined, ledger);
    const policy = { ...CODEX_TEXT_GUARDED_BUDGET_POLICY };
    const budget = createRequestExecutionBudget(policy, undefined, tracker);
    return { journal, ledger, tracker, policy, budget };
  }
  const terminal = enc.encode(JSON.stringify({ type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 70, output_tokens: 0 } }) + "\n");

  test("full NORMAL seed capacity refuses before spawning the CLI", async () => {
    const f = accounting(1);
    f.ledger.reserve({ sendId: "busy", scopes: { poolId: "claude-cli" }, inputTokens: 1, outputCeilingTokens: 0 });
    let spawns = 0;
    const adapter = createClaudeCliAdapter(provider(), { which: () => "/test/claude",
      spawn: () => { spawns++; return fakeChild([terminal]) as unknown as ChildProcess; } });
    await expect(adapter.runTurn!(parsed(), { ...incoming(), sendBudget: f.budget }, () => {}))
      .rejects.toMatchObject({ code: "request_send_budget_exhausted" });
    expect(spawns).toBe(0);
    expect(f.budget.physicalStarted).toBe(0);
  });

  test("a frozen invocation limit refuses the next CLI spawn after policy expansion", async () => {
    const f = accounting();
    Object.assign(f.policy, { maxTotalModelSends: 1, baseSendAllowance: 1 });
    let spawns = 0;
    const adapter = createClaudeCliAdapter(provider(), { which: () => "/test/claude",
      spawn: () => { spawns++; return fakeChild([terminal]) as unknown as ChildProcess; } });
    await adapter.runTurn!(parsed(), { ...incoming(), sendBudget: f.budget }, () => {});
    Object.assign(f.policy, { maxTotalModelSends: 100, baseSendAllowance: 100 });
    await expect(adapter.runTurn!(parsed(), { ...incoming(), sendBudget: f.budget }, () => {}))
      .rejects.toMatchObject({ code: "request_send_budget_exhausted" });
    expect(spawns).toBe(1);
    expect(f.budget.physicalStarted).toBe(1);
    expect(f.budget.physicalLimit).toBe(1);
    f.tracker.settle({ inputTokens: 70 });
  });

  test("CLI terminal usage above its estimate settles only after the child is reaped", async () => {
    const f = accounting();
    const child = fakeChild([terminal], { emitClose: false });
    const adapter = createClaudeCliAdapter(provider(), { which: () => "/test/claude",
      spawn: () => child as unknown as ChildProcess });
    let observedTerminal!: () => void;
    const terminalSeen = new Promise<void>(resolve => { observedTerminal = resolve; });
    const turn = adapter.runTurn!(parsed(), { ...incoming(), sendBudget: f.budget }, event => {
      if (event.type !== "done") return;
      f.tracker.settle(event.usage);
      observedTerminal();
    });
    await terminalSeen;
    let drained = false;
    const drain = f.ledger.waitForReporterDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(f.journal.lines.some(line => JSON.parse(line).kind === "forget")).toBe(false);
    child.exitCode = 0;
    child.emit("close", 0);
    await turn;
    await drain;
    expect(f.budget.physicalStarted).toBe(1);
    expect(f.ledger.snapshot("pool", "claude-cli")).toMatchObject({ settled: 70, reserved: 0 });
    expect(createShippedSpendLedger({ journal: f.journal, salt: testSpendSalt, now: () => 2 })
      .snapshot("pool", "claude-cli")?.settled).toBe(70);
  });
});

describe("claude-cli headless arguments keep tool ownership with the client", () => {
  test("disables built-in tools and every MCP source, and never requests a bypass", () => {
    const args = buildArgs(CLAUDE_CLI_PROFILE, parsed(), provider());
    expect(args[0]).toBe("-p");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--tools") + 1]).toBe(""); // "" = every built-in tool off
    expect(args).toContain("--strict-mcp-config"); // and no MCP server from settings or plugins
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allow-dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
  });

  test("loads no user, project or local settings into a proxied turn", () => {
    const args = buildArgs(CLAUDE_CLI_PROFILE, parsed(), provider());
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).not.toContain("--append-system-prompt");
  });

  test("the caller's system prompt REPLACES the harness preset", () => {
    const args = buildArgs(CLAUDE_CLI_PROFILE, parsed({
      context: { systemPrompt: ["Be terse."], messages: [] },
    }), provider(), "/private/system-prompt.txt");
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe("/private/system-prompt.txt");
    // argv is world-readable through process listing, so the folded prompt is a path, not an argument.
    expect(args).not.toContain("Be terse.");
    expect(args).not.toContain("--system-prompt");
  });

  test("no staged prompt means no flag at all, so runTurn always stages one", () => {
    expect(buildArgs(CLAUDE_CLI_PROFILE, parsed(), provider())).not.toContain("--system-prompt-file");
  });

  test("maps the caller's reasoning effort onto the CLI's --effort", () => {
    const args = buildArgs(CLAUDE_CLI_PROFILE, parsed({ options: { reasoning: "high" } }), provider());
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  test("passes no --max-turns: the Claude Code CLI has no such flag", () => {
    // CodeBuddy's CLI accepts --max-turns and this family shares its parser; the flag must not be
    // copied across, or every turn dies on an unknown option.
    expect(buildArgs(CLAUDE_CLI_PROFILE, parsed(), provider())).not.toContain("--max-turns");
  });
});

describe("claude-cli child environment carries no credential and no proxy destination", () => {
  test("an inherited ANTHROPIC_* variable cannot point the harness back at this proxy", () => {
    const previous = { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:10100";
    process.env.ANTHROPIC_API_KEY = "inherited-key";
    try {
      const env = buildChildEnv(CLAUDE_CLI_PROFILE, "");
      expect(Object.keys(env).filter(name => name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_OAUTH"))).toEqual([]);
      expect(JSON.stringify(env)).not.toContain("inherited-key");
      expect(JSON.stringify(env)).not.toContain("127.0.0.1:10100");
    } finally {
      if (previous.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previous.base;
      if (previous.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous.key;
    }
  });

  test("keeps the home directory the CLI signs in from, and quiets its own telemetry", () => {
    const env = buildChildEnv(CLAUDE_CLI_PROFILE, "");
    // The inherited HOME is the property the provider exists for and the one an operator must know
    // about: the sign-in belongs to the user this proxy runs as, so every request served through
    // this row — by any client of the proxy — spends that same Claude account.
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  test("a key configured on the row is never handed to the harness", () => {
    // `keyOptional` makes the row keyless without making it key-*blind*: an operator who saved an
    // API key in the dashboard or with `ocx provider add --api-key` must not silently believe it
    // bills the turn. Nothing layers a credential onto the child environment.
    const env = buildChildEnv(CLAUDE_CLI_PROFILE, "sk-ant-row-key");
    expect(JSON.stringify(env)).not.toContain("sk-ant-row-key");
    expect(Object.keys(env).filter(name => name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_OAUTH"))).toEqual([]);
  });

  test("carries the account name the CLI resolves its keychain sign-in by, and nothing else new", () => {
    // Without USER the CLI reports "not logged in" on a signed-in machine: it looks its own keychain
    // entry up by account name. The value is a name, not a credential — no token is added here.
    const previous = process.env.USER;
    // The test preload sandboxes CLAUDE_CONFIG_DIR, which the child env forwards by design
    // (covered in claude-cli-usage-admission.test.ts); clear it so this set stays exact.
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.USER = "ocx-probe-user";
    try {
      const env = buildChildEnv(CLAUDE_CLI_PROFILE, "");
      expect(env.USER).toBe("ocx-probe-user");
      // Derived from the two owners rather than restated, so a new quiet flag cannot silently
      // become the third thing this environment carries.
      expect(Object.keys(env).sort()).toEqual(
        [...new Set([...Object.keys(baseScopedEnv()), ...Object.keys(CLAUDE_CLI_QUIET_ENV), "USER"])].sort(),
      );
    } finally {
      if (previous === undefined) delete process.env.USER;
      else process.env.USER = previous;
      if (previousConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
  });

  test("adds no USER key when the parent has none", () => {
    const previous = process.env.USER;
    delete process.env.USER;
    try {
      expect("USER" in buildChildEnv(CLAUDE_CLI_PROFILE, "")).toBe(false);
    } finally {
      if (previous !== undefined) process.env.USER = previous;
    }
  });
});

describe("claude-cli runTurn fails closed before any spawn", () => {
  test("a non-canonical base URL is refused", async () => {
    let spawned = 0;
    const spawn: SpawnFn = () => { spawned++; return fakeChild([]) as unknown as ChildProcess; };
    const adapter = createClaudeCliAdapter(provider({ baseUrl: "https://evil.example.test" }), { spawn, which: () => "/usr/bin/claude" });
    const events = await run(adapter, parsed());
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "non_canonical_destination", retryable: false });
  });

  test("a missing CLI is a clear pre-flight error naming the install command", async () => {
    let spawned = 0;
    const adapter = createClaudeCliAdapter(provider(), { spawn: () => { spawned++; return fakeChild([]) as unknown as ChildProcess; }, which: () => undefined });
    const events = await run(adapter, parsed());
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "cli_not_found", retryable: false });
    expect(String((events[0] as { message: string }).message)).toContain("npm install -g @anthropic-ai/claude-code");
  });

  test("an image is refused rather than handed to a harness that was never shown to carry it", async () => {
    let spawned = 0;
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => { spawned++; return fakeChild([]) as unknown as ChildProcess; },
      which: () => "/opt/homebrew/bin/claude",
    });
    const events = await run(adapter, parsed({
      context: { messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgo=" }], timestamp: 0 }] },
    }));
    // Same refusal the Qoder presets make: a dropped image answers the wrong question confidently,
    // and no headless Claude Code turn was shown to deliver image bytes to the model.
    expect(spawned).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 400, code: "unsupported_input_modality", retryable: false });
  });
});

describe("claude-cli stages the folded prompt out of argv", () => {
  test("keeps caller instructions out of argv and removes the private prompt file", async () => {
    const secret = "private-system-instruction";
    let promptFile = "";
    let promptText = "";
    let capturedArgs: string[] = [];
    let promptMode = 0;
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/opt/homebrew/bin/claude",
      spawn: (_command, args) => {
        capturedArgs = [...args];
        promptFile = args[args.indexOf("--system-prompt-file") + 1] ?? "";
        promptText = readFileSync(promptFile, "utf8");
        promptMode = statSync(promptFile).mode & 0o777;
        return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
      },
      killGraceMs: 20,
    });
    const events = await run(adapter, parsed({ context: { systemPrompt: [secret], messages: [] } }));
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(capturedArgs).not.toContain(secret);
    expect(capturedArgs).toContain("--system-prompt-file");
    expect(promptText).toBe(secret + "\n\n" + CLAUDE_REPLAY_SYSTEM_PROMPT);
    if (process.platform !== "win32") expect(promptMode).toBe(0o600);
    expect(promptFile).not.toBe("");
    expect(existsSync(promptFile)).toBe(false);
  });

  test("no caller prompt leaves only fixed replay instructions, replacing the harness preset", async () => {
    let promptFile = "";
    let promptText = "";
    let capturedArgs: string[] = [];
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/opt/homebrew/bin/claude",
      spawn: (_command, args) => {
        capturedArgs = [...args];
        promptFile = args[args.indexOf("--system-prompt-file") + 1] ?? "";
        promptText = readFileSync(promptFile, "utf8");
        return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
      },
      killGraceMs: 20,
    });
    const events = await run(adapter, parsed());
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(capturedArgs).toContain("--system-prompt-file");
    expect(promptText).toBe(CLAUDE_REPLAY_SYSTEM_PROMPT);
    expect(promptFile).not.toBe("");
    expect(existsSync(promptFile)).toBe(false);
  });
});

describe("claude-cli runTurn streams a subscription turn", () => {
  test("runs without any stored API key, because the CLI owns the account", async () => {
    let spawned = 0;
    const stdout = [
      enc.encode('{"type":"system","subtype":"init"}\n'),
      enc.encode('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}\n'),
      enc.encode('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}\n'),
      enc.encode('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"think"}}}\n'),
      enc.encode('{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":7,"output_tokens":2}}\n'),
    ];
    const child = fakeChild(stdout);
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => { spawned++; return child as unknown as ChildProcess; },
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });

    const events = await run(adapter, parsed());
    expect(spawned).toBe(1);
    expect(events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("")).toBe("Hello");
    expect(events.some(e => e.type === "thinking_delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } });
    expect(child.written.join("")).toContain('"text":"USER:\\nhello"');
  });

  test("an unauthenticated CLI becomes an actionable sign-in error", async () => {
    // Verbatim shape of a real 2.1.270 turn: exit code 1, `is_error` result, no HTTP status.
    const stdout = [enc.encode(`${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
    })}\n`)];
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => fakeChild(stdout, { exitCode: 1 }) as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });

    const events = await run(adapter, parsed());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 401, code: "claude_cli_not_logged_in", retryable: false });
    expect(String((events[0] as { message: string }).message)).toContain("claude");
  });

  test("the sign-in hint leaves every other error untouched", () => {
    const events: AdapterEvent[] = [];
    const hinted = withClaudeLoginHint(event => events.push(event));
    hinted({ type: "error", message: "upstream exploded", status: 502, code: "upstream_error" });
    hinted({ type: "error", message: "rate limited", status: 429, code: "rate_limit_exceeded" });
    hinted({ type: "text_delta", text: "hi" });
    expect(events).toEqual([
      { type: "error", message: "upstream exploded", status: 502, code: "upstream_error" },
      { type: "error", message: "rate limited", status: 429, code: "rate_limit_exceeded" },
      { type: "text_delta", text: "hi" },
    ]);
  });
});

describe("claude-cli malformed/truncated protocol output (offline)", () => {
  test("a malformed JSON line surfaces a protocol error", async () => {
    const stdout = [enc.encode("not-json\n")];
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => fakeChild(stdout, { exitCode: 0 }) as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });
    const events = await run(adapter, parsed());
    const err = events.find(e => e.type === "error") as { code?: string; message: string };
    expect(err).toBeDefined();
    expect(err.code).toBe("protocol_error");
    expect(err.message).toContain("Malformed stream-json frame received from coding-agent CLI");
  });

  test("an incomplete final JSON line without a newline reports a protocol error", async () => {
    const stdout = [enc.encode('{"type":"result","subtype":"success"')]; // incomplete, no newline
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => fakeChild(stdout, { exitCode: 0 }) as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });
    const events = await run(adapter, parsed());
    const err = events.find(e => e.type === "error") as { code?: string; message: string };
    expect(err).toBeDefined();
    expect(err.code).toBe("protocol_error");
    expect(err.message).toContain("Malformed stream-json frame received from coding-agent CLI");
  });

  test("a final JSON line without trailing newline is still parsed", async () => {
    const frame = JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
    const stdout = [enc.encode(frame)];
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => fakeChild(stdout, { exitCode: 0 }) as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });
    const events = await run(adapter, parsed());
    const done = events.find(e => e.type === "done") as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };
    expect(done).toBeDefined();
    expect(done.usage).toMatchObject({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  });

  test("empty output reports no terminal result frame", async () => {
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => fakeChild([], { exitCode: 0 }) as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });
    const events = await run(adapter, parsed());
    const err = events.find(e => e.type === "error") as { code?: string; message: string };
    expect(err).toBeDefined();
    expect(err.code).toBe("protocol_error");
    expect(err.message).toContain("without a terminal result frame");
  });
});

describe("claude-cli cancellation (offline)", () => {
  test("an already-aborted signal fails before spawning the CLI", async () => {
    let spawned = 0;
    const controller = new AbortController();
    controller.abort();
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => { spawned++; return fakeChild([]) as unknown as ChildProcess; },
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });
    const evs: any[] = [];
    await adapter.runTurn!(parsed(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), abortSignal: controller.signal }, e => evs.push(e));
    expect(spawned).toBe(0);
    expect(evs[0]).toMatchObject({ type: "error", message: "Coding-agent turn was aborted before start." });
  });
});

describe("claude-cli buffered completion (offline)", () => {
  test("surfaces a complete assistant text message in one frame", async () => {
    const stdout = [
      enc.encode('{"type":"system","subtype":"init"}\n'),
      enc.encode(JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
          stop_reason: "stop",
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      }) + "\n"),
      enc.encode('{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":5,"output_tokens":2}}\n'),
    ];
    const child = fakeChild(stdout);
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => child as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });
    const events = await run(adapter, parsed());
    expect(events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("")).toBe("Hello world");
    // The buffered path is the fallback: one complete assistant frame yields exactly one
    // text_delta, not a second copy of text the client already saw.
    expect(events.filter(e => e.type === "text_delta")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
  });
});

describe("claude-cli captured tool-call events preserved after protocol error (offline)", () => {
  test("tool-call events emitted before a malformed final line remain intact", async () => {
    const stdout = [
      enc.encode('{"type":"system","subtype":"init","mcp_servers":[{"name":"opencodex","status":"connected"}]}\n'),
      enc.encode(claudeCliToolFrame(0, "tu_1", CLAUDE_CLI_MCP_TOOL, '{"path":"fixture.txt"}')),
      enc.encode("not-json\n"), // malformed line after valid tool calls
    ];
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => fakeChild(stdout, { exitCode: 0 }) as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });
    const events = await run(adapter, claudeCliToolRequest());
    // The call captured before the malformed line stays complete: the client still learns which
    // tool was asked for and with which arguments, so it can execute it and return a result.
    const starts = events.filter(e => e.type === "tool_call_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ type: "tool_call_start", id: "tu_1", name: "read_file" });
    expect(events.filter(e => e.type === "tool_call_delta").map(e => (e as { arguments: string }).arguments))
      .toEqual(['{"path":"fixture.txt"}']);
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(1);
    // The malformed line still surfaces a protocol error
    const err = events.find(e => e.type === "error") as { code?: string; message: string };
    expect(err).toBeDefined();
    expect(err.code).toBe("protocol_error");
  });
});

describe("claude-cli stream-JSON chunk boundaries (offline)", () => {
  test("a valid JSON frame split across multiple chunks is still parsed", async () => {
    const frame = JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 3, output_tokens: 1 } });
    // Split the frame across chunks at arbitrary byte boundaries
    const bytes = enc.encode(frame + "\n");
    const stdout = [bytes.slice(0, 5), bytes.slice(5)];
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => fakeChild(stdout, { exitCode: 0 }) as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });
    const events = await run(adapter, parsed());
    const done = events.find(e => e.type === "done") as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };
    expect(done).toBeDefined();
    expect(done.usage).toMatchObject({ inputTokens: 3, outputTokens: 1, totalTokens: 4 });
  });
});

describe("claude-cli cancellation during running turn (offline)", () => {
  test("abort signal during streaming kills the child process", async () => {
    let spawned = 0;
    let killed = false;
    const controller = new AbortController();
    const stdout = [
      enc.encode('{"type":"system","subtype":"init"}\n'),
      enc.encode('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}\n'),
    ];
    const child = fakeChild(stdout, { emitClose: false });
    child.kill = () => { killed = true; return true; };
    let promptFile = "";
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: (_command, args) => {
        spawned++;
        promptFile = args[args.indexOf("--system-prompt-file") + 1] ?? "";
        return child as unknown as ChildProcess;
      },
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 50,
    });
    // Abort on the FIRST client-visible event. That is the only deterministic point that is
    // both after the spawn and inside the turn: a timer would race the spawn (the turn stages
    // a prompt file first) and could land before the CLI was ever launched.
    const evs: any[] = [];
    let aborted = false;
    await adapter.runTurn!(
      parsed(),
      { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), abortSignal: controller.signal },
      (event: AdapterEvent) => {
        evs.push(event);
        if (!aborted) {
          aborted = true;
          controller.abort();
        }
      },
    );
    expect(spawned).toBe(1);
    expect(aborted).toBe(true);
    expect(killed).toBe(true);
    const err = evs.find(e => e.type === "error");
    expect(err).toBeDefined();
    expect(err.message).toContain("aborted");
    // Cleanup is part of the abort contract, not a side effect of the happy path: the private
    // staged prompt file is removed even when the turn died mid-stream (adapter.ts finally block).
    expect(promptFile).not.toBe("");
    expect(existsSync(promptFile)).toBe(false);
  });
});

describe("claude-cli JSON Schema + caller-owned tools coexistence (offline)", () => {
  test("textFormat.json_object is not forwarded as any CLI schema flag", () => {
    // The json_schema half of this claim is covered by the propagation trace further down;
    // this one covers the second textFormat type, which no other test exercises.
    const args = buildArgs(CLAUDE_CLI_PROFILE, parsed({
      options: {
        textFormat: { type: "json_object" },
      },
    }), provider());
    expect(args).not.toContain("--json-schema");
    expect(args).not.toContain("--output-schema");
    expect(args).not.toContain("--schema");
  });
});

describe("claude-cli missing/duplicate/unknown result IDs in tool calls (offline)", () => {
  const init = enc.encode('{"type":"system","subtype":"init","mcp_servers":[{"name":"opencodex","status":"connected"}]}\n');

  test("a repeated tool call ID is surfaced once per block and is never rejected", async () => {
    // The upstream guard for a conflicting reuse (protocol.ts `isEmittedToolCallRepeat`, and
    // the `previous.name !== name` branch at protocol.ts:597) reads `state.emittedToolCalls`.
    // That snapshot is filled in exactly two places — protocol.ts:352 and protocol.ts:511 —
    // both inside `if (state.completeAssistantToolUse)`, which only Qoder sets
    // (src/adapters/qoder/adapter.ts:196). The claude-cli adapter
    // (src/adapters/claude-cli/adapter.ts:241-254) never arms it, so the snapshot stays empty
    // for the whole turn and the conflicting-reuse branch is unreachable here.
    //
    // Consequence, recorded as observed behavior and NOT as an endorsement: a repeated ID is
    // neither deduplicated nor rejected, whether the repeat carries the same arguments or
    // different ones. The client sees two calls under one ID and has to resolve them itself.
    for (const secondArgs of ['{"path":"a"}', '{"path":"b"}']) {
      const stdout = [
        init,
        enc.encode(claudeCliToolFrame(0, "dup_id", CLAUDE_CLI_MCP_TOOL, '{"path":"a"}')),
        enc.encode(claudeCliToolFrame(1, "dup_id", CLAUDE_CLI_MCP_TOOL, secondArgs)),
        enc.encode('{"type":"stream_event","event":{"type":"message_stop"}}\n'),
      ];
      const adapter = createClaudeCliAdapter(provider(), {
        spawn: () => fakeChild(stdout, { exitCode: 0 }) as unknown as ChildProcess,
        which: () => "/opt/homebrew/bin/claude",
        killGraceMs: 20,
      });
      const events = await run(adapter, claudeCliToolRequest());
      const starts = events.filter(e => e.type === "tool_call_start");
      expect(starts).toHaveLength(2);
      expect(starts.map(e => (e as { id: string }).id)).toEqual(["dup_id", "dup_id"]);
      expect(events.filter(e => e.type === "tool_call_delta").map(e => (e as { arguments: string }).arguments))
        .toEqual(['{"path":"a"}', secondArgs]);
      // The guard's own error is never raised, and the turn is served successfully.
      expect(events.some(e => e.type === "error")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use" });
    }
  });

  test("a tool_result whose call id matches no prior tool call is replayed to the CLI unvalidated", async () => {
    // The other half of the ID contract: a RESULT id the client sends back. Nothing on this
    // route matches it against the calls of the turn: `formatMessageForHistory`
    // (src/adapters/coding-agent/protocol.ts:758-763) interpolates `toolCallId` into
    // `TOOL RESULT (call_id: ...)` and stops there — no lookup, no rejection, no orphan
    // conversion, unlike the anthropic adapter's `orphanToolResultText`
    // (src/adapters/anthropic.ts:718). The unmatched result reaches the model as a labelled
    // block. Recorded as observed behavior, NOT as an endorsement.
    const request = parsed({
      context: {
        messages: [
          { role: "user", content: "Read the fixture", timestamp: 0 },
          { role: "assistant", content: [{ type: "toolCall", id: "call_known", name: "read_file", arguments: { path: "fixture.txt" } }], timestamp: 1 },
          { role: "toolResult", toolCallId: "call_unknown", toolName: "read_file", content: "result of a call that never happened", isError: false, timestamp: 2 },
          { role: "toolResult", toolCallId: "call_known", toolName: "a_different_tool", content: "result whose tool name does not match the call", isError: false, timestamp: 3 },
        ],
        tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
      },
    });
    const child = fakeChild([
      enc.encode('{"type":"system","subtype":"init","mcp_servers":[{"name":"opencodex","status":"connected"}]}\n'),
      enc.encode('{"type":"result","subtype":"success"}\n'),
    ]);
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/opt/homebrew/bin/claude",
      spawn: () => child as unknown as ChildProcess,
      killGraceMs: 20,
    });
    const events = await run(adapter, request);
    const written = child.written.join("");
    // The unmatched id is passed through verbatim, next to the call that DOES match.
    expect(written).toContain("TOOL RESULT (call_id: call_unknown)");
    expect(written).toContain("[Tool call: mcp__opencodex__read_file (call_id: call_known)");
    // Both result bodies reach the CLI, so the model sees the content and not only the labels.
    expect(written).toContain("result of a call that never happened");
    expect(written).toContain("result whose tool name does not match the call");
    // A result whose tool NAME disagrees with the call it claims is not rejected either, and
    // the name is not even rendered: the replay carries the id and the content, nothing else.
    expect(written).toContain("TOOL RESULT (call_id: call_known)");
    expect(written).not.toContain("a_different_tool");
    // And the turn is served: an unmatched result id does not fail the request.
    expect(events.some(e => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("a tool_use block without an id never becomes a tool call", async () => {
    const stdout = [init, enc.encode(claudeCliToolFrame(0, undefined, CLAUDE_CLI_MCP_TOOL, '{"path":"a"}'))];
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => fakeChild(stdout, { exitCode: 0 }) as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });
    const events = await run(adapter, claudeCliToolRequest());
    // A tool_use without an id opens no block: protocol.ts:591 reads the id with
    // `asString(block?.id) ?? ""` and the whole block body is behind `if (id)`. The argument
    // delta that follows therefore has no open block to attribute to, and the strict capture
    // path (armed because this turn has a tool bridge) fails the turn at protocol.ts:570
    // instead of dropping the arguments silently and reporting a successful tool turn.
    const err = events.find(e => e.type === "error");
    expect(err).toBeDefined();
    expect(err).toMatchObject({ code: "protocol_error", status: 502 });
    expect(String((err as { message: string }).message)).toContain("cannot be attributed to an open tool block");
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
  });
});

/**
 * The observed offline contract for this route, as established by the source and by the tests
 * below.
 *
 * SUPPORTED:
 *   - a request is served by a headless `claude -p` turn with built-in tools disabled and
 *     user/project/plugin MCP servers excluded (--tools "", --strict-mcp-config,
 *     --setting-sources "") — asserted by the existing argument tests in this file;
 *   - a declared tool catalog reaches the CLI as the isolated capture-only MCP catalog
 *     (--allowedTools + --mcp-config) and its call intent is returned to the client —
 *     asserted by tests/providers/claude-cli-tool-capture.test.ts;
 *   - the completion is represented as text deltas plus a terminal done, and usage comes from
 *     the result frame;
 *   - invalid or truncated final JSON is reported as protocol_error without discarding the tool
 *     calls captured before it.
 *
 * UNSUPPORTED: the requested output schema has no consumer on this route. options.textFormat is
 * parsed off the Responses API request and consumed by the anthropic, google, openai-chat,
 * ollama-native and cursor adapters; the claude-cli adapter reads neither it nor any schema
 * flag, so a json_schema or json_object request is served as an ordinary text turn with the
 * schema silently not applied.
 *
 * NOT ESTABLISHED, and deliberately left open: whether the Claude Code CLI itself accepts any
 * structured-output flag at the version this proxy drives. Nothing in this repository records
 * such a flag, and no live CLI was exercised to find one, so this suite makes no claim either
 * way. The transport/dependency decision stays with @lidge-jun.
 */
describe("claude-cli schema propagation and completion contract (offline)", () => {
  // A distinctive marker so a leaked schema would be visible in argv, in the staged prompt
  // file, and in the replayed stdin frame alike.
  const SCHEMA = {
    type: "object" as const,
    properties: { ocx_schema_probe_marker: { type: "string" } },
    required: ["ocx_schema_probe_marker"],
  };
  const schemaRequest = (overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest => parsed({
    options: { textFormat: { type: "json_schema", name: "probe", schema: SCHEMA } },
    ...overrides,
  });
  const textDelta = (text: string): string => JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  }) + "\n";

  test("the requested schema reaches neither the argument builder nor the staged input", async () => {
    // Source trace: `buildArgs` (src/adapters/claude-cli/adapter.ts) reads parsed.modelId and
    // parsed.options.reasoning. options.textFormat has no consumer on this route, so the
    // schema is dropped before argv is built — argv is byte-identical with and without it.
    const plain = buildArgs(CLAUDE_CLI_PROFILE, parsed(), provider());
    const withSchema = buildArgs(CLAUDE_CLI_PROFILE, schemaRequest(), provider());
    expect(withSchema).toEqual(plain);
    expect(withSchema).not.toContain("--json-schema");
    expect(withSchema).not.toContain("--output-schema");
    expect(withSchema).not.toContain("--schema");
    expect(JSON.stringify(withSchema)).not.toContain("ocx_schema_probe_marker");

    // The other two inputs this route builds are the staged system-prompt file and the
    // replayed stream-json stdin frame. The schema reaches neither of them either.
    let promptText = "";
    const child = fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]);
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/opt/homebrew/bin/claude",
      spawn: (_command, args) => {
        promptText = readFileSync(args[args.indexOf("--system-prompt-file") + 1]!, "utf8");
        return child as unknown as ChildProcess;
      },
      killGraceMs: 20,
    });
    const events = await run(adapter, schemaRequest());
    expect(events.some(e => e.type === "error")).toBe(false);
    expect(promptText).not.toContain("ocx_schema_probe_marker");
    expect(child.written.join("")).not.toContain("ocx_schema_probe_marker");
  });

  test("a structured payload is surfaced as plain text and is never validated against the requested schema", async () => {
    const payload = '{"answer":"42"}';
    const stdout = [
      enc.encode('{"type":"system","subtype":"init"}\n'),
      enc.encode(textDelta(payload)),
      enc.encode('{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":4,"output_tokens":2}}\n'),
    ];
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => fakeChild(stdout, { exitCode: 0 }) as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });
    const events = await run(adapter, schemaRequest());
    // The payload deliberately VIOLATES the requested schema — it has no
    // `ocx_schema_probe_marker` — so this case is only meaningful if the route does not
    // enforce what it asked for.
    expect(payload).not.toContain("ocx_schema_probe_marker");
    // How this route represents a final structured response: as ordinary text deltas plus a
    // terminal done. There is no schema validation, no parse, and no conformance signal —
    // the requested schema never reached the CLI, so the CLI could not have honoured it.
    expect(events.map(e => e.type)).toEqual(["text_delta", "done"]);
    expect((events[0] as { text: string }).text).toBe(payload);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
  });

  test("a streamed completion emits one text_delta per CLI delta, not one coalesced frame", async () => {
    const stdout = [
      enc.encode('{"type":"system","subtype":"init"}\n'),
      enc.encode(textDelta('{"answer":')),
      enc.encode(textDelta('"42"}')),
      // The CLI also sends the complete assistant message it already streamed. It must not
      // produce a second copy of the text.
      enc.encode(JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: '{"answer":"42"}' }],
          stop_reason: "stop",
          usage: { input_tokens: 4, output_tokens: 2 },
        },
      }) + "\n"),
      enc.encode('{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":4,"output_tokens":2}}\n'),
    ];
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => fakeChild(stdout, { exitCode: 0 }) as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });
    const events = await run(adapter, schemaRequest());
    // The streamed path is the primary one; the complete-assistant fallback only runs when no
    // partial delta was seen. Two CLI deltas therefore mean two client-visible deltas, and
    // the fallback frame does not add a third copy of the same text.
    const deltas = events.filter(e => e.type === "text_delta");
    expect(deltas.map(e => (e as { text: string }).text)).toEqual(['{"answer":', '"42"}']);
    expect(events.map(e => e.type)).toEqual(["text_delta", "text_delta", "done"]);
  });

  test("tool-call events captured before a truncated final frame remain intact", async () => {
    const stdout = [
      enc.encode('{"type":"system","subtype":"init","mcp_servers":[{"name":"opencodex","status":"connected"}]}\n'),
      enc.encode(claudeCliToolFrame(0, "tu_1", CLAUDE_CLI_MCP_TOOL, '{"path":"a"}')),
      // The turn dies at EOF: a final frame that was cut off mid-write.
      enc.encode('{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":5,'),
    ];
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => fakeChild(stdout, { exitCode: 0 }) as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });
    const events = await run(adapter, claudeCliToolRequest());
    // The truncated frame is reported, but the call captured before it is not discarded: the
    // client still learns which tool was asked for and with which arguments, so it can execute
    // it and return the result.
    const starts = events.filter(e => e.type === "tool_call_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ type: "tool_call_start", id: "tu_1", name: "read_file" });
    expect(events.filter(e => e.type === "tool_call_delta").map(e => (e as { arguments: string }).arguments))
      .toEqual(['{"path":"a"}']);
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(1);
    const err = events.find(e => e.type === "error");
    expect(err).toBeDefined();
    expect(err).toMatchObject({ code: "protocol_error", status: 502 });
    expect(String((err as { message: string }).message)).toContain("Malformed stream-json frame received from coding-agent CLI");
  });

  test("a caller-owned tool catalog and its results are unaffected by a requested schema", async () => {
    let capturedArgs: string[] = [];
    let promptText = "";
    const child = fakeChild([
      enc.encode('{"type":"system","subtype":"init","mcp_servers":[{"name":"opencodex","status":"connected"}]}\n'),
      enc.encode('{"type":"result","subtype":"success","is_error":false}\n'),
    ]);
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/opt/homebrew/bin/claude",
      spawn: (_command, args) => {
        capturedArgs = [...args];
        promptText = readFileSync(args[args.indexOf("--system-prompt-file") + 1]!, "utf8");
        return child as unknown as ChildProcess;
      },
      killGraceMs: 20,
    });
    const events = await run(adapter, claudeCliToolRequest({
      options: { textFormat: { type: "json_schema", name: "probe", schema: SCHEMA } },
      context: {
        messages: [
          { role: "user", content: "Read the fixture", timestamp: 0 },
          { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "fixture.txt" } }], timestamp: 1 },
          { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "the executed result", isError: false, timestamp: 2 },
        ],
        tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
      },
    }));
    // The catalog still reaches the CLI exactly as it does without a schema...
    expect(capturedArgs[capturedArgs.indexOf("--tools") + 1]).toBe("");
    expect(capturedArgs).toContain("--strict-mcp-config");
    expect(capturedArgs).toContain("--allowedTools");
    expect(capturedArgs).toContain("--mcp-config");
    // ...and the schema still reaches neither the argv nor either input the route builds, even
    // when the replayed history carries the call and the executed result.
    expect(JSON.stringify(capturedArgs)).not.toContain("ocx_schema_probe_marker");
    expect(promptText).not.toContain("ocx_schema_probe_marker");
    const written = child.written.join("");
    expect(written).not.toContain("ocx_schema_probe_marker");
    expect(written).toContain("TOOL RESULT (call_id: call_1)");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("the shared capture-only MCP flow tells the CLI that built-in tools and user MCP servers are disabled", async () => {
    let promptText = "";
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/opt/homebrew/bin/claude",
      spawn: (_command, args) => {
        promptText = readFileSync(args[args.indexOf("--system-prompt-file") + 1]!, "utf8");
        return fakeChild([
          enc.encode('{"type":"system","subtype":"init","mcp_servers":[{"name":"opencodex","status":"connected"}]}\n'),
          enc.encode('{"type":"result","subtype":"success","is_error":false}\n'),
        ]) as unknown as ChildProcess;
      },
      killGraceMs: 20,
    });
    await run(adapter, claudeCliToolRequest());
    // The argv half of the capture-only contract is covered by the existing argument tests
    // (--tools "", --strict-mcp-config, no permission bypass). The prompt half is this line:
    // the turn also tells the CLI, in the instructions it actually reads, that it has no
    // built-in tools and no user-configured MCP servers.
    expect(promptText).toContain("Your built-in tools and user-configured MCP servers are disabled.");
    expect(promptText).toContain("The MCP process captures call intent only.");
  });
});
