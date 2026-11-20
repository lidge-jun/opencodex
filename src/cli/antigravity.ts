import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createInterface as createTerminal } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { AGY_INSTALL_HINT, MAX_AGY_VERSION_OUTPUT_LENGTH, probeAgyVersion, resolveAgyBinary } from "../adapters/agy-acp/binary";
import { parseConfigOptions, findSelector, isGeminiValue, proveModel } from "../adapters/agy-acp/options";
import { baseScopedEnv } from "../adapters/coding-agent/turn";
import { isAgentDriven } from "./agent-driven";
import { permissionOutcome, rejectOnce, reviewPermission, terminalText, toolProgress, type PermissionRequest, type ToolUpdate } from "./antigravity-review";

const SETUP_TIMEOUT_MS = 20_000;
const runFile = promisify(execFile);

interface Session {
  sessionId: string;
  configOptions?: unknown;
}

interface Message {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number };
  params?: PermissionRequest & {
    sessionId?: string;
    update?: ToolUpdate & { sessionUpdate: string; content?: { type: string; text?: string }; configOptions?: unknown };
  };
}

export function antigravityRefusal(args: string[], tty: boolean, env: NodeJS.ProcessEnv): string | undefined {
  if (args.length && !(args.length === 1 && (args[0] === "work" || args[0] === "native"))) {
    return "Usage: ocx antigravity [work|native] (enter prompts in the session).";
  }
  if (!tty || isAgentDriven(env) || env.OCX_SERVICE || env.SSH_CONNECTION || env.SSH_TTY) {
    return "Antigravity ACP requires a human at a local interactive terminal.";
  }
}

