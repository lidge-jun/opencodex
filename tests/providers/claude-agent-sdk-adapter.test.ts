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
} from "../../src/adapters/claude-agent-sdk/adapter";
import { baseScopedEnv } from "../../src/adapters/coding-agent/turn";
import { CLAUDE_CLI_PROFILE, clearClaudeCliBinaryCache } from "../../src/adapters/claude-agent-sdk/profiles";
import { effectiveAdapterContract, getAdapterDefinition } from "../../src/adapters/registry";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

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

function fakeChild(stdout: Uint8Array[], opts: { stderr?: string; exitCode?: number } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Readable.from(stdout);
  child.stderr = Readable.from(opts.stderr ? [enc.encode(opts.stderr)] : []);
  child.written = [];
  child.stdin = new Writable({ write(chunk, _enc, cb) { child.written.push(String(chunk)); cb(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; return true; };
  setTimeout(() => { child.exitCode = opts.exitCode ?? 0; child.emit("close", opts.exitCode ?? 0); }, 3);
  return child;
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "claude-agent-sdk",
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

describe("claude-agent-sdk is an official-harness provider, not a Messages relay", () => {
  test("the registry row and the adapter agree on the one canonical destination", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "claude-agent-sdk");
    expect(entry).toBeDefined();
    expect(entry!.adapter).toBe("claude-agent-sdk");
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
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "claude-agent-sdk")!;
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
    expect(deriveProviderPresets().find(candidate => candidate.id === "claude-agent-sdk"))
      .toMatchObject({ auth: "key", keyOptional: true });
  });

  test("the adapter inherits the shared coding-agent contract instead of a second wire", () => {
    expect(getAdapterDefinition("claude-agent-sdk")?.contractParent).toBe("codebuddy");
    expect(effectiveAdapterContract("claude-agent-sdk").wire).toBe("codebuddy");
  });
});

describe("claude-agent-sdk headless arguments keep tool ownership with the client", () => {
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

describe("claude-agent-sdk child environment carries no credential and no proxy destination", () => {
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

describe("claude-agent-sdk runTurn fails closed before any spawn", () => {
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

describe("claude-agent-sdk stages the folded prompt out of argv", () => {
  test("keeps the folded prompt out of argv, in a private file that is removed afterwards", async () => {
    const secret = "private-system-instruction";
    let promptFile = "";
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/opt/homebrew/bin/claude",
      spawn: (_command, args) => {
        expect(args).not.toContain(secret);
        const index = args.indexOf("--system-prompt-file");
        expect(index).toBeGreaterThanOrEqual(0);
        promptFile = args[index + 1] ?? "";
        expect(readFileSync(promptFile, "utf8")).toBe(secret);
        if (process.platform !== "win32") expect(statSync(promptFile).mode & 0o777).toBe(0o600);
        return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
      },
      killGraceMs: 20,
    });

    await run(adapter, parsed({ context: { systemPrompt: [secret], messages: [] } }));
    expect(promptFile).not.toBe("");
    expect(existsSync(promptFile)).toBe(false);
  });

  test("a request with no system prompt stages an empty replacement, never the harness preset", async () => {
    // Omitting the flag is not "no system prompt": it is Claude Code's own fourteen-block preset,
    // which describes a harness with tools this turn does not have. An empty file is what the CLI
    // snapshots as an empty system prompt (verified against 2.1.270 through the prompt_snapshot
    // attachment), and it is the same request the Messages API path forwards with no system message.
    let promptFile = "";
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/opt/homebrew/bin/claude",
      spawn: (_command, args) => {
        const index = args.indexOf("--system-prompt-file");
        expect(index).toBeGreaterThanOrEqual(0);
        promptFile = args[index + 1] ?? "";
        expect(readFileSync(promptFile, "utf8")).toBe("");
        return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
      },
      killGraceMs: 20,
    });

    await run(adapter, parsed());
    expect(existsSync(promptFile)).toBe(false);
  });
});

describe("claude-agent-sdk runTurn streams a subscription turn", () => {
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
    expect(child.written.join("")).toContain('"text":"hello"');
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
