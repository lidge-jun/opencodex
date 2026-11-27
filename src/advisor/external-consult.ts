/**
 * Asynchronous/pollable Advisor consultation entry point for external clients
 * (`POST /api/advisor/consult`, `ocx advisor consult`, and `ocx advisor mcp`).
 *
 * Non-OpenCodex harnesses (such as WorkBuddy built-in models) run their own API calls outside
 * the OpenCodex proxy and cannot participate in `/v1/responses` tool interception. Exposing a
 * bounded, consent-checked, long-pollable consultation store here lets external MCP tools wait
 * up to ~45s per round trip and resume via `consultationId` without hitting MCP 60s timeouts.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { OcxConfig, OcxMessage, OcxParsedRequest } from "../types";
import { advisorPlanRootConfig } from "../server/responses/advisor-plan-slot";
import { sanitizeLogMetadataString } from "../lib/redact";
import { isBunTestFileProcess } from "../lib/test-home-guard";
import { advisorActivityStore } from "./activity";
import { createAdvisorTaskBudget, type AdvisorTaskBudget } from "./budget";
import { consultAdvisor, type AdvisorConsultationResult } from "./consult";
import { formatAdvisorAdvice, formatAdvisorUnavailable, stripHarnessSystemReminders } from "./context";
import { resolveAdvisorSettings, type AdvisorContextMode, type AdvisorSettings } from "./settings";

const MAX_QUESTION_CHARS = 32_000;
const MAX_CONTEXT_CHARS = 400_000;
const DEFAULT_CONTEXT_CHUNK_CHARS = 3_800;
const FULL_CONTEXT_CHUNK_CHARS = 120_000;
const MAX_WORKER_MODEL_CHARS = 200;
const MAX_TASK_ID_CHARS = 256;
const MAX_CONSULTATION_ID_CHARS = 128;
const MAX_SESSION_ID_CHARS = 128;
const MAX_TRANSCRIPT_PATH_CHARS = 1_024;
const MAX_TRANSCRIPT_FILE_BYTES = 4 * 1024 * 1024;
// Stay safely below Bun's HTTP listener idleTimeout (255s in src/server/index/serve-options.ts).
const MAX_WAIT_MS = 240_000;
const DEFAULT_MAX_WAIT_MS = 240_000;
const DEFAULT_MIN_WAIT_MS = 10_000;
const MAX_STORE_ENTRIES = 32;
const COMPLETED_TTL_MS = 30 * 60_000;

export interface ExternalAdvisorConsultRequest {
  consultationId?: string;
  question?: string;
  context?: string;
  workerModel?: string;
  taskId?: string;
  sessionId?: string;
  transcriptPath?: string;
  waitMs?: number;
}

export interface ExternalAdvisorConsultResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface ExternalConsultDeps {
  consultFn?: typeof consultAdvisor;
  budget?: AdvisorTaskBudget;
  now?: () => number;
  baseUrlOverride?: string;
  workbuddyProjectsDir?: string;
}

interface ConsultationEntry {
  id: string;
  fingerprint: string;
  startedAt: number;
  finishedAt?: number;
  advisorModel: string;
  settled?: { status: number; body: Record<string, unknown> };
  promise: Promise<{ status: number; body: Record<string, unknown> }>;
}

const stores = new WeakMap<Pick<OcxConfig, "advisor">, Map<string, ConsultationEntry>>();

function consultationStore(config: Pick<OcxConfig, "advisor">): Map<string, ConsultationEntry> {
  const root = advisorPlanRootConfig(config);
  let store = stores.get(root);
  if (!store) {
    store = new Map();
    stores.set(root, store);
  }
  return store;
}

/** Remove only settled entries whose retention TTL has elapsed. Never evicts live or retained entries. */
function pruneExpiredEntries(store: Map<string, ConsultationEntry>, nowMs: number): void {
  for (const [id, entry] of store) {
    if (entry.finishedAt !== undefined && nowMs - entry.finishedAt >= COMPLETED_TTL_MS) {
      store.delete(id);
    }
  }
}