export async function runAntigravitySession(
  child: ChildProcessWithoutNullStreams,
  cwd: string,
  question: (text: string, signal: AbortSignal) => Promise<string>,
  write: (text: string) => void,
  stop: AbortController,
  mode: "plan" | "default" = "plan",
): Promise<void> {
  let nextId = 0;
  let sessionId: string | undefined;
  let prompting = false;
  let expectedModeId: string | undefined;
  let expectedModel: string | undefined;
  let turnInput: AbortController | undefined;
  let reviewQueue = Promise.resolve();
  let reviewOutput: string | undefined;
  const toolCalls = new Map<string, ToolUpdate>();
  let pending: { id: number; finish: (error?: Error, result?: unknown) => void } | undefined;
  const lines = createInterface({ input: child.stdout });
  const childClosed = new Promise<void>(resolve => child.once("close", resolve));
  const fail = (error: Error) => {
    pending?.finish(error);
    stop.abort(error);
  };
  const stopped = () => pending?.finish(stop.signal.reason);
  stop.signal.addEventListener("abort", stopped);
  child.on("error", (error: NodeJS.ErrnoException) => fail(new Error(error.code === "ENOENT"
    ? "Install the official Antigravity CLI and put agy on PATH."
    : "Could not start the official Antigravity CLI.")));
  child.on("close", () => fail(new Error("The Antigravity CLI closed the session.")));
  child.stdin.on("error", () => fail(new Error("The Antigravity CLI closed its input.")));

  function send(message: object): void {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  function matchesSelection(raw: unknown): boolean {
    const state = parseConfigOptions(raw);
    if (!state) return false;
    return (!expectedModeId || state.some(option => option.id === expectedModeId && option.currentValue === mode)) &&
      (!expectedModel || proveModel(state, "selected", expectedModel).ok);
  }

  function display(text: string): void {
    if (reviewOutput === undefined) write(text);
    else if (reviewOutput.length + text.length <= 64 * 1024) reviewOutput += text;
    else fail(new Error("Too much agent output while waiting for a tool decision."));
  }

  async function askForPermission(text: string, signal: AbortSignal): Promise<string> {
    reviewOutput = "";
    try { return await question(text, signal); }
    finally {
      const buffered = reviewOutput;
      reviewOutput = undefined;
      if (buffered) write(buffered);
    }
  }

  function onPermission(id: number | string, params?: Message["params"]): void {
    if (mode !== "default" || !turnInput || !sessionId || params?.sessionId !== sessionId) {
      send({ id, result: permissionOutcome(rejectOnce(params)) });
      return;
    }
    // ACP can request multiple decisions concurrently. Give each the terminal in order;
    // a turn ending or a disconnect invalidates all of its outstanding decisions.
    const signal = AbortSignal.any([turnInput.signal, stop.signal]);
    const callId = params.toolCall?.toolCallId;
    const request = { ...params, toolCall: { ...(callId && toolCalls.get(callId)), ...params.toolCall } };
    reviewQueue = reviewQueue.then(async () => {
      if (stop.signal.aborted) return;
      const option = await reviewPermission(request, askForPermission, signal, write);
      if (!stop.signal.aborted) send({ id, result: permissionOutcome(signal.aborted ? undefined : option) });
    }).catch(() => {
      if (!stop.signal.aborted) send({ id, result: permissionOutcome() });
    });
  }

  lines.on("line", line => {
    if (stop.signal.aborted) return;
    let message: Message;
    try {
      message = JSON.parse(line);
      if (message?.jsonrpc !== "2.0") throw new Error();
    } catch {
      fail(new Error("The Antigravity CLI returned an invalid ACP message."));
      return;
    }
    if (message.method && message.id != null) {
      if (message.method === "session/request_permission") {
        onPermission(message.id, message.params);
      } else {
        send({ id: message.id, error: { code: -32601, message: "Method not supported" } });
      }
    } else if (message.method === "session/update" && sessionId && message.params?.sessionId === sessionId) {
      const update = message.params?.update;
      if (update?.sessionUpdate === "config_option_update" && !matchesSelection(update.configOptions)) {
        fail(new Error("Antigravity changed the session model or mode. Open a new session."));
        return;
      }
      if (prompting && update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
        display(terminalText(update.content.text));
      }
      if (prompting && (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update")) {
        const id = update.toolCallId;
        if (typeof id === "string" && id) {
          const call = { ...toolCalls.get(id), ...update };
          // Permission frames may carry only the ID. Keep the announced details until completion.
          toolCalls.set(id, call.status === "completed" || call.status === "failed" ? { toolCallId: id } : call);
          display(toolProgress(call));
        }
      }
    } else if (pending && message.id === pending.id) {
      turnInput?.abort();
      const code = message.error?.code;
      pending.finish(message.error ? new Error(code === -32000
        ? "Sign in with your personal Google account in agy, then reopen the session."
        : "The Antigravity CLI rejected the ACP request.") : undefined, message.result);
    }
  });

  function request<T>(method: string, params: object): Promise<T> {
    stop.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      const timer = method === "session/prompt" ? undefined : setTimeout(
        () => fail(new Error("The Antigravity CLI did not respond during ACP setup.")), SETUP_TIMEOUT_MS,
      );
      pending = { id, finish(error, result) {
        clearTimeout(timer);
        pending = undefined;
        if (error) reject(error);
        else resolve(result as T);
      } };
      send({ id, method, params });
    });
  }

  try {
    const info = await request<{ protocolVersion: number }>("initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (info?.protocolVersion !== 1) throw new Error("This session requires Antigravity CLI with ACP v1 support.");
    const session = await request<Session>("session/new", { cwd, mcpServers: [] });
    sessionId = session?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) throw new Error("The Antigravity CLI did not create a session.");

    const state = parseConfigOptions(session.configOptions) ?? [];
    const model = findSelector(state, "model");
    const modeOption = state.find(option => option.id === "mode" && option.type === "select");
    if (!model.ok || !modeOption?.values.some(option => option.value === mode)) {
      throw new Error("The Antigravity CLI did not offer the requested session mode or model selector.");
    }
    const models = model.selector.values.filter(isGeminiValue);
    if (!models.length) throw new Error("The Antigravity CLI did not offer a Gemini model.");
    const initial = models.findIndex(option => option.value === model.selector.currentValue);
    const defaultModel = initial < 0 ? 0 : initial;
    write(models.map((option, index) => (index + 1) + ". " + terminalText(option.name || option.value)).join("\n") + "\n");
    const choice = (await question("Gemini model [" + (defaultModel + 1) + "]: ", stop.signal)).trim();
    const selected = models[choice === "" ? defaultModel : /^[1-9][0-9]*$/.test(choice) ? Number(choice) - 1 : -1];
    if (!selected) throw new Error("Choose a number from the Gemini model list.");

    async function setOption(configId: string, value: string): Promise<void> {
      const result = await request<Pick<Session, "configOptions">>("session/set_config_option", { sessionId, configId, value });
      if (!matchesSelection(result?.configOptions)) {
        throw new Error("The Antigravity CLI did not confirm the requested session option.");
      }
    }
    expectedModeId = modeOption.id;
    await setOption(modeOption.id, mode);
    expectedModel = selected.value;
    await setOption(model.selector.id, selected.value);
    stop.signal.throwIfAborted();
    write("Antigravity ACP: " + terminalText(selected.name) + " · " + mode + " mode · " + terminalText(cwd) + "\nType /exit to quit.\n");
    for (;;) {
      const text = (await question("You> ", stop.signal)).trim();
      if (text === "/exit") return;
      if (!text) continue;
      if (text.startsWith("/")) {
        write("Slash commands run in the official CLI: ocx antigravity native\n");
        continue;
      }
      prompting = true;
      turnInput = new AbortController();
      toolCalls.clear();
      try {
        const turn = await request<{ stopReason: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
        if (!turn || !["end_turn", "cancelled", "max_tokens", "refusal", "max_turn_requests"].includes(turn.stopReason)) {
          throw new Error("The Antigravity CLI returned an unexpected turn result.");
        }
        if (mode === "default") write("\n[turn ended: " + turn.stopReason + " · tool calls reported: " + toolCalls.size + "]\n");
        else write(turn.stopReason === "end_turn" ? "\n" : "\nTurn ended: " + turn.stopReason + "\n");
      } finally {
        turnInput.abort();
        turnInput = undefined;
        await reviewQueue;
        if (!stop.signal.aborted) prompting = false;
      }
    }
  } finally {
    stop.signal.removeEventListener("abort", stopped);
    lines.close();
    if (stop.signal.aborted && prompting && sessionId && child.stdin.writable) {
      send({ method: "session/cancel", params: { sessionId } });
    }
    child.stdin.end();
    // Let the official agent receive cancellation before terminating a stuck child.
    if (prompting) await Promise.race([childClosed, delay(500, undefined, { ref: false })]);
    child.kill();
  }
}

function launchNativeAntigravity(binary: string): Promise<number> {
  return new Promise(resolve => {
    // The official TUI owns the terminal; there is no ACP or prompt relay on this path.
    const child = spawn(binary, [], { stdio: "inherit" });
    child.once("error", (error: NodeJS.ErrnoException) => {
      console.error(error.code === "ENOENT"
        ? "Install the official Antigravity CLI and put agy on PATH."
        : "Could not start the official Antigravity CLI.");
      resolve(1);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
}

export async function handleAntigravityCommand(args: string[]): Promise<number> {
  const refusal = antigravityRefusal(args, process.stdin.isTTY === true && process.stdout.isTTY === true, process.env);
  if (refusal) {
    console.error(refusal);
    return refusal.startsWith("Usage:") ? 64 : 1;
  }
  const binary = resolveAgyBinary();
  if (!binary) {
    console.error(AGY_INSTALL_HINT);
    return 1;
  }
  if (args[0] === "native") return await launchNativeAntigravity(binary);

  const terminal = createTerminal({ input: process.stdin, output: process.stdout });
  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error("Antigravity session interrupted."));
  terminal.on("SIGINT", interrupt);
  terminal.on("close", interrupt);
  process.on("SIGINT", interrupt);
  try {
    const env = baseScopedEnv();
    const version = await probeAgyVersion(binary, async target => {
      try {
        const result = await runFile(target, ["--version"], {
          env, windowsHide: true, timeout: 5_000, maxBuffer: MAX_AGY_VERSION_OUTPUT_LENGTH, signal: stop.signal,
        });
        return result.stdout;
      } catch { return undefined; }
    });
    stop.signal.throwIfAborted();
    if (!version.ok) throw new Error(AGY_INSTALL_HINT);
    // ACP is the only transport. Keep auth, settings and tools inside the official binary.
    const child = spawn(binary, ["acp", "--sandbox"], { windowsHide: true, env });
    child.stderr.resume();
    await runAntigravitySession(child, process.cwd(),
      (text, signal) => terminal.question(text, { signal }), text => process.stdout.write(text), stop,
      args[0] === "work" ? "default" : "plan");
    return 0;
  } catch (error) {
    const reason = stop.signal.aborted ? stop.signal.reason : error;
    console.error(reason instanceof Error ? reason.message : "Antigravity ACP session failed.");
    return reason instanceof Error && reason.message === "Antigravity session interrupted." ? 130 : 1;
  } finally {
    process.off("SIGINT", interrupt);
    terminal.close();
  }
}
