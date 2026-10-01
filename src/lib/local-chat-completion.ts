/**
 * One non-streaming chat completion through this proxy's own /v1/chat/completions.
 *
 * The way opencodex makes a model call of its own: the request goes back through the router like
 * any client's, so every provider the user has configured is reachable and none needs its own
 * client here. The routed vision describer and the Codex role sizing both send through it.
 *
 * Destination: the unauthenticated loopback listener when one is enabled, otherwise the bind
 * address (#4236), resolved by localInferenceDestination rather than composing 127.0.0.1 by hand.
 * Admission: localAdmissionToken (env token, hardened service token file, first apiKeys entry),
 * sent as x-opencodex-api-key and never Authorization, because an admission secret in a
 * forwardable header is a forwarding hazard. Never the admin token.
 */
import type { OcxConfig } from "../types";
import { localAdmissionToken, localInferenceDestination } from "./local-destinations";
import { signalWithTimeout, cancelBodyOnAbort } from "./abort";
import { readBoundedResponseBytes } from "./bounded-body";
import { redactSecretString } from "./redact";
import { sidecarEnter } from "./sidecar-tracker";
import { configuredPort } from "../server/auth-cors";

export type LocalChatConfig = Pick<OcxConfig, "port" | "hostname" | "apiKeys" | "unauthenticatedLoopbackListener">;

export interface LocalChatCompletionRequest {
  readonly config: LocalChatConfig;
  readonly body: Record<string, unknown>;
  /** Names the caller in error text and logs, e.g. "routed describe". */
  readonly label: string;
  /** Log prefix and sidecar breadcrumb, e.g. "vision". */
  readonly logTag: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /**
   * Count raw bytes while reading and cancel the body at the bound. Unset keeps the routed
   * describer's bound: the whole body is read, then its UTF-16 length is compared.
   */
  readonly boundWhileStreaming?: boolean;
  readonly headers?: Record<string, string>;
  readonly abortSignal?: AbortSignal;
  /** Test seam; production always self-fetches the resolved local destination. */
  readonly baseUrlOverride?: string;
}

export type LocalChatCompletionOutcome = { text: string; error?: string };

function destination(config: Pick<OcxConfig, "port" | "hostname" | "unauthenticatedLoopbackListener">) {
  // config.port can be 0 (ephemeral bind, tests) or stale after a live port override; the
  // server records its ACTUAL bound port via setCorsOrigin at startup, so prefer that when
  // config carries no positive port. configuredPort() is itself 0 when _corsOrigin has no
  // explicit port (a default-port origin), so the literal default has to backstop it or the
  // composed URL names port 0 and the self-fetch cannot connect.
  const port = config.port && config.port > 0
    ? config.port
    : Number(configuredPort()) || 10_100;
  return localInferenceDestination(config, port);
}

export function localChatCompletionBaseUrl(
  config: Pick<OcxConfig, "port" | "hostname" | "unauthenticatedLoopbackListener">,
): string {
  return destination(config).origin;
}

export async function postLocalChatCompletion(request: LocalChatCompletionRequest): Promise<LocalChatCompletionOutcome> {
  const { config, label, logTag } = request;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...request.headers };
  const admission = localAdmissionToken(config);
  if (admission) headers["x-opencodex-api-key"] = admission;
  // A bind that demands admission with no resolvable credential would return 401 with a body
  // the caller reports as a failure; naming the cause once is the difference between "it is
  // broken" and a fixable configuration note.
  if (!admission && !request.baseUrlOverride && destination(config).requiresAdmissionToken) {
    console.warn(
      `[${logTag}] ${label} has no opencodex data-plane credential for `
      + `${localChatCompletionBaseUrl(config)} — the self-fetch will be refused.`,
    );
  }

  const linkedSignal = signalWithTimeout(request.timeoutMs, request.abortSignal);
  const sidecarExit = sidecarEnter(logTag);
  const t0 = Date.now();
  try {
    const res = await fetch(`${request.baseUrlOverride ?? localChatCompletionBaseUrl(config)}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request.body, stream: false }),
      signal: linkedSignal.signal,
      redirect: "manual",
    });
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    try {
      let raw: string;
      if (request.boundWhileStreaming) {
        const read = await readBoundedResponseBytes(res, { maxBytes: request.maxResponseBytes, signal: linkedSignal.signal });
        if (read.oversized) return { text: "", error: `${label} response exceeded byte bound` };
        raw = new TextDecoder().decode(read.bytes);
      } else {
        raw = await res.text();
        if (raw.length > request.maxResponseBytes) {
          return { text: "", error: `${label} response exceeded byte bound` };
        }
      }
      if (!res.ok) {
        return { text: "", error: `${label} HTTP ${res.status}: ${redactSecretString(raw.slice(0, 200))}` };
      }
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch {
        return { text: "", error: `${label} returned non-JSON` };
      }
      const content = extractChatContent(payload);
      if (!content) return { text: "", error: `${label} returned no text` };
      return { text: content };
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[${logTag}] ${label} ${kind} (${Date.now() - t0}ms)`);
    return { text: "", error: redactSecretString(e instanceof Error ? e.message : String(e)) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}

function extractChatContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: unknown })?.message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content.trim().length > 0) return content;
  // Some adapters emit content parts; join text parts.
  if (Array.isArray(content)) {
    const joined = content
      .map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .join("");
    if (joined.trim().length > 0) return joined;
  }
  return undefined;
}
