// FAB-03 deterministic fake `codex app-server` (0.146.0 wire protocol).
// A child process that speaks the SAME newline-delimited JSON-RPC 2.0 protocol as
// the real app-server, driven by the FAKE_CODEX_SCRIPT env var. Tests point the
// adapter at this fake via its `command` option so process behavior (crash, hang,
// late events, duplicate terminal, approval round-trips) is fully deterministic
// with zero model spend.
import { createInterface } from "node:readline";

type ScriptTurn = {
  inputMatch?: string;
  notifications?: Array<{ method: string; params: Record<string, unknown> }>;
  lateEvents?: Array<{ method: string; params: Record<string, unknown> }>;
  duplicateTerminal?: boolean;
  emitTerminalFirst?: boolean;
  heldUntilInterrupt?: boolean;
  approval?: { method: string; params: Record<string, unknown> };
  status?: "completed" | "failed" | "interrupted" | "inProgress";
  turnError?: string;
};

type Script = {
  startupDelayMs?: number;
  neverRespondToInit?: boolean;
  exitAtStartup?: boolean;
  exitCode?: number;
  crashOnTurnStart?: boolean;
  hangOnShutdown?: boolean;
  rejectThreadStart?: string;
  emitJunkBeforeInit?: boolean;
  emitLateCompleteAfterInterrupt?: boolean;
  turns?: ScriptTurn[];
};

const script: Script = JSON.parse(process.env.FAKE_CODEX_SCRIPT ?? "{}");

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function respond(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id: string | number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

function notify(method: string, params: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method, params, emittedAtMs: Date.now() });
}

let threadSeq = 0;
let turnSeq = 0;
let approvalSeq = 100;

/** Responses we still owe after sending a server->client approval request. */
const awaitingApprovalResponse = new Map<
  string | number,
  { resolve: (msg: Record<string, unknown>) => void }
>();

