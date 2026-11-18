/**
 * Antigravity CLI over the Agent Client Protocol (`agy acp`): one ACP session per turn (plan 080).
 *
 * The official binary owns its own sign-in; this adapter never reads, stores or forwards a Google
 * credential. One account (the CLI's), no rotation, local requests only, Gemini models only, and
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
  buildAcpPrompt, classifyFrame, initializeFrame, mapAcpUsage, methodNotFoundFrame, permissionCancelledFrame,
  sessionCancelFrame, sessionNewFrame, sessionPromptFrame, setConfigOptionFrame, type AcpFailureCode, type JsonRpcId,
} from "./acp";
import {
  currentSelection, effortLabels, findSelector, matchValue, parseConfigOptions, proveModel, safeOfferedValues,
  type AcpConfigOption, type AcpSelectValue,
} from "./options";
import { AGY_ACP_MIN_VERSION, AGY_INSTALL_HINT, probeAgyVersion, resolveAgyBinary, type AgyVersionProbe } from "./binary";
import { createTurnWorkspace, defaultAgyAcpSpawn, reapProcessTree, type AgyAcpChild, type AgyAcpSpawn, type TurnWorkspace } from "./process";
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
  agy_acp_model_unproven: "The Antigravity CLI did not confirm the selected Gemini model, so the turn was not sent.",
  agy_acp_model_switched: "The Antigravity CLI switched away from the selected Gemini model during the turn; the turn was cancelled.",
  agy_acp_unsupported_selection: "The Antigravity CLI did not advertise a single model selector, so a Gemini model cannot be selected.",
  agy_acp_unavailable: "The Antigravity CLI could not be started.",
};

function failure(code: AcpFailureCode, detail?: string): ErrorEvent {
  if (code === "agy_login_required") return { type: "error", status: 401, errorType: "authentication_error", code, message: LOGIN_MESSAGE };
  const status = code === "agy_acp_unavailable" ? 503 : 502;
  const message = detail ? `${FAILURE_MESSAGES[code]} (${detail})` : FAILURE_MESSAGES[code];
  return { type: "error", status, errorType: status === 503 ? "api_error" : "upstream_error", code, message };
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
function invalidRequest(code: string, message: string): ErrorEvent {
  return { type: "error", status: 400, errorType: "invalid_request_error", code, message };
}

export interface AgyAcpDeps {
  spawn?: AgyAcpSpawn;
  resolveBinary?: () => string | undefined;
  probeVersion?: (binary: string) => Promise<AgyVersionProbe>;
  createWorkspace?: () => Promise<TurnWorkspace>;
  clientVersion?: string;
  turnTimeoutMs?: number;
  reap?: (child: AgyAcpChild) => Promise<void>;
}

/** Run `agy --version` with no shell, a scoped env, a private cwd, bounded output and a timeout. */
async function runVersion(binary: string): Promise<string | undefined> {
  let workspace: TurnWorkspace | undefined;
  try {
    workspace = await createTurnWorkspace(getConfigDir());
    const child = defaultAgyAcpSpawn(binary, ["--version"], { cwd: workspace.dir, env: childEnv(workspace) });
    child.stdin.end();
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (out.length < 4096) out += chunk; });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    const closed = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), VERSION_TIMEOUT_MS);
      child.once("close", () => { clearTimeout(timer); resolve(true); });
      child.once("error", () => { clearTimeout(timer); resolve(false); });
    });
    if (!closed) await reapProcessTree(child, { graceMs: KILL_GRACE_MS, reapTimeoutMs: REAP_TIMEOUT_MS });
    return closed ? out : undefined;
  } catch {
    return undefined;
  } finally {
    await workspace?.remove();
  }
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
  const probeVersion = deps.probeVersion ?? (binary => probeAgyVersion(binary, runVersion));
  const makeWorkspace = deps.createWorkspace ?? (() => createTurnWorkspace(getConfigDir()));
  const reap = deps.reap ?? (child => reapProcessTree(child, { graceMs: KILL_GRACE_MS, reapTimeoutMs: REAP_TIMEOUT_MS }));
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
        inboundTransport: incoming.inboundTransport,
      });
      if (refusal) { emit({ type: "error", ...refusal }); return; }
      if (incoming.abortSignal?.aborted) return;

      const requested = wireModelId(parsed.modelId);
      if (!/^gemini[-.]/i.test(requested)) {
        emit(invalidRequest("agy_acp_model_not_gemini", "The Antigravity CLI (ACP) provider serves Gemini models only."));
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
      const version = await probeVersion(binary);
      if (!version.ok) {
        emit(failure("agy_acp_unavailable", version.reason === "too_old"
          ? `Antigravity CLI ${AGY_ACP_MIN_VERSION.join(".")} or newer is required for ACP; found ${version.version}`
          : "the Antigravity CLI version could not be read"));
        return;
      }
      let workspace: TurnWorkspace;
      try { workspace = await makeWorkspace(); } catch {
        emit(failure("agy_acp_unavailable", "no private workspace could be created outside the OpenCodex home"));
        return;
      }

      try {
        await driveTurn({ binary, workspace, parsed, incoming, emit, requested, thoughtWanted });
      } finally {
        await workspace.remove();
      }
    },
  };

  async function driveTurn(turn: {
    binary: string; workspace: TurnWorkspace; parsed: OcxParsedRequest; incoming: IncomingMeta;
    emit: (event: AdapterEvent) => void; requested: string; thoughtWanted: readonly string[] | undefined;
  }): Promise<void> {
    const { workspace, parsed, incoming, emit, requested, thoughtWanted } = turn;
    let child: AgyAcpChild;
    try {
      child = spawnChild(turn.binary, [...AGY_ACP_ARGS], { cwd: workspace.dir, env: childEnv(workspace) });
    } catch {
      emit(failure("agy_acp_unavailable", AGY_INSTALL_HINT));
      return;
    }

    type Pending = "initialize" | "session/new" | "set_model" | "set_thought" | "prompt";
    const outstanding = new Map<JsonRpcId, Pending>();
    let nextId = 1;
    let settled = false;
    let sessionId: string | undefined;
    let systemOnSession = false;
    let state: AcpConfigOption[] = [];
    let target: AcpSelectValue | undefined;
    let thoughtTarget: AcpSelectValue | undefined;
    let modelSetterPending = false;
    let prompting = false;
    let usage: OcxUsage | undefined;
    let sawFrame = false;
    let buffer = "";
    let totalBytes = 0;
    let resolveTurn!: () => void;
    let rejectTurn!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });

    const send = (frame: Record<string, unknown>): void => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(frame)}\n`);
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

    /** Settle once: emit the terminal (unless the caller aborted), then reap the group. */
    function finish(terminal: AdapterEvent | undefined, aborted = false, onReaped = resolveTurn): void {
      if (settled) return;
      settled = true;
      clearTimeout(turnTimer);
      incoming.abortSignal?.removeEventListener("abort", onAbort);
      if (!aborted && terminal) emit(terminal);
      try { child.stdout.destroy(); } catch { /* already closed */ }
      void reap(child).then(onReaped, rejectTurn);
    }
    const fail = (code: AcpFailureCode, detail?: string): void => finish(failure(code, detail));

    /** During generation a lost proof cancels the prompt; before it, the prompt is never sent. */
    function checkSelectedModel(): boolean {
      const proof = proveModel(state, modelSetterPending ? "pending" : "selected", requested, target);
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
          const offered = safeOfferedValues(found.selector.values, false);
          finish(invalidRequest("agy_acp_effort_not_offered", `The requested reasoning effort is not offered by this Antigravity CLI.${offered.length ? ` Offered: ${offered.join(", ")}.` : ""}`));
          return;
        }
        thoughtTarget = match.value;
        if (currentSelection(found.selector)?.value !== match.value.value) {
          request("set_thought", id => setConfigOptionFrame(id, sessionId!, found.selector.id, match.value.value));
          return;
        }
      }
      sendPrompt();
    }

    function sendPrompt(): void {
      if (!checkSelectedModel()) return;
      const prompt = buildAcpPrompt(parsed, !systemOnSession);
      const refuse = (error: unknown): void => finish(undefined, false, () => rejectTurn(error));
      try {
        const decision = incoming.sendBudget?.reserveDispatch({ sendClass: "transient", targetKey: AGY_ACP_IDENTITY_URL });
        if (decision && !decision.allowed) return refuse(new SendBudgetExhaustedError());
        const permit = decision?.permit;
        const dispatch = async (): Promise<void> => {
          try {
            if (settled) return;
            if (incoming.abortSignal?.aborted) return onAbort();
            if (!checkSelectedModel()) return;
            if (child.stdin.destroyed || child.stdin.writableEnded) return fail("agy_acp_protocol", "prompt pipe closed");
            incoming.beforePhysicalSend?.();
            if (permit && !permit.use()) return refuse(new SendBudgetExhaustedError());
            prompting = true;
            incoming.onPhysicalSend?.({ ordinal: 1 });
            request("prompt", id => sessionPromptFrame(id, sessionId!, prompt));
          } catch (error) {
            refuse(error);
          }
        };
        const sending = permit?.execute ? permit.execute(dispatch) : dispatch();
        void sending.catch(refuse).finally(() => permit?.release());
      } catch (error) {
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
        const caps = r.agentCapabilities as { sessionCapabilities?: { systemPrompt?: unknown } } | undefined;
        const system = acpSystemText(parsed);
        systemOnSession = !!system && !!caps?.sessionCapabilities?.systemPrompt && typeof caps.sessionCapabilities.systemPrompt === "object";
        request("session/new", id => sessionNewFrame(id, workspace.dir, systemOnSession ? system : undefined));
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
            const selector = findSelector(state, "model");
            const offered = selector.ok ? safeOfferedValues(selector.selector.values, true) : [];
            const shown = SAFE_ID.test(requested) ? `Model ${requested}` : "The requested model";
            return finish(invalidRequest("agy_acp_model_not_offered", `${shown} is not offered by this Antigravity CLI.${offered.length ? ` Gemini models offered: ${offered.join(", ")}.` : ""}`));
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
        const thought = findSelector(state, "thought_level");
        if (!thought.ok || currentSelection(thought.selector)?.value !== thoughtTarget?.value) return fail("agy_acp_protocol", "thinking level not acknowledged");
        return sendPrompt();
      }
      // prompt
      usage = mapAcpUsage(r.usage) ?? usage;
      const terminal = acpTerminal(r.stopReason, incoming.abortSignal?.aborted === true);
      if (terminal.kind === "aborted") return finish(undefined, true);
      if (terminal.kind === "error") return fail(terminal.code);
      finish({ type: "done", ...(usage ? { usage } : {}), ...(terminal.stopReason ? { stopReason: terminal.stopReason } : {}) });
    }

    function handle(raw: unknown): void {
      const frame = classifyFrame(raw);
      if (frame.kind === "invalid") return fail("agy_acp_protocol", "malformed frame");
      if (frame.kind === "request") {
        send(frame.method === "session/request_permission" ? permissionCancelledFrame(frame.id) : methodNotFoundFrame(frame.id));
        return;
      }
      if (frame.kind === "response") {
        const kind = outstanding.get(frame.id);
        if (!kind) return fail("agy_acp_protocol", "unexpected reply");
        outstanding.delete(frame.id);
        return onReply(kind, frame.result, frame.error);
      }
      if (frame.method !== "session/update") return;
      const update = (frame.params as { update?: Record<string, unknown> } | undefined)?.update;
      if (!update || typeof update !== "object") return;
      if (update.sessionUpdate === "config_option_update") {
        if (!adoptState(update.configOptions)) return;
        if (target && !checkSelectedModel()) return;
        if (prompting) emit({ type: "heartbeat" });
        return;
      }
      if (!prompting) return;
      for (const event of acpUpdateToEvents(update)) emit(event);
    }

    function flush(rawLine: string): void {
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
    child.stdin.on("error", () => {});
    child.on("error", () => fail("agy_acp_unavailable", AGY_INSTALL_HINT));
    child.on("close", (code: number | null) => {
      if (settled) return;
      flush(buffer);
      buffer = "";
      if (settled) return;
      fail("agy_acp_protocol", `exited before answering${typeof code === "number" ? `, exit code ${code}` : ""}`);
    });
    // stderr is drained so the child never blocks, and discarded: it may echo prompt text.
    child.stderr.on("data", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
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
    child.stdout.on("end", () => {
      const tail = buffer;
      buffer = "";
      flush(tail);
    });

    if (incoming.abortSignal?.aborted) onAbort();
    else request("initialize", id => initializeFrame(id, deps.clientVersion ?? process.env.OPENCODEX_VERSION ?? "0.0.0"));
    await finished;
  }
}
