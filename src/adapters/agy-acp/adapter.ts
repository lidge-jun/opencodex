/**
 * Antigravity CLI over the Agent Client Protocol (`agy acp`): one ACP session per turn (plan 080).
 *
 * The official binary owns its own sign-in; this adapter never reads, stores or forwards a Google
 * credential. One account (the CLI's), no rotation, local requests only, Gemini and Claude models only, and
 * interactive use only (see ./policy.ts). runTurn-only: a JSON-RPC session over a child process has no
 * fetch-shaped request, so buildRequest is an identity placeholder and parseStream is disabled.
 *
 * Boundary: the CLI starts in request-review, where every command and any file access outside the
 * workspace (an empty private directory) asks for permission, and this client refuses every ask.
 * `--sandbox` is passed as additional hardening of the agent's terminal commands; Google documents
 * that it has no effect where the sandbox is unavailable, so it is not promised. Allow rules the user
 * set in their own agy settings still apply.
 *
 * Errors carry fixed text only: the child's stderr is drained and discarded, and child-authored error
 * messages, permission titles and frames never reach a client or a log.
 */
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import { baseScopedEnv } from "../coding-agent/turn";
import { getConfigDir } from "../../config/paths";
import { SendBudgetExhaustedError } from "../../lib/upstream-retry";
import {
  ACP_AUTH_REQUIRED, MAX_ACP_LINE_BYTES, MAX_ACP_TOTAL_BYTES, acpSystemText, acpTerminal, acpUpdateToEvents,
  acpPromptBlocks, UnsupportedAcpMedia, classifyFrame, initializeFrame, mapAcpUsage, methodNotFoundFrame, permissionCancelledFrame,
  sessionCancelFrame, sessionNewFrame, sessionPromptFrame, setConfigOptionFrame, type AcpFailureCode, type JsonRpcId,
} from "./acp";
import {
  currentSelection, effortLabels, findSelector, matchValue, parseConfigOptions, proveModel,
  type AcpConfigOption, type AcpSelectValue,
} from "./options";
import { AGY_ACP_MIN_VERSION, AGY_INSTALL_HINT, MAX_AGY_VERSION_OUTPUT_LENGTH, probeAgyVersion, readAgyExecutable, resolveAgyBinary, type AgyVersionProbe } from "./binary";
import { AgyAcpCleanupError, AgyAcpTreeCleanupError, agySpawnCreatedNoProcess, createTurnWorkspace, defaultAgyAcpSpawn, reapProcessTree, type AgyAcpChild, type AgyAcpSpawn, type TurnWorkspace } from "./process";
import { AcpTurnOutput } from "./output-redaction";
import { stageClientTools } from "./client-tools";
import { agyAcpPolicyRefusal } from "./policy";

/** Identity only: the transport is stdio. Never fetched. */
export const AGY_ACP_IDENTITY_URL = "https://antigravity.google/docs/cli/acp";
export const AGY_ACP_ARGS = ["acp", "--sandbox"] as const;

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const VERSION_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 2_000;
const REAP_TIMEOUT_MS = 5_000;

type ErrorEvent = Extract<AdapterEvent, { type: "error" }>;

const LOGIN_MESSAGE = "Antigravity CLI is not signed in. Run `agy acp --login` (or `agy`) and sign in.";
const FAILURE_MESSAGES: Record<Exclude<AcpFailureCode, "agy_login_required">, string> = {
  agy_acp_turn_limit: "The Antigravity CLI stopped at its turn request limit before finishing the answer.",
  agy_acp_cancelled: "The Antigravity CLI cancelled the turn (for example after a refused permission request).",
  agy_acp_protocol: "The Antigravity CLI ended the turn without a valid ACP answer.",
  agy_acp_model_unproven: "The Antigravity CLI did not confirm the selected model, so the turn was not sent.",
  agy_acp_model_switched: "The Antigravity CLI switched away from the selected model during the turn; the turn was cancelled.",
  agy_acp_unsupported_selection: "The Antigravity CLI did not advertise a single model selector, so a supported model cannot be selected.",
  agy_acp_unavailable: "The Antigravity CLI could not be started.",
};

