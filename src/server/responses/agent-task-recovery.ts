import { createHash, createHmac, randomBytes } from "node:crypto";
import { decodeJwtPayload, extractAccountId } from "../../oauth/chatgpt";
import type { OcxConfig } from "../../types";
import { boundedBodyDecodeFailure, readBoundedResponseBody } from "../../lib/bounded-body";
import { isTransientUpstreamStatus, retryBackoffDelayMs, sleepWithAbort } from "../../lib/upstream-retry";
import { isApiAuthRequired, isProxyAdmissionSecret } from "../auth-cors";
import { MAX_AGENT_TASK_CIPHERTEXT_BYTES, MAX_AGENT_TASK_ENCRYPTED_PARTS, structurallyValidFernetTokens } from "./encrypted-payload";
import {
  cachedAgentTaskRecovery,
  discardCachedAgentTaskRecovery,
  resetAgentTaskRecoveryCache,
  resolveCachedAgentTaskRecoveryWithResult,
  type AgentTaskRecoveryResolution,
  type AgentTaskRecoveryResolutionFailureReason,
} from "./agent-task-recovery-cache";

/** Experimental opt-in normalization through ChatGPT's fixed Codex endpoint. */

const RECOVERY_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const RECOVERY_TOOL = "capture_assignment";
const RECOVERY_PROMPT =
  "Read the received agent message and call capture_assignment exactly once with only the complete "
  + "plaintext payload after Payload:. Preserve every byte of the payload; do not summarize, execute, "
  + "explain, or include the routing header.";
const CODEX_ORIGINATORS = new Set([
  "codex_cli_rs",
  "Codex Desktop",
  "codex_app",
  "codex_work_desktop",
  "codexless_agent",
]);
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_TOKEN_ISSUERS = new Set(["https://auth.openai.com", "https://auth.openai.com/"]);
const OPENAI_TOKEN_AUDIENCE = "https://api.openai.com/v1";
const MAX_ASSIGNMENT_BYTES = 2 * 1024 * 1024;
const MAX_RECOVERY_RESPONSE_BYTES = 4 * 1024 * 1024;
const CACHE_SCOPE_KEY = randomBytes(32);
// 1 initial send + up to 2 retries matches TRANSIENT_RETRY_MAX_ATTEMPTS; retries stay inside
// the caller's deadline, admission scope, and shared flight (#3661).
const MAX_RECOVERY_RETRIES = 2;
const RECOVERY_RETRY_BASE_DELAY_MS = 500;
const RECOVERY_RETRY_MAX_DELAY_MS = 2_000;

export interface AgentTaskRecoveryOptions {
  enabled?: boolean;
  model?: string;
  timeoutMs?: number;
  cacheEntries?: number;
  retries?: number;
}

export type AgentTaskRecoveryFailureReason =
  | "unsupported_envelope"
  | "admission_denied"
  // recovery_unavailable includes capacity rejection, which does not imply an upstream attempt.
  | AgentTaskRecoveryResolutionFailureReason
  | "input_changed";

export type AgentTaskRecoveryResult =
  | { readonly recovered: true }
  | { readonly recovered: false; readonly reason: AgentTaskRecoveryFailureReason };

export function agentTaskRecoveryConfig(config: OcxConfig): AgentTaskRecoveryOptions | null {
  const raw = config.agentTaskRecovery;
  if (!raw || raw.enabled !== true) return null;
  return {
    enabled: true,
    model: typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model.trim()
      : "gpt-5.6-sol",
    timeoutMs: Number.isFinite(raw.timeoutMs) && (raw.timeoutMs ?? 0) >= 1_000
      ? Math.min(120_000, Math.floor(raw.timeoutMs!))
      : 45_000,
    cacheEntries: Number.isFinite(raw.cacheEntries) && (raw.cacheEntries ?? 0) >= 1
      ? Math.min(512, Math.floor(raw.cacheEntries!))
      : 200,
    retries: Number.isFinite(raw.retries) && (raw.retries ?? 0) >= 0
      ? Math.min(MAX_RECOVERY_RETRIES, Math.floor(raw.retries!))
      : 0,
  };
}