function threadOf(id: string): Record<string, unknown> {
  return {
    id,
    sessionId: `session-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: true,
    isPinned: false,
    modelProvider: "openai",
    createdAt: Date.now() / 1000,
    updatedAt: Date.now() / 1000,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: process.cwd(),
    cliVersion: "0.146.0",
    source: { type: "codexAppServer" },
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function turnOf(id: string, status: string, error: Record<string, unknown> | null): Record<string, unknown> {
  return {
    id,
    items: [],
    itemsView: { itemIds: [] },
    status,
    error,
    startedAt: Date.now() / 1000,
    completedAt: status === "inProgress" ? null : Date.now() / 1000,
    durationMs: null,
  };
}

/** Terminal payload shared by every terminal-event mode so payloads stay identical. */
function completedTurn(
  turnId: string,
  status: string | undefined,
  turnError: string | undefined,
): Record<string, unknown> {
  const resolved = status ?? "completed";
  return turnOf(
    turnId,
    resolved,
    resolved === "failed"
      ? { message: turnError ?? "fake failure", codexErrorInfo: null, additionalDetails: null }
      : null,
  );
}

const rl = createInterface({ input: process.stdin, crlfDelay: 100 });

rl.on("line", (line) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // malformed driver line: ignore
  }
  void handleMessage(msg);
});

async function handleMessage(msg: Record<string, unknown>): Promise<void> {
  const id = msg["id"] as string | number | undefined;
  const method = typeof msg["method"] === "string" ? msg["method"] : "";

  // A response to one of OUR server->client approval requests.
  if (id !== undefined && !method) {
    const pending = awaitingApprovalResponse.get(id);
    if (pending) {
      awaitingApprovalResponse.delete(id);
      pending.resolve(msg);
    }
    return;
  }

  const params = (msg["params"] ?? {}) as Record<string, unknown>;
  if (id === undefined) {
    if (method === "shutdownRequested") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "shutdownAck", params: {} }) + "\n");
      setTimeout(() => process.exit(0), 10);
    }
    return;
  }

  if (method === "initialize") {
    if (script.startupDelayMs) {
      await wait(script.startupDelayMs);
    }
    if (script.exitAtStartup) {
      await wait(50);
      process.exit(script.exitCode ?? 0);
    }
    if (script.neverRespondToInit) return; // startup timeout test
    if (script.emitJunkBeforeInit) {
      // Malformed + oversized lines must be dropped by the transport, not crash it.
      process.stdout.write("this is not json\n");
      process.stdout.write(JSON.stringify({ method: "junk", params: { x: "y".repeat(1000) } }) + "\n");
    }
    respond(id, {
      userAgent: "fake-codex-app-server/0.146.0",
      codexHome: process.env.CODEX_HOME ?? "",
      platformFamily: "windows",
      platformOs: "windows",
    });
    notify("configWarning", { summary: "fake", details: null });
    return;
  }
  switch (method) {
    case "thread/start": {
      if (script.rejectThreadStart) {
        respondError(id, script.rejectThreadStart);
        return;
      }
      threadSeq++;
      const threadId = `thread-${threadSeq}`;
      respond(id, { thread: threadOf(threadId) });
      notify("thread/started", { thread: threadOf(threadId) });
      return;
    }
    case "thread/resume": {
      const threadId = String(params["threadId"] ?? "thread-resumed");
      respond(id, { thread: threadOf(threadId) });
      return;
    }
    case "thread/fork": {
      threadSeq++;
      const threadId = `thread-${threadSeq}`;
      respond(id, { thread: threadOf(threadId) });
      return;
    }
    case "thread/list":
      respond(id, { threads: [] });
      return;
    case "thread/delete":
      respond(id, {});
      return;
    case "turn/start": {
      const threadId = String(params["threadId"] ?? "thread-1");
      if (script.crashOnTurnStart) {
        await wait(30);
        process.exit(7);
      }
      turnSeq++;
      const turnId = `turn-${turnSeq}`;
      const scripted = pickTurn(params);
      respond(id, { turn: turnOf(turnId, "inProgress", null) });
      notify("turn/started", {
        threadId,
        turn: { id: turnId, status: "inProgress", items: [], itemsView: { itemIds: [] } },
      });
      if (scripted?.emitTerminalFirst) {
        // Out-of-order terminal: arrives BEFORE the scripted mid-turn notifications.
        await wait(5);
        notify("turn/completed", {
          threadId,
          turn: completedTurn(turnId, scripted?.status, scripted?.turnError),
        });
      }
      for (const n of scripted?.notifications ?? []) {
        await wait(5);
        notify(n.method, { threadId, turnId, ...n.params });
      }
      if (scripted?.approval) {
        await wait(5);
        const reqId = ++approvalSeq;
        send({
          jsonrpc: "2.0",
          id: reqId,
          method: scripted.approval.method,
          params: {
            threadId,
            turnId,
            itemId: `item-${turnId}`,
            startedAtMs: Date.now(),
            reason: null,
            ...scripted.approval.params,
          },
        });
        await new Promise<void>((resolve) => {
          awaitingApprovalResponse.set(reqId, { resolve: () => resolve() });
        });
      }
      if (scripted?.heldUntilInterrupt) {
        // Stay in progress until a turn/interrupt lands (interrupt mid-turn test).
        return;
      }
      if (scripted?.duplicateTerminal) {
        await wait(5);
        notify("turn/completed", {
          threadId,
          turn: completedTurn(turnId, scripted?.status, scripted?.turnError),
        });
      }
      // emitTerminalFirst already delivered the terminal; the trailing terminal
      // belongs to the normal/duplicate modes only (modes stay separate).
      if (!scripted?.emitTerminalFirst) {
        await wait(5);
        notify("turn/completed", {
          threadId,
          turn: completedTurn(turnId, scripted?.status, scripted?.turnError),
        });
      }
      for (const late of scripted?.lateEvents ?? []) {
        await wait(5);
        notify(late.method, { threadId, turnId, ...late.params });
      }
      return;
    }
    case "turn/interrupt": {
      const threadId = String(params["threadId"] ?? "thread-1");
      const turnId = String(params["turnId"] ?? "turn-1");
      respond(id, {});
      await wait(5);
      notify("turn/completed", { threadId, turn: turnOf(turnId, "interrupted", null) });
      // Optional adversarial late terminal: a completed arriving AFTER interrupt
      // must not resurrect the turn (adapter terminal-once-per-turn invariant).
      if (script.emitLateCompleteAfterInterrupt) {
        await wait(10);
        notify("turn/completed", { threadId, turn: turnOf(turnId, "completed", null) });
      }
      return;
    }
    default:
      respondError(id, `fake: unsupported method ${method}`);
  }
}

function pickTurn(params: Record<string, unknown>): ScriptTurn | undefined {
  const input = (params["input"] ?? []) as Array<Record<string, unknown>>;
  const text = String(input[0]?.["text"] ?? "");
  const turns = script.turns ?? [];
  if (turns.length === 0) return undefined;
  return (
    turns.find((t) => t.inputMatch !== undefined && text.includes(t.inputMatch)) ??
    turns[0]
  );
}

// The fake exits on stdin EOF unless the script asks it to hang (forced-shutdown test).
process.stdin.on("end", () => {
  if (script.hangOnShutdown) {
    setInterval(() => {}, 1000); // stay alive despite EOF
    return;
  }
  setTimeout(() => process.exit(0), 20);
});

// Parent-death watchdog: bun's --isolate runner can terminate a worker without
// delivering stdin EOF on Windows, which leaves this child holding the worker's
// stdout pipe. The runner then waits for pipe EOF forever on macOS (30-minute CI
// job timeout) while Windows accumulates orphans that hold test ports across
// runs. Exit as soon as the spawning process is gone, even mid-handshake or in
// the hangOnShutdown script (the explicit force-kill test still wins first).
const spawnerPid = process.ppid;
const parentWatchdog = setInterval(() => {
  try {
    process.kill(spawnerPid, 0);
  } catch {
    process.exit(0);
  }
}, 500);
parentWatchdog.unref?.();