/**
 * Reserve space for ONE new consultation. Only entries past their retention TTL are removed: a running
 * consultation, and a completed one a client may still poll within COMPLETED_TTL_MS, keep their slot.
 * Returns false when every slot is still retained, so the caller reports the capacity limit.
 */
function ensureStoreCapacity(store: Map<string, ConsultationEntry>, nowMs: number): boolean {
  pruneExpiredEntries(store, nowMs);
  return store.size < MAX_STORE_ENTRIES;
}

function isRec(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorResponse(status: number, code: string, message: string, content?: string): ExternalAdvisorConsultResponse {
  return {
    status,
    body: {
      ok: false,
      error: { code, message },
      ...(content !== undefined ? { content } : {}),
    },
  };
}

function validateWaitMs(raw: unknown, fallbackMs: number): number | null {
  if (raw === undefined) return fallbackMs;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > MAX_WAIT_MS) return null;
  return Math.floor(raw);
}

function defaultWaitMs(settings: AdvisorSettings): number {
  return Math.min(Math.max(settings.timeoutMs, DEFAULT_MIN_WAIT_MS), DEFAULT_MAX_WAIT_MS);
}

function canonicalExistingPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function isWithinDirectory(candidatePath: string, rootDir: string): boolean {
  const realRoot = canonicalExistingPath(rootDir);
  const realCandidate = canonicalExistingPath(candidatePath);
  if (!realRoot || !realCandidate) return false;
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  return realCandidate === realRoot || realCandidate.startsWith(prefix);
}

function isSafeSessionFilenameId(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_SESSION_ID_CHARS
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("..")
    && !value.includes("\0");
}

function findTranscriptFile(options: {
  sessionId?: string;
  taskId?: string;
  transcriptPath?: string;
  workbuddyProjectsDir?: string;
  nowMs: number;
}): string | undefined {
  if (options.transcriptPath) {
    const candidate = resolve(options.transcriptPath);
    if (!candidate.endsWith(".jsonl")) return undefined;
    try {
      const stat = lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT_FILE_BYTES) return undefined;
    } catch {
      return undefined;
    }
    const allowedRoots = [
      ...(options.workbuddyProjectsDir ? [options.workbuddyProjectsDir] : []),
      join(homedir(), ".workbuddy", "projects"),
      join(homedir(), ".workbuddy-ai", "projects"),
      join(homedir(), ".qoder", "projects"),
      join(homedir(), ".qoder-cn", "projects"),
      join(homedir(), ".commandcode", "projects"),
      join(homedir(), ".codex", "sessions"),
      join(homedir(), ".claude", "projects"),
    ];
    return allowedRoots.some(root => isWithinDirectory(candidate, root)) ? candidate : undefined;
  }

  const lookupIds = [options.sessionId, options.taskId]
    .filter((v): v is string => typeof v === "string" && isSafeSessionFilenameId(v.trim()))
    .map(v => `${v.trim()}.jsonl`);
  // Never guess across unrelated client transcripts when no explicit sessionId/taskId is given.
  if (lookupIds.length === 0) return undefined;

  const runningTest = process.env.OCX_TEST_HOME_GUARD === "1" || isBunTestFileProcess();
  const searchRoots = options.workbuddyProjectsDir
    ? [options.workbuddyProjectsDir]
    : runningTest
      ? []
      : [
          join(homedir(), ".workbuddy", "projects"),
          join(homedir(), ".workbuddy-ai", "projects"),
          join(homedir(), ".qoder", "projects"),
          join(homedir(), ".qoder-cn", "projects"),
          join(homedir(), ".commandcode", "projects"),
          join(homedir(), ".claude", "projects"),
        ];
  if (searchRoots.length === 0) return undefined;

  let bestPath: string | undefined;
  let bestMtime = -Infinity;
  let bestTier = Infinity;
  const considerFile = (filePath: string) => {
    const tier = lookupIds.indexOf(basename(filePath));
    if (tier < 0 || tier > bestTier) return;
    try {
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT_FILE_BYTES) return;
      if (tier < bestTier || stat.mtimeMs > bestMtime) {
        bestTier = tier;
        bestMtime = stat.mtimeMs;
        bestPath = filePath;
      }
    } catch {
      /* ignore unreadable entries */
    }
  };

  for (const searchRoot of searchRoots) {
    try {
      for (const entry of readdirSync(searchRoot, { withFileTypes: true })) {
        const entryPath = join(searchRoot, entry.name);
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          considerFile(entryPath);
        } else if (entry.isDirectory()) {
          try {
            for (const nested of readdirSync(entryPath, { withFileTypes: true })) {
              if (nested.isFile() && nested.name.endsWith(".jsonl")) {
                considerFile(join(entryPath, nested.name));
              }
            }
          } catch {
            /* skip inaccessible subdir */
          }
        }
      }
    } catch {
      /* skip missing/unreadable client project dir */
    }
  }
  return bestPath;
}