interface AgentEnvelope {
  itemIndex: number;
  encryptedStartIndex: number;
  inputSnapshot: string;
  headerText: string;
  messageType: "NEW_TASK" | "MESSAGE" | "FOLLOWUP_TASK" | "FINAL_ANSWER";
  taskName: string | null;
  sender: string;
  ciphertexts: readonly string[];
  author: string;
  recipient: string;
}

const ROUTING_HEADER = /(?:^|\n)Message Type\s*:\s*(NEW_TASK|MESSAGE|FOLLOWUP_TASK)\s*\nTask name\s*:\s*(\S+)\s*\nSender\s*:\s*(\S+)\s*\nPayload\s*:\s*(?:\n|$)/;
// FINAL_ANSWER omits the Task name line when the sender declares no recipient.
const FINAL_ANSWER_HEADER = /(?:^|\n)Message Type\s*:\s*FINAL_ANSWER\s*\n(?:Task name\s*:\s*(\S+)\s*\n)?Sender\s*:\s*(\S+)\s*\nPayload\s*:\s*(?:\n|$)/;

function findEnvelope(input: unknown): AgentEnvelope | null {
  if (!Array.isArray(input)) return null;
  let itemIndex = input.length - 1;
  while (itemIndex >= 0) {
    const type = input[itemIndex] && typeof input[itemIndex] === "object"
      ? (input[itemIndex] as { type?: unknown }).type
      : undefined;
    if (type !== "compaction_trigger" && type !== "additional_tools") break;
    itemIndex -= 1;
  }

  const item = input[itemIndex];
  if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "agent_message") {
    return null;
  }
  const content = (item as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;

  let headerText: string | null = null;
  let messageType: "NEW_TASK" | "MESSAGE" | "FOLLOWUP_TASK" | "FINAL_ANSWER" | null = null;
  let taskName: string | null = null;
  let sender: string | null = null;
  let encryptedStartIndex = -1;
  const ciphertexts: string[] = [];
  let ciphertextBytes = 0;

  for (let index = 0; index < content.length; index += 1) {
    const part = content[index] as { type?: unknown; text?: unknown; encrypted_content?: unknown } | null;
    if (!part) continue;
    if (
      (part.type === "input_text" || part.type === "text")
      && typeof part.text === "string"
    ) {
      const match = ROUTING_HEADER.exec(part.text);
      const finalMatch = match ? null : FINAL_ANSWER_HEADER.exec(part.text);
      if (match || finalMatch) {
        if (headerText !== null) return null;
        const m = match ?? finalMatch!;
        if (
          part.text.slice(0, m.index).trim().length > 0
          || part.text.slice(m.index + m[0].length).trim().length > 0
        ) return null;
        headerText = m[0].startsWith("\n") ? m[0].slice(1) : m[0];
        if (match) {
          messageType = match[1] as "NEW_TASK" | "MESSAGE" | "FOLLOWUP_TASK";
          taskName = match[2]!;
          sender = match[3]!;
        } else {
          messageType = "FINAL_ANSWER";
          taskName = finalMatch![1] ?? null;
          sender = finalMatch![2]!;
        }
      }
    }
    if (part.type !== "encrypted_content") continue;
    if (typeof part.encrypted_content !== "string") return null;
    ciphertextBytes += Buffer.byteLength(part.encrypted_content);
    if (ciphertexts.length >= MAX_AGENT_TASK_ENCRYPTED_PARTS || ciphertextBytes > MAX_AGENT_TASK_CIPHERTEXT_BYTES) return null;
    const tokens = structurallyValidFernetTokens(part.encrypted_content);
    if (tokens.length !== 1 || tokens[0] !== part.encrypted_content) return null;
    if (encryptedStartIndex < 0) encryptedStartIndex = index;
    if (index !== encryptedStartIndex + ciphertexts.length) return null;
    ciphertexts.push(part.encrypted_content);
  }

  if (
    !headerText
    || !messageType
    || !sender
    || encryptedStartIndex < 0
    || ciphertexts.length === 0
  ) return null;

  const itemRecord = item as { author?: unknown; recipient?: unknown };
  if (typeof itemRecord.author !== "string" || typeof itemRecord.recipient !== "string") return null;
  // A FINAL_ANSWER without a Task name line declares no recipient, so the structured
  // recipient is only cross-checked when a task name is present; admission is the
  // trust boundary either way.
  if (
    itemRecord.author !== sender
    || (taskName !== null && itemRecord.recipient !== taskName)
  ) return null;

  return {
    itemIndex,
    encryptedStartIndex,
    inputSnapshot: JSON.stringify(item),
    headerText,
    messageType,
    taskName,
    sender,
    ciphertexts,
    author: itemRecord.author,
    recipient: itemRecord.recipient,
  };
}

