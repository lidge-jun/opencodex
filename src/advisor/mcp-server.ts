/**
 * Explicit stdio MCP server exposing OpenCodex's configured Advisor model as `consult_advisor`.
 *
 * Designed for harnesses whose built-in models talk outside OpenCodex's proxy (such as WorkBuddy
 * built-in DeepSeek/Kimi/Hy3). Importing this module starts no timer, socket, or proxy.
 *
 * Each tool invocation uses a bounded 45s wait (`waitMs: 45_000`) against `POST /api/advisor/consult`
 * so hosts enforcing a ~60s MCP tool timeout receive a clean `in_progress` + `consultationId`
 * response and can resume waiting immediately without aborting slow reasoning advisors.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RuntimeApiError, runtimeRequest, type RuntimeApiDeps } from "../cli/runtime-api";
import { formatAdvisorAdvice, formatAdvisorUnavailable } from "./context";

export const MCP_CONSULT_WAIT_MS = 45_000;
const MIN_MCP_CONSULT_WAIT_MS = 5_000;
// Stay safely below Bun's HTTP listener idleTimeout (255s).
const MAX_MCP_CONSULT_WAIT_MS = 240_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 5_000;
const MCP_TRANSPORT_MARGIN_MS = 1_000;

export function resolveDefaultMcpWaitMs(rawEnv: string | undefined = process.env.OCX_ADVISOR_MCP_WAIT_MS): number {
  if (!rawEnv) return MCP_CONSULT_WAIT_MS;
  const parsed = Number(rawEnv.trim());
  if (!Number.isFinite(parsed)) return MCP_CONSULT_WAIT_MS;
  return Math.min(MAX_MCP_CONSULT_WAIT_MS, Math.max(MIN_MCP_CONSULT_WAIT_MS, Math.floor(parsed)));
}

export const consultAdvisorInput = {
  question: z.string().max(32_000).optional().describe("Focused engineering question for the advisor model. Required when starting a new consultation."),
  context: z.string().max(400_000).optional().describe("Optional task background, failing commands/errors, file snippets, or draft notes."),
  workerModel: z.string().max(200).optional().describe("Optional caller/worker model identifier (auto-detected from the local session transcript when available)."),
  taskId: z.string().max(256).optional().describe("Task or session identifier. Under adaptive policy, taskId or sessionId is required to enforce the per-task consultation limit."),
  sessionId: z.string().max(128).optional().describe("Client session UUID so OpenCodex can attach the raw local session transcript and scope adaptive task budgets."),
  consultationId: z.string().max(128).optional().describe("Resume/poll an in-progress consultation returned by a prior consult_advisor call."),
  afterElapsedMs: z.number().int().min(0).optional().describe("Elapsed milliseconds from the previous in_progress result when polling so repeated poll calls stay distinct."),
};

export const CONSULT_ADVISOR_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  openWorldHint: true,
} as const;

export interface AdvisorMcpOptions extends RuntimeApiDeps {
  waitMs?: number;
  progressIntervalMs?: number;
}

export interface ConsultAdvisorToolInput {
  question?: string;
  context?: string;
  workerModel?: string;
  taskId?: string;
  sessionId?: string;
  consultationId?: string;
  afterElapsedMs?: number;
}

export interface McpToolTextResult {
  [key: string]: unknown;
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const rec = body as { content?: unknown; error?: unknown };
  if (typeof rec.content === "string" && rec.content.trim().length > 0) return rec.content;
  if (rec.error && typeof rec.error === "object" && typeof (rec.error as { message?: unknown }).message === "string") {
    return (rec.error as { message: string }).message;
  }
  return fallback;
}

export async function callAdvisorConsultApi(
  input: ConsultAdvisorToolInput,
  options: AdvisorMcpOptions = {},
  signal?: AbortSignal,
): Promise<McpToolTextResult> {
  const consultationId = input.consultationId?.trim();
  const question = input.question?.trim();
  if (!consultationId && !question) {
    return {
      isError: true,
      content: [{ type: "text", text: formatAdvisorUnavailable("manual", "Provide either a non-empty question or a consultationId.") }],
    };
  }
  const effectiveWaitMs = options.waitMs ?? resolveDefaultMcpWaitMs();
  const payload: Record<string, unknown> = consultationId
    ? { consultationId, waitMs: effectiveWaitMs }
    : {
        question,
        ...(input.context?.trim() ? { context: input.context.trim() } : {}),
        ...(input.workerModel?.trim() ? { workerModel: input.workerModel.trim() } : {}),
        ...(input.taskId?.trim() ? { taskId: input.taskId.trim() } : {}),
        ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
        waitMs: effectiveWaitMs,
      };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.max(0, effectiveWaitMs) + MCP_TRANSPORT_MARGIN_MS);
  const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    const res = await runtimeRequest<Record<string, unknown>>(
      "/api/advisor/consult",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: requestSignal,
      },
      options,
    );
    if (res.status === "in_progress" && typeof res.consultationId === "string") {
      const elapsed = typeof res.elapsedMs === "number" ? res.elapsedMs : 0;
      const nextCallArguments = { consultationId: res.consultationId, afterElapsedMs: elapsed };
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "in_progress",
            consultationId: res.consultationId,
            advisorModel: res.advisorModel ?? null,
            elapsedMs: elapsed,
            afterElapsedMs: elapsed,
            nextCallArguments,
            instruction: `Advisor is still reasoning (${Math.round(elapsed / 1000)}s elapsed). Call consult_advisor again immediately with nextCallArguments (${JSON.stringify(nextCallArguments)}) to continue waiting without triggering duplicate-call guards.`,
          }),
        }],
      };
    }
    const text = typeof res.content === "string" && res.content.trim().length > 0
      ? res.content
      : formatAdvisorAdvice({
          advisorModel: typeof res.advisorModel === "string" ? res.advisorModel : "advisor",
          reason: "manual",
          advice: typeof res.advice === "string" ? res.advice : "",
          channel: "manual",
        });
    return { content: [{ type: "text", text }] };
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) {
      return { isError: true, content: [{ type: "text", text: formatAdvisorUnavailable("manual", consultationId
        ? "The local Advisor request timed out. Poll the same consultationId again."
        : "The local Advisor request timed out; the consultation may still be running.") }] };
    }
    if (error instanceof RuntimeApiError) {
      const detail = errorMessageFromBody(error.body, error.message);
      const formatted = error.body && typeof error.body === "object" && typeof (error.body as { content?: unknown }).content === "string"
        ? (error.body as { content: string }).content
        : formatAdvisorUnavailable("manual", detail);
      return { isError: true, content: [{ type: "text", text: formatted }] };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: formatAdvisorUnavailable("manual", msg) }] };
  } finally {
    clearTimeout(timer);
  }
}

/** Explicit stdio host only: importing this module starts no proxy, timer, or listener. */
export async function serveAdvisorMcp(options: AdvisorMcpOptions = {}): Promise<void> {
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let closed!: () => void;
  const done = new Promise<void>(resolve => { closed = resolve; });
  const stop = (): void => {
    controller.abort();
    closed();
  };

  const server = new McpServer(
    { name: "opencodex-advisor", version: "1.0.0" },
    {
      instructions:
        "Consult the user's configured OpenCodex expert advisor model. Provide a focused question and relevant context (problem summary, observed errors, code/approaches tried). If a consultation returns status='in_progress' with consultationId and nextCallArguments, immediately call consult_advisor again with nextCallArguments ({ consultationId, afterElapsedMs }) until completed so repeated poll calls stay distinct.",
    },
  );

  server.registerTool(
    "consult_advisor",
    {
      description:
        "Consult OpenCodex's configured stronger advisor model for architecture review, root-cause debugging, or stuck repair analysis. It cannot execute commands or edit files. If status='in_progress' is returned, immediately call consult_advisor with nextCallArguments ({ consultationId, afterElapsedMs }) to receive the finished advice.",
      inputSchema: consultAdvisorInput,
      annotations: CONSULT_ADVISOR_TOOL_ANNOTATIONS,
    },
    async (input, extra) => {
      if (controller.signal.aborted) {
        return { isError: true, content: [{ type: "text" as const, text: formatAdvisorUnavailable("manual", "Advisor MCP server is closing.") }] };
      }
      const progressToken = extra._meta?.progressToken;
      let progressTimer: ReturnType<typeof setInterval> | undefined;
      if (progressToken !== undefined) {
        let step = 0;
        progressTimer = setInterval(() => {
          step += 1;
          void extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: step,
              message: "Advisor is still reasoning...",
            },
          }).catch(() => {});
        }, options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
      }
      const signal = extra.signal ? AbortSignal.any([extra.signal, controller.signal]) : controller.signal;
      const task = callAdvisorConsultApi(input, options, signal);
      pending.add(task);
      try {
        return await task;
      } finally {
        if (progressTimer !== undefined) clearInterval(progressTimer);
        pending.delete(task);
      }
    },
  );

  server.server.onclose = stop;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  try {
    await server.connect(new StdioServerTransport());
    await done;
  } finally {
    stop();
    await Promise.allSettled([...pending]);
    await server.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.stdin.removeListener("end", stop);
    process.stdin.removeListener("close", stop);
  }
}