function extractTextParts(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(part => {
        if (typeof part === "string") return part;
        if (isRec(part) && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  if (isRec(value)) {
    if (typeof value.text === "string") return value.text;
    if (value.output !== undefined) return extractTextParts(value.output);
    return JSON.stringify(value);
  }
  return "";
}

export function loadWorkBuddySessionMessages(options: {
  sessionId?: string;
  taskId?: string;
  transcriptPath?: string;
  workbuddyProjectsDir?: string;
  nowMs: number;
}): { messages: OcxMessage[]; detectedWorkerModel?: string } {
  const filePath = findTranscriptFile(options);
  if (!filePath) return { messages: [] };
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { messages: [] };
  }
  const messages: OcxMessage[] = [];
  const skippedCallIds = new Set<string>();
  const toolNamesById = new Map<string, string>();
  let providerDetectedModel: string | undefined;
  let fallbackWorkerModel: string | undefined;

  const isMetaAdvisorLookupOrPoll = (name: string, serialized: string): boolean => {
    if (name.includes("consult_advisor") || name.includes("opencodex-advisor") || name.includes("opencodex_advisor")) return true;
    const isMeta = name === "ToolSearch" || name === "DeferExecuteTool"
      || name === "mcp_list" || name === "mcp_get" || name === "mcp_call";
    if (!isMeta) return false;
    return serialized.includes("consult_advisor")
      || serialized.includes("opencodex-advisor")
      || serialized.includes("opencodex_advisor")
      || serialized.includes('"consultationId"')
      || serialized.includes('"advisor_result"');
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRec(row)) continue;
    if (isRec(row.providerData)) {
      const candidate = typeof row.providerData.model === "string" && row.providerData.model.trim()
        ? row.providerData.model.trim()
        : typeof row.providerData.requestModelId === "string" && row.providerData.requestModelId.trim()
          ? row.providerData.requestModelId.trim().replace(/^custom-local:/, "")
          : undefined;
      if (candidate) providerDetectedModel = candidate;
    }
    if (row.type === "runtime-config" && typeof row.model === "string" && row.model.trim() && row.model.trim() !== "auto") {
      fallbackWorkerModel = row.model.trim();
    } else if (
      row.type === "attachment"
      && isRec(row.attachment)
      && row.attachment.type === "model"
      && isRec(row.attachment.identity)
      && typeof row.attachment.identity.modelId === "string"
      && row.attachment.identity.modelId.trim()
      && row.attachment.identity.modelId.trim() !== "auto"
    ) {
      fallbackWorkerModel = row.attachment.identity.modelId.trim();
    } else if (typeof row.model === "string" && row.model.trim() && row.model.trim() !== "auto") {
      fallbackWorkerModel = row.model.trim();
    } else if (typeof row.businessModelKey === "string" && row.businessModelKey.trim() && row.businessModelKey.trim() !== "auto") {
      fallbackWorkerModel = fallbackWorkerModel ?? row.businessModelKey.trim();
    }
    const timestamp = typeof row.timestamp === "number" && Number.isFinite(row.timestamp)
      ? row.timestamp
      : typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp))
        ? Date.parse(row.timestamp)
        : options.nowMs;

    if (row.type === "message" && !isRec(row.message)) {
      if (row.role === "user") {
        const cleaned = stripHarnessSystemReminders(extractTextParts(row.content));
        if (cleaned) messages.push({ role: "user", content: cleaned, timestamp });
      } else if (row.role === "assistant") {
        const text = extractTextParts(row.content).trim();
        if (text) {
          messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp });
        }
      }
      continue;
    }

    if ((row.type === "user" || row.type === "assistant" || row.type === "message") && isRec(row.message)) {
      const msg = row.message;
      if (typeof msg.model === "string" && msg.model.trim() && msg.model.trim() !== "auto") {
        fallbackWorkerModel = msg.model.trim();
      }
      const msgRole = msg.role === "user" || msg.role === "assistant"
        ? msg.role
        : row.type === "user" || row.type === "assistant"
          ? row.type
          : undefined;
      if (!msgRole) continue;
      if (typeof msg.content === "string") {
        const cleaned = msgRole === "user" ? stripHarnessSystemReminders(msg.content) : msg.content.trim();
        if (cleaned) {
          messages.push(
            msgRole === "user"
              ? { role: "user", content: cleaned, timestamp }
              : { role: "assistant", content: [{ type: "text", text: cleaned }], timestamp },
          );
        }
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      if (msgRole === "user") {
        const textParts: string[] = [];
        for (const block of msg.content) {
          if (!isRec(block)) continue;
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block.type === "tool_result") {
            const callId = typeof block.tool_use_id === "string" && block.tool_use_id ? block.tool_use_id : `call_${messages.length}`;
            const outputText = extractTextParts(block.content).trim();
            if (skippedCallIds.has(callId)) continue;
            const toolName = toolNamesById.get(callId) ?? "tool";
            if (isMetaAdvisorLookupOrPoll(toolName, outputText)) continue;
            if (outputText) {
              messages.push({
                role: "toolResult",
                toolCallId: callId,
                toolName,
                content: outputText,
                isError: block.is_error === true,
                timestamp,
              });
            }
          }
        }
        const cleanedUser = stripHarnessSystemReminders(textParts.join("\n"));
        if (cleanedUser) messages.push({ role: "user", content: cleanedUser, timestamp });
      } else {
        for (const block of msg.content) {
          if (!isRec(block)) continue;
          // Never forward hidden chain-of-thought (`type: "thinking"`).
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            messages.push({ role: "assistant", content: [{ type: "text", text: block.text.trim() }], timestamp });
          } else if (block.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name : "tool";
            const callId = typeof block.id === "string" && block.id ? block.id : `call_${messages.length}`;
            toolNamesById.set(callId, name);
            const rawArgs = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {});
            if (isMetaAdvisorLookupOrPoll(name, `${name} ${rawArgs}`)) {
              skippedCallIds.add(callId);
              continue;
            }
            const parsedArgs = isRec(block.input) ? block.input : { value: block.input ?? {} };
            messages.push({
              role: "assistant",
              content: [{ type: "toolCall", id: callId, name, arguments: parsedArgs }],
              timestamp,
            });
          }
        }
      }
      continue;
    }

    if (row.type === "function_call") {
      const name = typeof row.name === "string" ? row.name : "tool";
      const callId = typeof row.callId === "string" && row.callId ? row.callId : `call_${messages.length}`;
      const rawArgs = typeof row.arguments === "string" ? row.arguments : JSON.stringify(row.arguments ?? {});
      if (isMetaAdvisorLookupOrPoll(name, rawArgs)) {
        skippedCallIds.add(callId);
        continue;
      }
      let parsedArgs: Record<string, unknown> = {};
      if (typeof row.arguments === "string") {
        try {
          const decoded = JSON.parse(row.arguments);
          parsedArgs = isRec(decoded) ? decoded : { value: decoded };
        } catch {
          parsedArgs = { raw: row.arguments };
        }
      } else if (isRec(row.arguments)) {
        parsedArgs = row.arguments;
      }
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name, arguments: parsedArgs }],
        timestamp,
      });
      continue;
    }

    if (row.type === "function_call_result") {
      const name = typeof row.name === "string" ? row.name : "tool";
      const callId = typeof row.callId === "string" && row.callId ? row.callId : `call_${messages.length}`;
      const outputText = extractTextParts(row.output).trim();
      if (skippedCallIds.has(callId)) continue;
      if (isMetaAdvisorLookupOrPoll(name, outputText)) {
        continue;
      }
      if (outputText) {
        messages.push({
          role: "toolResult",
          toolCallId: callId,
          toolName: name,
          content: outputText,
          isError: row.status !== undefined && row.status !== "completed",
          timestamp,
        });
      }
    }
  }
  const detectedWorkerModel = providerDetectedModel ?? fallbackWorkerModel;
  return { messages, ...(detectedWorkerModel ? { detectedWorkerModel } : {}) };
}