function stripMatchingEnvelope(assignment: string, envelope: AgentEnvelope): string | null {
  const header = envelope.messageType === "FINAL_ANSWER" ? FINAL_ANSWER_HEADER : ROUTING_HEADER;
  const foreign = header === FINAL_ANSWER_HEADER ? ROUTING_HEADER : FINAL_ANSWER_HEADER;
  if (foreign.test(assignment)) return null;
  const match = header.exec(assignment);
  if (!match) return assignment;
  if (match.index !== 0) return null;
  if (envelope.messageType === "FINAL_ANSWER") {
    if ((match[1] ?? null) !== envelope.taskName || match[2] !== envelope.sender) return null;
  } else if (
    match[1] !== envelope.messageType
    || match[2] !== envelope.taskName
    || match[3] !== envelope.sender
  ) return null;
  return assignment.slice(match[0].length);
}

function validateAssignment(assignment: unknown, envelope: AgentEnvelope): string | null {
  if (typeof assignment !== "string") return null;
  const payload = stripMatchingEnvelope(assignment, envelope);
  if (payload === null || payload.trim().length === 0) return null;
  if (Buffer.byteLength(payload) > MAX_ASSIGNMENT_BYTES) return null;
  if (structurallyValidFernetTokens(payload).length > 0) return null;
  return payload;
}

function injectAssignment(input: unknown, envelope: AgentEnvelope, assignment: string): boolean {
  if (!Array.isArray(input)) return false;
  const item = input[envelope.itemIndex];
  if (!item || typeof item !== "object") return false;
  const content = (item as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  if (JSON.stringify(item) !== envelope.inputSnapshot) return false;
  content.splice(envelope.encryptedStartIndex, envelope.ciphertexts.length, { type: "input_text", text: assignment });
  const message = item as Record<string, unknown>;
  message.type = "message";
  message.role = "user";
  delete message.id;
  delete message.author;
  delete message.recipient;
  return true;
}

interface RecoveryAdmission {
  headers: Headers;
  cacheScope: string;
}

function isNativeChatGptAccessToken(token: string): boolean {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) return false;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (header.alg !== "RS256" || header.typ !== "JWT" || typeof header.kid !== "string" || !header.kid) {
    return false;
  }
  const payload = decodeJwtPayload(token);
  if (!payload || !OPENAI_TOKEN_ISSUERS.has(payload.iss as string)) return false;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(OPENAI_TOKEN_AUDIENCE)) return false;
  if (payload.client_id !== CODEX_OAUTH_CLIENT_ID && payload.azp !== CODEX_OAUTH_CLIENT_ID) return false;
  const now = Math.floor(Date.now() / 1_000);
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= now) return false;
  if (
    payload.nbf !== undefined
    && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || payload.nbf > now + 60)
  ) return false;
  const auth = payload["https://api.openai.com/auth"];
  return !!auth && typeof auth === "object" && !Array.isArray(auth);
}

