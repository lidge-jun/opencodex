import { createHash, createHmac, randomBytes } from "node:crypto";
import { decodeJwtPayload, extractAccountId } from "../../oauth/chatgpt";
import type { OcxConfig } from "../../types";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { isApiAuthRequired, isProxyAdmissionSecret } from "../auth-cors";
import { structurallyValidFernetTokens } from "./encrypted-payload";
import {
  discardCachedAgentTaskRecovery,
  resetAgentTaskRecoveryCache,
  resolveCachedAgentTaskRecovery,
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
const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024;
const MAX_ASSIGNMENT_BYTES = 2 * 1024 * 1024;
const MAX_RECOVERY_RESPONSE_BYTES = 4 * 1024 * 1024;
const CACHE_SCOPE_KEY = randomBytes(32);

export interface AgentTaskRecoveryOptions {
  enabled?: boolean;
  model?: string;
  timeoutMs?: number;
  cacheEntries?: number;
}

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
  };
}

interface AgentEnvelope {
  itemIndex: number;
  encryptedIndex: number;
  headerText: string;
  messageType: "NEW_TASK";
  taskName: string;
  sender: string;
  ciphertext: string;
  author: string;
  recipient: string;
}

const ROUTING_HEADER = /(?:^|\n)Message Type\s*:\s*(NEW_TASK)\s*\nTask name\s*:\s*(\S+)\s*\nSender\s*:\s*(\S+)\s*\nPayload\s*:\s*(?:\n|$)/;

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
  let messageType: "NEW_TASK" | null = null;
  let taskName: string | null = null;
  let sender: string | null = null;
  let encryptedIndex = -1;
  let ciphertext = "";
  let encryptedPartCount = 0;
  let ciphertextCount = 0;

  for (let index = 0; index < content.length; index += 1) {
    const part = content[index] as { type?: unknown; text?: unknown; encrypted_content?: unknown } | null;
    if (!part) continue;
    if (
      (part.type === "input_text" || part.type === "text")
      && typeof part.text === "string"
    ) {
      const match = ROUTING_HEADER.exec(part.text);
      if (match) {
        if (headerText !== null) return null;
        if (
          part.text.slice(0, match.index).trim().length > 0
          || part.text.slice(match.index + match[0].length).trim().length > 0
        ) return null;
        headerText = match[0].startsWith("\n") ? match[0].slice(1) : match[0];
        messageType = "NEW_TASK";
        taskName = match[2]!;
        sender = match[3]!;
      }
    }
    if (part.type !== "encrypted_content" || typeof part.encrypted_content !== "string") continue;
    encryptedPartCount += 1;
    for (const token of structurallyValidFernetTokens(part.encrypted_content)) {
      ciphertextCount += 1;
      encryptedIndex = index;
      ciphertext = token;
    }
  }

  if (
    !headerText
    || !messageType
    || !taskName
    || !sender
    || encryptedIndex < 0
    || encryptedPartCount !== 1
    || ciphertextCount !== 1
    || (content[encryptedIndex] as { encrypted_content?: unknown }).encrypted_content !== ciphertext
    || Buffer.byteLength(ciphertext) > MAX_CIPHERTEXT_BYTES
  ) return null;

  const itemRecord = item as { author?: unknown; recipient?: unknown };
  if (typeof itemRecord.author !== "string" || typeof itemRecord.recipient !== "string") return null;
  if (itemRecord.author !== sender || itemRecord.recipient !== taskName) return null;

  return {
    itemIndex,
    encryptedIndex,
    headerText,
    messageType,
    taskName,
    sender,
    ciphertext,
    author: itemRecord.author,
    recipient: itemRecord.recipient,
  };
}

function stripMatchingEnvelope(assignment: string, envelope: AgentEnvelope): string | null {
  const match = ROUTING_HEADER.exec(assignment);
  if (!match) return assignment;
  if (match.index !== 0) return null;
  if (
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
  const part = content[envelope.encryptedIndex] as { type?: unknown; encrypted_content?: unknown } | undefined;
  if (
    !part
    || part.type !== "encrypted_content"
    || part.encrypted_content !== envelope.ciphertext
  ) return false;

  content[envelope.encryptedIndex] = { type: "input_text", text: assignment };
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

function admittedRecovery(
  req: Request,
  input: unknown,
  config: OcxConfig,
  parentThreadId?: string | null,
): AdmittedRecovery | null {
  const envelope = findEnvelope(input);
  if (!envelope) return null;
  const admission = recoveryAdmission(req, config);
  if (!admission) return null;
  const cacheKey = createHash("sha256")
    .update(admission.cacheScope)
    .update("\0")
    .update(parentThreadId ?? "")
    .update("\0")
    .update(envelope.messageType)
    .update("\0")
    .update(envelope.taskName)
    .update("\0")
    .update(envelope.sender)
    .update("\0")
    .update(envelope.ciphertext)
    .digest("hex");
  return { envelope, admission, cacheKey };
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
        { type: "encrypted_content", encrypted_content: envelope.ciphertext },
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

async function requestRecovery(
  admission: RecoveryAdmission,
  envelope: AgentEnvelope,
  options: AgentTaskRecoveryOptions,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Agent task recovery timed out", "TimeoutError")),
    options.timeoutMs ?? 45_000,
  );
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, controller.signal])
    : controller.signal;
  try {
    const response = await fetch(RECOVERY_ENDPOINT, {
      method: "POST",
      headers: admission.headers,
      body: recoveryPayload(envelope, options.model ?? "gpt-5.6-sol"),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* already closed */ }
      return null;
    }
    const body = await readBoundedResponseBody(response, {
      signal,
      fatalUtf8: true,
      maxBytes: MAX_RECOVERY_RESPONSE_BYTES,
      totalTimeoutMs: options.timeoutMs ?? 45_000,
      inactivityTimeoutMs: options.timeoutMs ?? 45_000,
      firstByteTimeoutMs: options.timeoutMs ?? 45_000,
    });
    if (body.truncated || body.oversized || body.timedOut || !body.displaySafe) return null;
    return assignmentFromRecoverySse(body.text, envelope);
  } catch {
    return null;
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
  // Admission is deliberately checked before cache access. A cache hit must not
  // turn this process into a plaintext oracle for an unauthenticated caller.
  const admitted = admittedRecovery(req, input, config, context.parentThreadId);
  if (!admitted) return false;
  const { admission, cacheKey, envelope } = admitted;
  const assignment = await resolveCachedAgentTaskRecovery(
    cacheKey,
    options.cacheEntries ?? 200,
    signal => requestRecovery(admission, envelope, options, signal),
    context.abortSignal,
  );
  if (!assignment) return false;
  if (context.abortSignal?.aborted || !injectAssignment(input, envelope, assignment)) {
    discardCachedAgentTaskRecovery(cacheKey);
    return false;
  }
  return true;
}

export function discardEncryptedAgentTaskRecovery(
  req: Request,
  input: unknown,
  config: OcxConfig,
  context: { parentThreadId?: string | null } = {},
): void {
  const admitted = admittedRecovery(req, input, config, context.parentThreadId);
  if (admitted) discardCachedAgentTaskRecovery(admitted.cacheKey);
}

export function resetAgentTaskRecoveryState(): void {
  resetAgentTaskRecoveryCache();
}