function buildExternalParsedRequest(
  question: string,
  contextText: string,
  workerModel: string,
  sessionMessages: OcxMessage[],
  contextMode: AdvisorContextMode,
): OcxParsedRequest {
  const timestamp = Date.now();
  const chunkChars = contextMode === "full" ? FULL_CONTEXT_CHUNK_CHARS : DEFAULT_CONTEXT_CHUNK_CHARS;
  const messages: OcxMessage[] = [...sessionMessages];
  if (contextText.length > 0) {
    const clipped = contextText.length > MAX_CONTEXT_CHARS
      ? `${contextText.slice(0, MAX_CONTEXT_CHARS)}\n… [external context truncated]`
      : contextText;
    const label = sessionMessages.length > 0 ? "[worker additional context / draft]" : "[external client context]";
    for (let offset = 0; offset < clipped.length; offset += chunkChars) {
      const chunk = clipped.slice(offset, offset + chunkChars);
      messages.push({ role: "user", content: `${label}\n${chunk}`, timestamp });
    }
  }
  messages.push({ role: "user", content: question, timestamp });
  return {
    modelId: workerModel,
    context: { messages },
    stream: true,
    options: {},
  };
}

function settleConsultationBody(
  consultationId: string,
  result: AdvisorConsultationResult,
): { status: number; body: Record<string, unknown> } {
  if (result.ok) {
    return {
      status: 200,
      body: {
        ok: true,
        status: "completed",
        consultationId,
        advisorModel: result.advisorModel,
        advice: result.advice,
        content: formatAdvisorAdvice({
          advisorModel: result.advisorModel,
          reason: "manual",
          advice: result.advice,
          channel: "manual",
        }),
        durationMs: result.durationMs,
        effectiveEffort: result.effectiveEffort ?? null,
        ...(result.usage ? { usage: result.usage } : {}),
      },
    };
  }
  const reason = result.error ?? "advisor consultation failed";
  return {
    status: 502,
    body: {
      ok: false,
      status: "failed",
      consultationId,
      advisorModel: result.advisorModel,
      durationMs: result.durationMs,
      error: { code: "advisor_failed", message: reason },
      content: formatAdvisorUnavailable("manual", reason),
    },
  };
}