function failure(code: AcpFailureCode, detail?: string): ErrorEvent {
  if (code === "agy_login_required") return { type: "error", status: 401, errorType: "authentication_error", code, message: LOGIN_MESSAGE };
  const status = code === "agy_acp_unavailable" ? 503 : 502;
  const message = detail ? `${FAILURE_MESSAGES[code]} (${detail})` : FAILURE_MESSAGES[code];
  return { type: "error", status, errorType: status === 503 ? "api_error" : "upstream_error", code, message };
}

function emitVersionFailure(version: Exclude<AgyVersionProbe, { ok: true }>, emit: (event: AdapterEvent) => void): void {
  emit(failure("agy_acp_unavailable", version.reason === "too_old"
    ? `Antigravity CLI ${AGY_ACP_MIN_VERSION.join(".")} or newer is required for ACP; found ${version.version}`
    : "the Antigravity CLI version could not be read"));
}

function invalidRequest(code: string, message: string): ErrorEvent {
  return { type: "error", status: 400, errorType: "invalid_request_error", code, message };
}

export interface AgyAcpDeps {
  spawn?: AgyAcpSpawn;
  resolveBinary?: () => string | undefined;
  probeVersion?: (binary: string, signal?: AbortSignal) => Promise<AgyVersionProbe>;
  createWorkspace?: () => Promise<TurnWorkspace>;
  clientVersion?: string;
  turnTimeoutMs?: number;
  reap?: (child: AgyAcpChild) => Promise<void>;
}

/** Run `agy --version` with no shell, a scoped env, a private cwd, bounded output and a timeout. */
async function runVersion(
  binary: string,
  makeWorkspace: () => Promise<TurnWorkspace>,
  spawnChild: AgyAcpSpawn,
  cleanup: (workspace: TurnWorkspace, child?: AgyAcpChild) => Promise<void>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const executable = readAgyExecutable(binary);
  if (!executable) return undefined;
  let workspace: TurnWorkspace | undefined;
  let child: AgyAcpChild | undefined;
  let spawnFailed = false;
  let version: string | undefined;
  try {
    workspace = await makeWorkspace();
    if (signal?.aborted || readAgyExecutable(binary)?.identity !== executable.identity) throw new Error("Version probe cancelled before spawn");
    const probe = spawnChild(executable.path, ["--version"], { cwd: workspace.dir, env: childEnv(workspace) });
    child = probe;
    let out: string | undefined = "";
    const exitCode = await new Promise<number | null | undefined>(resolve => {
      const finish = (code?: number | null): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(code);
      };
      const onAbort = (): void => finish();
      const timer = setTimeout(onAbort, VERSION_TIMEOUT_MS);
      probe.on("error", (error: NodeJS.ErrnoException) => {
        spawnFailed = agySpawnCreatedNoProcess(probe, error);
        finish();
      });
      probe.once("close", finish);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      const { stdin, stdout, stderr } = probe;
      if (!stdin || !stdout || !stderr) {
        out = undefined;
        return; // Wait for the deferred spawn error or closure.
      }
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        if (out !== undefined) out = out.length + chunk.length <= MAX_AGY_VERSION_OUTPUT_LENGTH ? out + chunk : undefined;
      });
      stderr.on("data", () => {});
      stdin.on("error", () => {});
      stdin.end();
    });
    if (exitCode === 0 && !signal?.aborted) version = out;
  } catch { /* probe failed */ }
  if (workspace) {
    try { await cleanup(workspace, spawnFailed ? undefined : child); } catch (error) {
      if (!(error instanceof AgyAcpCleanupError)) throw error;
      // A natural Windows exit can supply a valid version even though taskkill can no
      // longer confirm its tree. The reaper warns and the workspace stays in place.
      if (!(error instanceof AgyAcpTreeCleanupError) || error.platform !== "win32") return undefined;
    } finally {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    }
  }
  return signal?.aborted ? undefined : version;
}

