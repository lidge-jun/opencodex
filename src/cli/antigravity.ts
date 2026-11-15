import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createInterface as createTerminal } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { isAgentDriven } from "./agent-driven";

const SETUP_TIMEOUT_MS = 20_000;
const AGY_COMMAND = process.platform === "win32" ? "agy.exe" : "agy";

interface ConfigOption {
  id: string;
  category?: string;
  type: string;
  currentValue: string;
  options: ({ value: string } | { options: { value: string }[] })[];
}

interface Session {
  sessionId: string;
  configOptions?: ConfigOption[];
}

interface Message {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number };
  params?: {
    sessionId?: string;
    options?: { kind: string; optionId: string }[];
    update?: { sessionUpdate: string; content?: { type: string; text?: string }; configOptions?: ConfigOption[] };
  };
}

function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export function antigravityRefusal(args: string[], tty: boolean, env: NodeJS.ProcessEnv): string | undefined {
  if (args.length && !(args.length === 1 && args[0] === "native")) {
    return "Usage: ocx antigravity [native] (enter prompts in the session).";
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
): Promise<void> {
  let nextId = 0;
  let sessionId: string | undefined;
  let prompting = false;
  let selectedModel: string | undefined;
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
        const rejectOnce = Array.isArray(message.params?.options) && message.params.options.find(
          option => option?.kind === "reject_once" && typeof option.optionId === "string",
        );
        send({ id: message.id, result: { outcome: rejectOnce
          ? { outcome: "selected", optionId: rejectOnce.optionId } : { outcome: "cancelled" } } });
      } else {
        send({ id: message.id, error: { code: -32601, message: "Method not supported" } });
      }
    } else if (message.method === "session/update" && sessionId && message.params?.sessionId === sessionId) {
      const update = message.params?.update;
      if (selectedModel && update?.sessionUpdate === "config_option_update" && update.configOptions?.some(
        option => (option.category === "model" && option.currentValue !== selectedModel) ||
          (option.id === "mode" && option.currentValue !== "plan"),
      )) {
        fail(new Error("Antigravity changed the session model or mode. Open a new session."));
      }
      if (prompting && update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
        write(terminalText(update.content.text));
      }
    } else if (pending && message.id === pending.id) {
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
    if (!sessionId) throw new Error("The Antigravity CLI did not create a session.");

    const model = session.configOptions?.find(option => option.category === "model" && option.type === "select");
    const models = model?.options.flatMap(option => "value" in option ? [option] : option.options)
      .map(option => option.value).filter(id => /^gemini-[a-z0-9.-]+$/.test(id)) ?? [];
    const mode = session.configOptions?.find(option => option.id === "mode" && option.type === "select");
    if (!model || !models.length || !mode) throw new Error("The Antigravity CLI did not offer a Gemini model and plan mode.");
    const initial = models.indexOf(model.currentValue);
    const defaultModel = initial < 0 ? 0 : initial;
    write(models.map((id, index) => (index + 1) + ". " + id).join("\n") + "\n");
    const choice = (await question("Gemini model [" + (defaultModel + 1) + "]: ", stop.signal)).trim();
    const selected = models[choice === "" ? defaultModel : /^[1-9][0-9]*$/.test(choice) ? Number(choice) - 1 : -1];
    if (!selected) throw new Error("Choose a number from the Gemini model list.");

    async function setOption(configId: string, value: string): Promise<ConfigOption[]> {
      const result = await request<Pick<Session, "configOptions">>("session/set_config_option", { sessionId, configId, value });
      if (!result?.configOptions?.some(option => option.id === configId && option.currentValue === value)) {
        throw new Error("The Antigravity CLI did not confirm the requested session option.");
      }
      return result.configOptions;
    }
    await setOption(mode.id, "plan");
    const config = await setOption(model.id, selected);
    if (!config.some(option => option.id === mode.id && option.currentValue === "plan")) {
      throw new Error("The Antigravity CLI did not retain plan mode after model selection.");
    }
    selectedModel = selected;

    write("Antigravity ACP: " + selected + " · plan mode. Type /exit to quit.\n");
    for (;;) {
      const text = (await question("You> ", stop.signal)).trim();
      if (text === "/exit") return;
      if (!text) continue;
      if (text.startsWith("/")) {
        write("Slash commands run in the official CLI: ocx antigravity native\n");
        continue;
      }
      prompting = true;
      try {
        const turn = await request<{ stopReason: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
        if (!turn || !["end_turn", "cancelled", "max_tokens", "refusal", "max_turn_requests"].includes(turn.stopReason)) {
          throw new Error("The Antigravity CLI returned an unexpected turn result.");
        }
        write(turn.stopReason === "end_turn" ? "\n" : "\nTurn ended: " + turn.stopReason + "\n");
      } finally {
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

function launchNativeAntigravity(): Promise<number> {
  return new Promise(resolve => {
    // The official TUI owns the terminal; there is no ACP or prompt relay on this path.
    const child = spawn(AGY_COMMAND, [], { stdio: "inherit" });
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
  if (args[0] === "native") return await launchNativeAntigravity();

  const terminal = createTerminal({ input: process.stdin, output: process.stdout });
  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error("Antigravity session interrupted."));
  terminal.on("SIGINT", interrupt);
  terminal.on("close", interrupt);
  process.on("SIGINT", interrupt);
  try {
    // ACP is the only transport. Keep auth, settings and tools inside the official binary.
    const child = spawn(AGY_COMMAND, ["acp", "--sandbox"], { windowsHide: true });
    child.stderr.resume();
    await runAntigravitySession(child, process.cwd(),
      (text, signal) => terminal.question(text, { signal }), text => process.stdout.write(text), stop);
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