async function waitForEntry(entry: ConsultationEntry, waitMs: number, nowMs: () => number): Promise<ExternalAdvisorConsultResponse> {
  if (entry.settled) return entry.settled;
  if (waitMs <= 0) {
    return {
      status: 202,
      body: {
        ok: true,
        status: "in_progress",
        consultationId: entry.id,
        advisorModel: entry.advisorModel,
        elapsedMs: Math.max(0, nowMs() - entry.startedAt),
      },
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("wait-timeout");
  const timeoutPromise = new Promise<typeof timedOut>(resolve => {
    timer = setTimeout(() => resolve(timedOut), waitMs);
  });
  try {
    const winner = await Promise.race([entry.promise, timeoutPromise]);
    if (winner === timedOut) {
      return {
        status: 202,
        body: {
          ok: true,
          status: "in_progress",
          consultationId: entry.id,
          advisorModel: entry.advisorModel,
          elapsedMs: Math.max(0, nowMs() - entry.startedAt),
        },
      };
    }
    return winner;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runExternalAdvisorConsult(
  config: OcxConfig,
  rawBody: unknown,
  deps: ExternalConsultDeps = {},
): Promise<ExternalAdvisorConsultResponse> {
  if (!isRec(rawBody)) {
    return errorResponse(400, "invalid_body", "body must be a JSON object");
  }
  const now = deps.now ?? (() => Date.now());
  const settings = resolveAdvisorSettings(config);
  const store = consultationStore(config);

  if (rawBody.consultationId !== undefined) {
    if (typeof rawBody.consultationId !== "string" || rawBody.consultationId.trim() === "" || rawBody.consultationId.trim().length > MAX_CONSULTATION_ID_CHARS) {
      return errorResponse(400, "invalid_consultation_id", "consultationId must be a non-empty string");
    }
    const waitMs = validateWaitMs(rawBody.waitMs, defaultWaitMs(settings));
    if (waitMs === null) {
      return errorResponse(400, "invalid_wait_ms", `waitMs must be a number between 0 and ${MAX_WAIT_MS}`);
    }
    pruneExpiredEntries(store, now());
    const entry = store.get(rawBody.consultationId.trim());
    if (!entry) {
      return errorResponse(404, "consultation_not_found", "Consultation not found or expired.");
    }
    return waitForEntry(entry, waitMs, now);
  }

  if (typeof rawBody.question !== "string" || rawBody.question.trim() === "") {
    return errorResponse(400, "invalid_question", "question must be a non-empty string");
  }
  if (rawBody.context !== undefined && typeof rawBody.context !== "string") {
    return errorResponse(400, "invalid_context", "context must be a string when provided");
  }
  if (rawBody.workerModel !== undefined && (typeof rawBody.workerModel !== "string" || rawBody.workerModel.trim().length > MAX_WORKER_MODEL_CHARS)) {
    return errorResponse(400, "invalid_worker_model", "workerModel must be a string of at most 200 characters");
  }
  if (rawBody.taskId !== undefined && (typeof rawBody.taskId !== "string" || rawBody.taskId.trim().length > MAX_TASK_ID_CHARS)) {
    return errorResponse(400, "invalid_task_id", "taskId must be a string of at most 256 characters");
  }
  if (rawBody.sessionId !== undefined && (typeof rawBody.sessionId !== "string" || rawBody.sessionId.trim().length > MAX_SESSION_ID_CHARS)) {
    return errorResponse(400, "invalid_session_id", "sessionId must be a string of at most 128 characters");
  }
  if (rawBody.transcriptPath !== undefined && (typeof rawBody.transcriptPath !== "string" || rawBody.transcriptPath.trim().length > MAX_TRANSCRIPT_PATH_CHARS)) {
    return errorResponse(400, "invalid_transcript_path", "transcriptPath must be a string of at most 1024 characters");
  }
  const waitMs = validateWaitMs(rawBody.waitMs, defaultWaitMs(settings));
  if (waitMs === null) {
    return errorResponse(400, "invalid_wait_ms", `waitMs must be a number between 0 and ${MAX_WAIT_MS}`);
  }

  if (!settings.enabled || settings.model.trim() === "") {
    return errorResponse(
      409,
      "advisor_disabled",
      "Advisor is disabled or has no model configured.",
      formatAdvisorUnavailable("manual", "advisor is not configured"),
    );
  }

  const rawQuestion = rawBody.question.trim();
  const question = rawQuestion.length > MAX_QUESTION_CHARS ? rawQuestion.slice(0, MAX_QUESTION_CHARS) : rawQuestion;
  const contextText = typeof rawBody.context === "string" ? rawBody.context.trim() : "";
  const sessionId = typeof rawBody.sessionId === "string" && rawBody.sessionId.trim() ? rawBody.sessionId.trim() : undefined;
  const transcriptPath = typeof rawBody.transcriptPath === "string" && rawBody.transcriptPath.trim() ? rawBody.transcriptPath.trim() : undefined;
  const taskId = typeof rawBody.taskId === "string" ? rawBody.taskId.trim() : "";
  const loadedSession = settings.contextMode === "full"
    ? loadWorkBuddySessionMessages({
        sessionId,
        taskId: taskId || undefined,
        transcriptPath,
        workbuddyProjectsDir: deps.workbuddyProjectsDir,
        nowMs: now(),
      })
    : { messages: [] };

  // Enforce the same operator consent boundary as routed consultations (including question-only).
  if (settings.contextSharingConsent === null) {
    return errorResponse(
      409,
      "advisor_consent_required",
      "Advisor context-sharing consent (v1) is required. Run `ocx advisor consent`.",
      formatAdvisorUnavailable("consent", "advisor_context_sharing_consent_required"),
    );
  }

  const explicitWorkerModel = typeof rawBody.workerModel === "string" ? rawBody.workerModel.trim() : "";
  const rawWorkerModel = loadedSession.detectedWorkerModel
    ?? (explicitWorkerModel || "external-client");
  const workerModel = sanitizeLogMetadataString(rawWorkerModel, MAX_WORKER_MODEL_CHARS) ?? "external-client";
  const safeAdvisorModel = sanitizeLogMetadataString(settings.model, 200) ?? "unknown";

  const transcriptDigest = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(loadedSession.messages.map(m => ({
      role: m.role,
      content: m.content,
      ...("toolName" in m ? { toolName: m.toolName } : {}),
      ...("toolCallId" in m ? { toolCallId: m.toolCallId } : {}),
      ...("isError" in m ? { isError: m.isError } : {}),
    }))))
    .digest("hex");

  const fingerprint = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([
      settings.model,
      settings.effort,
      settings.contextMode,
      workerModel,
      question,
      contextText,
      taskId,
      sessionId ?? "",
      transcriptPath ?? "",
      transcriptDigest,
    ]))
    .digest("hex");

  pruneExpiredEntries(store, now());
  for (const existing of store.values()) {
    if (!existing.settled && existing.fingerprint === fingerprint) {
      return waitForEntry(existing, waitMs, now);
    }
  }

  if (!ensureStoreCapacity(store, now())) {
    const expiries = [...store.values()].flatMap(entry => entry.finishedAt === undefined ? [] : [entry.finishedAt + COMPLETED_TTL_MS]);
    const expiryHint = expiries.length > 0 ? ` The earliest expiry is in ${Math.max(0, Math.ceil((Math.min(...expiries) - now()) / 1000))} seconds.` : " No expiry is known yet.";
    const capacityMessage = `Maximum retained consultations (${MAX_STORE_ENTRIES}) reached.${expiryHint}`;
    return errorResponse(
      429,
      "advisor_capacity_exceeded",
      capacityMessage,
      formatAdvisorUnavailable("limit", capacityMessage),
    );
  }

  const explicitBudgetId = taskId || sessionId;
  let budgetIdentity: string | undefined;
  if (explicitBudgetId) {
    budgetIdentity = `external:${explicitBudgetId}`;
  } else if (transcriptPath) {
    const resolvedTranscript = findTranscriptFile({
      transcriptPath,
      workbuddyProjectsDir: deps.workbuddyProjectsDir,
      nowMs: now(),
    });
    const canonicalTranscript = resolvedTranscript ? canonicalExistingPath(resolvedTranscript) : undefined;
    if (canonicalTranscript) budgetIdentity = `external:transcript:${canonicalTranscript}`;
  }

  const activities = advisorActivityStore(advisorPlanRootConfig(config));
  const startedAt = now();
  if (settings.policy === "adaptive") {
    if (!budgetIdentity) {
      const blockId = activities.start({
        trigger: "manual",
        workerModel,
        advisorModel: safeAdvisorModel,
        requestedEffort: settings.effort,
      }, startedAt);
      activities.finish(blockId, { status: "blocked", durationMs: 0, blockReason: "budget" });
      return errorResponse(
        400,
        "advisor_budget_identity_required",
        "Adaptive advisor policy requires a stable taskId, sessionId, or validated transcriptPath to enforce the per-task consultation limit.",
        formatAdvisorUnavailable("budget", "adaptive policy requires a stable taskId or sessionId; no consultation sent"),
      );
    }
    const budget = deps.budget ?? createAdvisorTaskBudget();
    const reservation = budget.reserve(budgetIdentity, settings.maxConsultationsPerTask, startedAt);
    if (!reservation.ok) {
      const blockId = activities.start({
        trigger: "manual",
        workerModel,
        advisorModel: safeAdvisorModel,
        requestedEffort: settings.effort,
      }, startedAt);
      activities.finish(blockId, { status: "blocked", durationMs: 0, blockReason: "budget" });
      return errorResponse(
        429,
        "advisor_budget_exhausted",
        "Advisor task budget exhausted or unavailable.",
        formatAdvisorUnavailable("budget", "task budget exhausted or unavailable; no consultation sent"),
      );
    }
  }

  const consultationId = crypto.randomUUID();
  const activityId = activities.start({
    trigger: "manual",
    workerModel,
    advisorModel: safeAdvisorModel,
    requestedEffort: settings.effort,
  }, startedAt);

  const parsed = buildExternalParsedRequest(
    question,
    contextText,
    workerModel,
    loadedSession.messages,
    settings.contextMode,
  );
  const consultImpl = deps.consultFn ?? consultAdvisor;

  const entry: ConsultationEntry = {
    id: consultationId,
    fingerprint,
    startedAt,
    advisorModel: settings.model,
    promise: Promise.resolve({ status: 500, body: {} }),
  };

  entry.promise = (async () => {
    try {
      const result = await consultImpl(
        {
          parsed,
          workerIdentity: `${workerModel} (external MCP/API client)`,
          advisorModel: settings.model,
          reason: "manual",
          contextMode: settings.contextMode,
          question,
        },
        config,
        settings.effort,
        settings.timeoutMs,
        undefined,
        deps.baseUrlOverride,
      );
      activities.finish(activityId, {
        status: result.ok ? "ok" : result.cancelled ? "cancelled" : "failed",
        durationMs: result.durationMs,
        effectiveEffort: result.effectiveEffort ?? null,
        ...(result.usage ? { usage: result.usage } : {}),
      });
      const usagePart = result.usage
        ? ` in=${result.usage.inputTokens ?? "?"} out=${result.usage.outputTokens ?? "?"} total=${result.usage.totalTokens ?? "?"}`
        : "";
      if (result.ok) {
        console.info(`[advisor] consultation trigger=external worker=${workerModel} advisor=${safeAdvisorModel} status=ok durationMs=${result.durationMs}${usagePart}`);
      } else {
        const safeErr = sanitizeLogMetadataString(result.error, 120) ?? "unknown";
        console.warn(`[advisor] consultation trigger=external worker=${workerModel} advisor=${safeAdvisorModel} status=failed durationMs=${result.durationMs} error=${safeErr}`);
      }
      const settled = settleConsultationBody(consultationId, result);
      entry.settled = settled;
      entry.finishedAt = now();
      return settled;
    } catch {
      const durationMs = Math.max(0, now() - startedAt);
      activities.finish(activityId, { status: "failed", durationMs });
      console.warn(`[advisor] consultation trigger=external worker=${workerModel} advisor=${safeAdvisorModel} status=failed durationMs=${durationMs} error=exception`);
      const settled = settleConsultationBody(consultationId, {
        ok: false,
        advice: "",
        advisorModel: settings.model,
        error: "advisor consultation exception",
        durationMs,
      });
      entry.settled = settled;
      entry.finishedAt = now();
      return settled;
    }
  })();

  store.set(consultationId, entry);
  return waitForEntry(entry, waitMs, now);
}