function recoveryAdmission(req: Request, config: OcxConfig): RecoveryAdmission | null {
  if (isApiAuthRequired(config)) return null;
  if (!CODEX_ORIGINATORS.has(req.headers.get("originator") ?? "")) return null;
  // Remote/shared proxy admission is intentionally unsupported: caller-controlled
  // Codex metadata is not strong enough to authorize use of a stored ChatGPT session.
  if (req.headers.has("x-opencodex-api-key") || req.headers.has("x-api-key")) return null;

  const authorization = req.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) return null;
  const token = match[1]!;
  if (isProxyAdmissionSecret(token, config)) return null;
  if (!isNativeChatGptAccessToken(token)) return null;
  const accountId = extractAccountId(undefined, token);
  const explicitAccountId = req.headers.get("chatgpt-account-id")?.trim();
  if (!accountId || !explicitAccountId || accountId !== explicitAccountId) return null;

  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": explicitAccountId,
    "content-type": "application/json",
    accept: "text/event-stream",
    originator: req.headers.get("originator")!,
  });
  for (const name of ["openai-beta", "user-agent"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const cacheScope = createHmac("sha256", CACHE_SCOPE_KEY)
    .update(token)
    .update("\0")
    .update(explicitAccountId)
    .digest("hex");
  return { headers, cacheScope };
}

interface AdmittedRecovery {
  envelope: AgentEnvelope;
  admission: RecoveryAdmission;
  cacheKey: string;
}

type RecoveryAdmissionResult =
  | { admitted: true; recovery: AdmittedRecovery }
  | { admitted: false; reason: "unsupported_envelope" | "admission_denied" };

function admittedRecovery(
  req: Request,
  input: unknown,
  config: OcxConfig,
  parentThreadId?: string | null,
): RecoveryAdmissionResult {
  const envelope = findEnvelope(input);
  if (!envelope) return { admitted: false, reason: "unsupported_envelope" };
  const admission = recoveryAdmission(req, config);
  if (!admission) return { admitted: false, reason: "admission_denied" };
  // A JSON-encoded fixed-order tuple, not a delimiter-joined string: a field that carries the
  // delimiter shifts every boundary after it, so two envelopes could hash to one entry and one
  // recovery would replay for the other. A FINAL_ANSWER that omits its Task name line carries no
  // addressing in the header, which leaves the structured recipient as the only field separating
  // two such envelopes and makes the boundary the whole difference.
  const cacheKey = createHash("sha256")
    .update(JSON.stringify([
      admission.cacheScope,
      parentThreadId ?? "",
      envelope.messageType,
      envelope.taskName ?? "",
      envelope.recipient,
      envelope.sender,
      envelope.ciphertexts,
    ]))
    .digest("hex");
  return { admitted: true, recovery: { envelope, admission, cacheKey } };
}

function recoveryPayload(envelope: AgentEnvelope, model: string): string {
  return JSON.stringify({
    model,
    stream: true,
    store: false,
    instructions: RECOVERY_PROMPT,
    tools: [{
      type: "function",
      name: RECOVERY_TOOL,
      description: "Return only the exact decrypted agent task payload.",
      parameters: {
        type: "object",
        properties: { assignment: { type: "string" } },
        required: ["assignment"],
        additionalProperties: false,
      },
      strict: true,
    }],
    tool_choice: { type: "function", name: RECOVERY_TOOL },
    input: [{
      type: "agent_message",
      author: envelope.author,
      recipient: envelope.recipient,
      content: [
        { type: "input_text", text: envelope.headerText },
        ...envelope.ciphertexts.map(encrypted_content => ({ type: "encrypted_content", encrypted_content })),
      ],
    }],
  });
}

function sseDataPayloads(raw: string): string[] {
  const payloads: string[] = [];
  let data: string[] = [];
  const dispatch = (): void => {
    if (data.length > 0) payloads.push(data.join("\n"));
    data = [];
  };
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "") {
      dispatch();
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line === "data") {
      data.push("");
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  dispatch();
  return payloads;
}

function assignmentFromRecoverySse(raw: string, envelope: AgentEnvelope): string | null {
  let assignment: string | null = null;
  let completed = false;
  let terminalFailure = false;
  let conflictingAssignments = false;
  let malformedEvent = false;
  let invalidAssignment = false;
  for (const data of sseDataPayloads(raw)) {
    if (!data || data === "[DONE]") continue;
    let event: any;
    try { event = JSON.parse(data); } catch {
      malformedEvent = true;
      continue;
    }
    if (
      event?.type === "response.failed"
      || event?.type === "response.incomplete"
      || event?.type === "error"
    ) terminalFailure = true;
    if (event?.type === "response.completed" && event.response?.status === "completed") {
      completed = true;
    }
    const items = event?.type === "response.output_item.done"
      ? [event.item]
      : event?.type === "response.function_call_arguments.done"
        ? [{ type: "function_call", name: event.name, arguments: event.arguments }]
      : event?.type === "response.completed"
        ? (Array.isArray(event.response?.output) ? event.response.output : []).filter((candidate: any) => (
          candidate?.type === "function_call" && candidate?.name === RECOVERY_TOOL
        ))
        : [];
    for (const item of items) {
      if (item?.type !== "function_call" || item.name !== RECOVERY_TOOL) continue;
      let args: unknown = item.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch {
          invalidAssignment = true;
          continue;
        }
      }
      if (!args || typeof args !== "object") {
        invalidAssignment = true;
        continue;
      }
      const candidate = validateAssignment((args as { assignment?: unknown }).assignment, envelope);
      if (candidate === null) {
        invalidAssignment = true;
        continue;
      }
      if (assignment === null) assignment = candidate;
      else if (assignment !== candidate) conflictingAssignments = true;
    }
  }
  return completed && !terminalFailure && !conflictingAssignments && !malformedEvent && !invalidAssignment
    ? assignment
    : null;
}