function childEnv(workspace: TurnWorkspace): Record<string, string> {
  // A scoped allowlist, never the proxy's environment: no provider, admin or API credentials.
  return { ...baseScopedEnv(), NO_COLOR: "1", TMPDIR: workspace.tmp, TEMP: workspace.tmp, TMP: workspace.tmp };
}

function wireModelId(modelId: string): string {
  return modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
}

export function createAgyAcpAdapter(provider: OcxProviderConfig, deps: AgyAcpDeps = {}): ProviderAdapter {
  const spawnChild = deps.spawn ?? defaultAgyAcpSpawn;
  const resolveBinary = deps.resolveBinary ?? (() => resolveAgyBinary());
  const makeWorkspace = deps.createWorkspace ?? (() => createTurnWorkspace(getConfigDir()));
  const reap = deps.reap ?? (child => reapProcessTree(child, { graceMs: KILL_GRACE_MS, reapTimeoutMs: REAP_TIMEOUT_MS }));
  async function cleanup(workspace: TurnWorkspace, child?: AgyAcpChild): Promise<void> {
    if (child) await reap(child);
    await workspace.remove();
  }
  const probeVersion = deps.probeVersion ?? ((binary, signal) =>
    probeAgyVersion(binary, target => runVersion(target, makeWorkspace, spawnChild, cleanup, signal)));
  const turnTimeoutMs = deps.turnTimeoutMs ?? TURN_TIMEOUT_MS;

  return {
    name: "agy-acp",
    reportsPhysicalSends: true,

    buildRequest() {
      return { url: provider.baseUrl || AGY_ACP_IDENTITY_URL, method: "POST", headers: {}, body: "" };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield failure("agy_acp_protocol", "runTurn only");
    },

    async runTurn(parsed: OcxParsedRequest, incoming: IncomingMeta, emit: (event: AdapterEvent) => void) {
      // First, before any probe or spawn: the use policy (defense in depth behind the pipeline preflight).
      const refusal = agyAcpPolicyRefusal({
        headers: incoming.headers, body: parsed._rawBody, comboAttempt: incoming.comboAttempt,
        internalDecisionCall: incoming.internalDecisionCall, subagentFallback: incoming.subagentFallback,
        inboundTransport: incoming.inboundTransport, unattendedHttpTurn: incoming.agyAcpUnattendedHttpTurn,
      });
      if (refusal) { emit({ type: "error", ...refusal }); return; }
      if (incoming.abortSignal?.aborted) return;

      const requested = wireModelId(parsed.modelId);
      if (!/^(?:gemini|claude)[-.]/i.test(requested)) {
        emit(invalidRequest("agy_acp_model_not_gemini", "The Antigravity CLI (ACP) provider serves Gemini and Claude models only."));
        return;
      }
      const effort = parsed.options.reasoning;
      const thoughtWanted = effort && effort !== "none" ? effortLabels(effort) : undefined;
      if (effort && effort !== "none" && !thoughtWanted) {
        emit(invalidRequest("agy_acp_effort_not_offered", "This reasoning effort has no Antigravity CLI thinking level."));
        return;
      }

      const binary = resolveBinary();
      if (!binary) { emit(failure("agy_acp_unavailable", AGY_INSTALL_HINT)); return; }
      const initial = readAgyExecutable(binary);
      if (!initial) { emit(failure("agy_acp_unavailable", AGY_INSTALL_HINT)); return; }
      const version = await probeVersion(initial.path, incoming.abortSignal);
      if (incoming.abortSignal?.aborted) return;
      if (!version.ok) { emitVersionFailure(version, emit); return; }
      let workspace: TurnWorkspace;
      try { workspace = await makeWorkspace(); } catch {
        emit(failure("agy_acp_unavailable", "no private workspace could be created outside the OpenCodex home"));
        return;
      }

      try {
        let tools: Awaited<ReturnType<typeof stageClientTools>>;
        try {
          tools = await stageClientTools(parsed, workspace.tmp);
        } catch {
          await cleanup(workspace);
          emit(invalidRequest("agy_acp_tool_catalog", "The client tool catalog could not be prepared."));
          return;
        }
        const executable = readAgyExecutable(binary);
        if (incoming.abortSignal?.aborted || !executable) {
          await cleanup(workspace);
          if (!incoming.abortSignal?.aborted) emit(failure("agy_acp_unavailable", AGY_INSTALL_HINT));
          return;
        }
        if (executable.identity !== initial.identity) {
          const refreshed = await probeVersion(executable.path, incoming.abortSignal);
          if (incoming.abortSignal?.aborted || !refreshed.ok || readAgyExecutable(binary)?.identity !== executable.identity) {
            await cleanup(workspace);
            if (!incoming.abortSignal?.aborted) {
              if (!refreshed.ok) emitVersionFailure(refreshed, emit);
              else emit(failure("agy_acp_unavailable", "the Antigravity CLI changed during startup"));
            }
            return;
          }
        }
        await driveTurn({ binary: executable.path, tools, workspace, parsed, incoming, emit, requested, thoughtWanted });
      } catch (error) {
        if (!(error instanceof AgyAcpCleanupError)) throw error;
        emit({ type: "error", status: 502, errorType: "upstream_error", code: "agy_acp_protocol", message: error.message });
      }
    },
  };

  async function driveTurn(turn: {
    tools: Awaited<ReturnType<typeof stageClientTools>>; binary: string; workspace: TurnWorkspace; parsed: OcxParsedRequest; incoming: IncomingMeta;
    emit: (event: AdapterEvent) => void; requested: string; thoughtWanted: readonly string[] | undefined;
  }): Promise<void> {
    const { tools, workspace, parsed, incoming, emit, requested, thoughtWanted } = turn;
    let child: AgyAcpChild;
    try {
      child = spawnChild(turn.binary, [...AGY_ACP_ARGS], { cwd: workspace.dir, env: childEnv(workspace) });
    } catch {
      await cleanup(workspace);
      emit(failure("agy_acp_unavailable", AGY_INSTALL_HINT));
      return;
    }

    type Pending = "initialize" | "session/new" | "set_model" | "set_thought" | "prompt";
    const outstanding = new Map<JsonRpcId, Pending>();
    let nextId = 1;
    let settled = false;
    let spawnFailed = false;
    let sessionId: string | undefined;
    let systemOnSession = false;
    let allowsImage = false;
    let state: AcpConfigOption[] = [];
    let target: AcpSelectValue | undefined;
    const { stdin, stdout, stderr } = child;
    let modelSetterPending = false;
    let prompting = false;
    let usage: OcxUsage | undefined;
    let pendingTool: ReturnType<typeof tools.capture>;
    let pendingToolSettleScheduled = false;
    const permissionCancelledCalls = new Set<string>();
    const rejectedToolCalls = new Set<string>();
    type DeferredPromptOutcome =
      | { kind: "done"; stopReason?: Extract<ReturnType<typeof acpTerminal>, { kind: "done" }>["stopReason"]; usage?: OcxUsage }
      | { kind: "cancelled" };
    let deferredPromptOutcome: DeferredPromptOutcome | undefined;
    let sawFrame = false;
    let buffer = "";
    let totalBytes = 0;
    const output = new AcpTurnOutput(emitOutput);
    let resolveTurn!: () => void;
    let rejectTurn!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });

    const send = (frame: Record<string, unknown>): void => {
      if (stdin && !stdin.destroyed) stdin.write(`${JSON.stringify(frame)}\n`);
    };
    const request = (kind: Pending, build: (id: JsonRpcId) => Record<string, unknown>): void => {
      const id = nextId++;
      outstanding.set(id, kind);
      send(build(id));
    };

    const turnTimer = setTimeout(() => finish(failure("agy_acp_protocol", "timed out")), turnTimeoutMs);
    const onAbort = (): void => {
      if (sessionId && prompting) send(sessionCancelFrame(sessionId));
      finish(undefined, true);
    };

    /** Settle once: reap the child before publishing the terminal event. */
    function finish(terminal: AdapterEvent | undefined, aborted = false, refusal?: { error: unknown }): void {
      if (settled) return;
      settled = true;
      clearTimeout(turnTimer);
      incoming.abortSignal?.removeEventListener("abort", onAbort);
      const reaped = cleanup(workspace, spawnFailed ? undefined : child).catch(error => {
        // The reaper warns and retains the workspace. Keep an existing dispatch refusal.
        if (!refusal || !(error instanceof AgyAcpCleanupError)) throw error;
      });
      try { stdout?.destroy(); } catch { /* already closed */ }
      void reaped.finally(() => {
        if (!aborted && !incoming.abortSignal?.aborted && terminal) {
          output.flush();
        }
      }).then(() => {
        if (!aborted && !incoming.abortSignal?.aborted && terminal) {
          if (terminal.type === "done" && terminal.stopReason === "tool_use") {
            for (const event of pendingTool?.events ?? []) emit(event);
          }
          emit(terminal);
        }
        if (refusal) rejectTurn(refusal.error);
        else resolveTurn();
      }).catch(rejectTurn);
    }
    const fail = (code: AcpFailureCode, detail?: string): void => finish(failure(code, detail));

    function emitOutput(type: "text_delta" | "thinking_delta", text: string): void {
      if (!text) return;
      emit(type === "text_delta" ? { type, text } : { type, thinking: text });
    }

    /** During generation a lost proof cancels the prompt; before it, the prompt is never sent. */
    function checkSelectedModel(): boolean {
      const proof = proveModel(state, modelSetterPending ? "pending" : "selected", requested);
      if (proof.ok) return true;
      if (prompting) {
        if (sessionId) send(sessionCancelFrame(sessionId));
        fail("agy_acp_model_switched");
      } else {
        fail("agy_acp_model_unproven");
      }
      return false;
    }

    function adoptState(raw: unknown): boolean {
      const parsedState = parseConfigOptions(raw);
      if (!parsedState) { fail(prompting ? "agy_acp_model_switched" : "agy_acp_model_unproven"); return false; }
      state = parsedState;
      return true;
    }

    function afterModelSelected(): void {
      if (!checkSelectedModel()) return;
      if (thoughtWanted) {
        const found = findSelector(state, "thought_level");
        if (!found.ok) {
          finish(invalidRequest("agy_acp_effort_not_offered", "This Antigravity CLI offers no thinking level selector."));
          return;
        }
        const match = matchValue(found.selector.values, thoughtWanted);
        if (!match.ok) {
          finish(invalidRequest("agy_acp_effort_not_offered", "The requested reasoning effort is not offered by this Antigravity CLI."));
          return;
        }
        if (currentSelection(found.selector)?.value !== match.value.value) {
          request("set_thought", id => setConfigOptionFrame(id, sessionId!, found.selector.id, match.value.value));
          return;
        }
      }
      sendPrompt();
    }

    function checkSelectedThinking(): boolean {
      if (!thoughtWanted) return true;
      const thought = findSelector(state, "thought_level");
      if (thought.ok) {
        const desired = matchValue(thought.selector.values, thoughtWanted);
        if (desired.ok && currentSelection(thought.selector)?.value === desired.value.value) return true;
      }
      fail("agy_acp_protocol", "thinking level not acknowledged");
      return false;
    }

    function sendPrompt(): void {
      if (settled) return;
      if (!checkSelectedModel() || !checkSelectedThinking()) return;
      const refuse = (error: unknown): void => finish(undefined, false, { error });
      try {
        const prompt = acpPromptBlocks(parsed, !systemOnSession, systemOnSession ? undefined : tools.instruction);
        if (!allowsImage && prompt.some(block => block.type === "image")) {
          return finish(invalidRequest("unsupported_input_modality", "This ACP session did not advertise image input."));
        }
        const promptId = nextId++;
        const promptLine = `${JSON.stringify(sessionPromptFrame(promptId, sessionId!, prompt))}\n`;
        if (Buffer.byteLength(promptLine, "utf8") > MAX_ACP_LINE_BYTES) {
          return finish(invalidRequest("unsupported_input_modality", "The ACP prompt exceeds the maximum frame size."));
        }
        const decision = incoming.sendBudget?.reserveDispatch({ sendClass: "transient", targetKey: AGY_ACP_IDENTITY_URL });
        if (decision && !decision.allowed) return refuse(new SendBudgetExhaustedError());
        const permit = decision?.permit;
        const dispatch = async (): Promise<void> => {
          try {
            // Let the current stdout callback apply all decoded config updates before spending the permit.
            await Promise.resolve();
            if (settled) return;
            if (incoming.abortSignal?.aborted) return onAbort();
            if (!checkSelectedModel() || !checkSelectedThinking()) return;
            if (!stdin || stdin.destroyed || stdin.writableEnded) return fail("agy_acp_protocol", "prompt pipe closed");
            incoming.beforePhysicalSend?.();
            if (permit && !permit.use()) return refuse(new SendBudgetExhaustedError());
            prompting = true;
            incoming.onPhysicalSend?.({ ordinal: 1 });
            outstanding.set(promptId, "prompt");
            stdin.write(promptLine);
          } catch (error) {
            refuse(error);
          }
        };
        const sending = permit?.execute ? permit.execute(dispatch) : dispatch();
        void sending.catch(refuse).finally(() => permit?.release());
      } catch (error) {
        if (error instanceof UnsupportedAcpMedia) return finish(invalidRequest("unsupported_input_modality", error.message));
        refuse(error);
      }
    }

    function onReply(kind: Pending, result: unknown, error: { code?: unknown } | undefined): void {
      if (error) {
        if (error.code === ACP_AUTH_REQUIRED) return fail("agy_login_required");
        const code = typeof error.code === "number" && Number.isSafeInteger(error.code) ? error.code : undefined;
        return fail("agy_acp_protocol", `${kind} failed${code !== undefined ? `, code ${code}` : ""}`);
      }
      const r = result && typeof result === "object" ? result as Record<string, unknown> : {};
      if (kind === "initialize") {
        if (r.protocolVersion !== 1) return fail("agy_acp_protocol", "initialize: unsupported protocol version");
        const caps = r.agentCapabilities as { promptCapabilities?: { image?: boolean }; sessionCapabilities?: { systemPrompt?: unknown } } | undefined;
        allowsImage = caps?.promptCapabilities?.image === true;
        const system = [acpSystemText(parsed), tools.instruction].filter(Boolean).join("\n\n");
        systemOnSession = !!system && !!caps?.sessionCapabilities?.systemPrompt && typeof caps.sessionCapabilities.systemPrompt === "object";
        request("session/new", id => sessionNewFrame(id, workspace.dir, systemOnSession ? system : undefined, tools.servers));
        return;
      }
      if (kind === "session/new") {
        if (typeof r.sessionId !== "string" || !r.sessionId) return fail("agy_acp_protocol", "session/new: no session");
        sessionId = r.sessionId;
        const initialState = parseConfigOptions(r.configOptions);
        if (!initialState) return fail("agy_acp_unsupported_selection");
        state = initialState;
        const proof = proveModel(state, "initial", requested);
        if (!proof.ok) {
          if (proof.reason === "no_selector" || proof.reason === "ambiguous_selector") return fail("agy_acp_unsupported_selection");
          if (proof.reason === "requested_not_offered" || proof.reason === "requested_ambiguous") {
            return finish(invalidRequest("agy_acp_model_not_offered", "The requested model is not offered by this Antigravity CLI."));
          }
          return fail("agy_acp_model_unproven");
        }
        target = proof.target;
        if (currentSelection(proof.selector)?.value !== target!.value) {
          modelSetterPending = true;
          request("set_model", id => setConfigOptionFrame(id, sessionId!, proof.selector.id, target!.value));
          return;
        }
        return afterModelSelected();
      }
      if (kind === "set_model") {
        modelSetterPending = false;
        if (!adoptState(r.configOptions)) return;
        return afterModelSelected();
      }
      if (kind === "set_thought") {
        if (!adoptState(r.configOptions)) return;
        return sendPrompt();
      }
      // prompt
      usage = mapAcpUsage(r.usage) ?? usage;
      const terminal = acpTerminal(r.stopReason, incoming.abortSignal?.aborted === true);
      if (terminal.kind === "aborted") return finish(undefined, true);
      if (terminal.kind === "error") {
        // agy can acknowledge our cancelled permission in the same read as its captured call.
        if (terminal.code === "agy_acp_cancelled" && pendingTool && permissionCancelledCalls.has(pendingTool.id)) {
          deferredPromptOutcome = { kind: "cancelled" };
          return;
        }
        return fail(terminal.code);
      }
      if (terminal.kind === "refusal") return finish({ type: "incomplete", reason: "content_filter", retryable: false, usage });
      if (pendingTool) {
        deferredPromptOutcome = { kind: "done", stopReason: terminal.stopReason, usage };
        return; // The captured call settles after this batch of frames.
      }
      if (tools.required) return fail("agy_acp_protocol", "required client tool was not called");
      finish({ type: "done", ...(usage ? { usage } : {}), ...(terminal.stopReason ? { stopReason: terminal.stopReason } : {}) });
    }

    function schedulePendingToolSettle(): void {
      if (pendingToolSettleScheduled) return;
      pendingToolSettleScheduled = true;
      queueMicrotask(() => {
        pendingToolSettleScheduled = false;
        if (settled || incoming.abortSignal?.aborted) return;
        if (pendingTool) {
          if (!checkSelectedModel() || !checkSelectedThinking()) return;
          finish({ type: "done", stopReason: "tool_use", endTurn: false, usage });
          return;
        }
        const deferred = deferredPromptOutcome;
        deferredPromptOutcome = undefined;
        if (!deferred) return;
        if (deferred.kind === "cancelled") return fail("agy_acp_cancelled");
        if (tools.required) return fail("agy_acp_protocol", "required client tool was not called");
        finish({ type: "done", ...(deferred.usage ? { usage: deferred.usage } : {}), ...(deferred.stopReason ? { stopReason: deferred.stopReason } : {}) });
      });
    }

    function captureClientCall(call: unknown, permission = false): boolean {
      if (!prompting || settled || incoming.abortSignal?.aborted) return false;
      const record = call && typeof call === "object" ? call as Record<string, unknown> : undefined;
      const id = typeof record?.toolCallId === "string" ? record.toolCallId : undefined;
      const status = record?.status;
      if (id) {
        if (status === "failed" || (status === "cancelled" && !permissionCancelledCalls.has(id))) {
          rejectedToolCalls.add(id);
          permissionCancelledCalls.delete(id);
          if (pendingTool?.id === id) pendingTool = undefined;
          return true;
        }
        if (rejectedToolCalls.has(id)) return true;
      }
      if (deferredPromptOutcome) return false;
      const captured = tools.capture(call);
      if (!captured || !checkSelectedModel()) return false;
      if (permission && (!pendingTool || pendingTool.id === captured.id)) {
        permissionCancelledCalls.add(captured.id);
      }
      if (pendingTool) return true;
      pendingTool = captured;
      schedulePendingToolSettle();
      return true;
    }

    function handle(raw: unknown): void {
      const frame = classifyFrame(raw);
      if (frame.kind === "invalid") return fail("agy_acp_protocol", "malformed frame");
      if (frame.kind === "request") {
        const params = frame.params as { sessionId?: unknown; toolCall?: unknown } | undefined;
        send(frame.method === "session/request_permission" ? permissionCancelledFrame(frame.id) : methodNotFoundFrame(frame.id));
        if (frame.method === "session/request_permission" && sessionId && params?.sessionId === sessionId) {
          captureClientCall(params.toolCall, true);
        }
        return;
      }
      if (frame.kind === "response") {
        const kind = outstanding.get(frame.id);
        if (!kind) return fail("agy_acp_protocol", "unexpected reply");
        outstanding.delete(frame.id);
        return onReply(kind, frame.result, frame.error);
      }
      if (frame.method !== "session/update") return;
      const params = frame.params as { sessionId?: unknown; update?: Record<string, unknown> } | undefined;
      if (!sessionId || params?.sessionId !== sessionId) return;
      const update = params.update;
      if (!update || typeof update !== "object") return;
      if (update.sessionUpdate === "config_option_update") {
        if (!adoptState(update.configOptions)) return;
        if (target && !checkSelectedModel()) return;
        if (prompting) emit({ type: "heartbeat" });
        return;
      }
      if (!prompting) return;
      if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
        && captureClientCall(update)) return;
      for (const event of acpUpdateToEvents(update)) {
        if (event.type !== "text_delta" && event.type !== "thinking_delta") {
          emit(event);
          continue;
        }
        if (!output.push(event.type, event.type === "text_delta" ? event.text : event.thinking)) emit({ type: "heartbeat" });
      }
    }

    function flush(rawLine: string): void {
      if (Buffer.byteLength(rawLine, "utf8") > MAX_ACP_LINE_BYTES) return fail("agy_acp_protocol", "frame over the line limit");
      const line = rawLine.trim();
      if (!line || settled) return;
      let parsedFrame: unknown;
      try { parsedFrame = JSON.parse(line); } catch {
        // Banner text before the first frame is tolerated; after it, a bad line is corruption.
        if (sawFrame || line.startsWith("{")) fail("agy_acp_protocol", "malformed frame");
        return;
      }
      sawFrame = true;
      handle(parsedFrame);
    }

    incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnFailed = agySpawnCreatedNoProcess(child, error);
      fail("agy_acp_unavailable", AGY_INSTALL_HINT);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      flush(buffer);
      buffer = "";
      if (settled) return;
      if (!stdin || !stdout || !stderr) return fail("agy_acp_unavailable", AGY_INSTALL_HINT);
      fail("agy_acp_protocol", `exited before answering${typeof code === "number" ? `, exit code ${code}` : ""}`);
    });
    if (!stdin || !stdout || !stderr) return finished; // Bun can report spawn errors asynchronously.
    stdin.on("error", () => {});
    // stderr is drained so the child never blocks, and discarded: it may echo prompt text.
    stderr.on("data", () => {});
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      if (settled) return;
      totalBytes += Buffer.byteLength(chunk, "utf8");
      if (totalBytes > MAX_ACP_TOTAL_BYTES) return fail("agy_acp_protocol", "output over the turn limit");
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        flush(line);
        if (settled) return;
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_ACP_LINE_BYTES) fail("agy_acp_protocol", "frame over the line limit");
    });
    stdout.on("end", () => {
      const tail = buffer;
      buffer = "";
      flush(tail);
      if (!settled) fail("agy_acp_protocol", "stdout ended before answering");
    });

    if (incoming.abortSignal?.aborted) onAbort();
    else request("initialize", id => initializeFrame(id, deps.clientVersion ?? process.env.OPENCODEX_VERSION ?? "0.0.0"));
    await finished;
  }
}