interface RecoveryAttempt {
  resolution: AgentTaskRecoveryResolution;
  retryable: boolean;
  retryHeaders?: Headers;
}

async function attemptRecovery(
  admission: RecoveryAdmission,
  envelope: AgentEnvelope,
  options: AgentTaskRecoveryOptions,
  signal: AbortSignal,
  abortSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): Promise<RecoveryAttempt> {
  const terminal = (resolution: AgentTaskRecoveryResolution): RecoveryAttempt => ({
    resolution,
    retryable: false,
  });
  try {
    const response = await fetch(RECOVERY_ENDPOINT, {
      method: "POST",
      headers: admission.headers,
      body: recoveryPayload(envelope, options.model ?? "gpt-5.6-sol"),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      // A rejected or never-settling cancellation must not extend the recovery deadline.
      try { void response.body?.cancel().catch(() => undefined); } catch { /* already closed */ }
      if (abortSignal?.aborted) return terminal({ recovered: false, reason: "recovery_aborted" });
      if (deadlineSignal.aborted) return terminal({ recovered: false, reason: "recovery_timeout" });
      return {
        resolution: { recovered: false, reason: "recovery_http_rejected" },
        retryable: isTransientUpstreamStatus(response.status),
        retryHeaders: response.headers,
      };
    }
    const body = await readBoundedResponseBody(response, {
      signal,
      fatalUtf8: true,
      maxBytes: MAX_RECOVERY_RESPONSE_BYTES,
      totalTimeoutMs: options.timeoutMs ?? 45_000,
      inactivityTimeoutMs: options.timeoutMs ?? 45_000,
      firstByteTimeoutMs: options.timeoutMs ?? 45_000,
    });
    if (abortSignal?.aborted) return terminal({ recovered: false, reason: "recovery_aborted" });
    if (deadlineSignal.aborted || body.timedOut) return terminal({ recovered: false, reason: "recovery_timeout" });
    if (body.truncated || body.oversized || !body.displaySafe) return terminal({ recovered: false, reason: "recovery_invalid_output" });
    const assignment = assignmentFromRecoverySse(body.text, envelope);
    return terminal(assignment === null
      ? { recovered: false, reason: "recovery_invalid_output" }
      : { recovered: true, assignment });
  } catch (error) {
    if (abortSignal?.aborted) return terminal({ recovered: false, reason: "recovery_aborted" });
    const decodeFailure = boundedBodyDecodeFailure(error);
    if (deadlineSignal.aborted || decodeFailure === "timeout") return terminal({ recovered: false, reason: "recovery_timeout" });
    return decodeFailure === "invalid_utf8"
      ? terminal({ recovered: false, reason: "recovery_invalid_output" })
      : { resolution: { recovered: false, reason: "recovery_transport_error" }, retryable: true };
  }
}

async function requestRecovery(
  admission: RecoveryAdmission,
  envelope: AgentEnvelope,
  options: AgentTaskRecoveryOptions,
  abortSignal?: AbortSignal,
): Promise<AgentTaskRecoveryResolution> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Agent task recovery timed out", "TimeoutError")),
    timeoutMs,
  );
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, controller.signal])
    : controller.signal;
  try {
    // The configured bound is re-clamped here: callers may pass options that never went
    // through agentTaskRecoveryConfig, and a larger value must not widen the outage window.
    const retries = Number.isFinite(options.retries)
      ? Math.max(0, Math.min(MAX_RECOVERY_RETRIES, Math.floor(options.retries!)))
      : 0;
    for (let attempt = 0; ; attempt += 1) {
      const { resolution, retryable, retryHeaders } = await attemptRecovery(
        admission, envelope, options, signal, abortSignal, controller.signal,
      );
      if (resolution.recovered || !retryable || attempt >= retries) return resolution;
      // Retry-After is the provider's floor, not something our backoff cap may shorten.
      // If honouring it would outlive the shared deadline, end with this failure rather
      // than resend early into a refusal.
      const delayMs = retryBackoffDelayMs(attempt, {
        baseDelayMs: RECOVERY_RETRY_BASE_DELAY_MS,
        maxDelayMs: RECOVERY_RETRY_MAX_DELAY_MS,
        headers: retryHeaders,
        retryAfterIsLowerBound: true,
      });
      if (delayMs >= deadline - Date.now()) return resolution;
      try {
        await sleepWithAbort(delayMs, signal);
      } catch {
        return abortSignal?.aborted
          ? { recovered: false, reason: "recovery_aborted" }
          : { recovered: false, reason: "recovery_timeout" };
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function recoverEncryptedAgentTask(
  req: Request,
  input: unknown,
  options: AgentTaskRecoveryOptions,
  config: OcxConfig,
  context: { parentThreadId?: string | null; abortSignal?: AbortSignal } = {},
): Promise<boolean> {
  return (await recoverEncryptedAgentTaskWithResult(req, input, options, config, context)).recovered;
}

/** Returns only bounded, caller-local diagnostics; no native error or payload content. */
export async function recoverEncryptedAgentTaskWithResult(
  req: Request,
  input: unknown,
  options: AgentTaskRecoveryOptions,
  config: OcxConfig,
  context: { parentThreadId?: string | null; abortSignal?: AbortSignal } = {},
): Promise<AgentTaskRecoveryResult> {
  // Admission is deliberately checked before cache access. A cache hit must not
  // turn this process into a plaintext oracle for an unauthenticated caller.
  const admitted = admittedRecovery(req, input, config, context.parentThreadId);
  if (!admitted.admitted) return { recovered: false, reason: admitted.reason };
  const { admission, cacheKey, envelope } = admitted.recovery;
  const result = await resolveCachedAgentTaskRecoveryWithResult(
    cacheKey,
    options.cacheEntries ?? 200,
    signal => requestRecovery(admission, envelope, options, signal),
    context.abortSignal,
  );
  if (!result.recovered) {
    return {
      recovered: false,
      reason: context.abortSignal?.aborted ? "caller_cancelled" : result.reason,
    };
  }
  if (context.abortSignal?.aborted) {
    discardCachedAgentTaskRecovery(cacheKey);
    return { recovered: false, reason: "caller_cancelled" };
  }
  if (!injectAssignment(input, envelope, result.assignment)) {
    discardCachedAgentTaskRecovery(cacheKey);
    return { recovered: false, reason: "input_changed" };
  }
  return { recovered: true };
}

export function discardEncryptedAgentTaskRecovery(
  req: Request,
  input: unknown,
  config: OcxConfig,
  context: { parentThreadId?: string | null } = {},
): void {
  const admitted = admittedRecovery(req, input, config, context.parentThreadId);
  if (admitted.admitted) discardCachedAgentTaskRecovery(admitted.recovery.cacheKey);
}

export function resetAgentTaskRecoveryState(): void {
  resetAgentTaskRecoveryCache();
}

/** Codex replays the original encrypted agent messages after tool calls. Reuse only an admitted cache hit. */
export function restoreCachedEncryptedAgentTasks(
  req: Request, input: unknown, config: OcxConfig,
  context: { parentThreadId?: string | null } = {},
): number {
  if (!Array.isArray(input)) return 0;
  let restored = 0;
  for (const item of input) {
    if (!item || typeof item !== "object" || item.type !== "agent_message") continue;
    const single = [item];
    // Revalidates caller credentials and the exact supported agent envelope before cache access.
    const admitted = admittedRecovery(req, single, config, context.parentThreadId);
    if (!admitted.admitted) continue;
    const assignment = cachedAgentTaskRecovery(admitted.recovery.cacheKey);
    if (assignment && injectAssignment(single, admitted.recovery.envelope, assignment)) restored += 1;
  }
  return restored;
}
