/**
 * First-output failover for streaming Chat Completions.
 *
 * Some upstreams accept a request and send response headers plus the SSE preamble promptly, then stay
 * silent for tens of seconds before the first token (observed on xai/grok-composer-2.5-fast: first
 * output p90 21.6 s over 471 calls, versus 4.0 s for cursor/composer-2.5-fast). connectTimeoutMs and
 * the stall watchdog cannot catch this because headers and keep-alive frames arrive on time.
 *
 * `firstOutputFailover` maps a requested model to a fallback model and a deadline. For a streaming
 * request to a mapped model, the first attempt runs until the first real delta (content, reasoning,
 * tool call or finish). If the deadline passes first, that attempt is aborted and the same body is
 * re-sent once to the fallback model. Output that already reached the proxy is passed through, so a
 * turn is never replayed after the client could have seen tokens. Errors are returned unchanged.
 */
export interface FirstOutputFailoverRule {
  to: string;
  afterMs: number;
}

export function resolveFirstOutputFailover(
  rules: Record<string, FirstOutputFailoverRule> | undefined,
  model: string,
): FirstOutputFailoverRule | undefined {
  const rule = rules?.[model];
  if (!rule || typeof rule.to !== "string" || rule.to.trim() === "" || rule.to === model) return undefined;
  return Number.isFinite(rule.afterMs) && rule.afterMs > 0 ? rule : undefined;
}

export function hasFirstOutput(sseText: string): boolean {
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload) as { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: unknown }> };
      for (const ch of j.choices ?? []) {
        const d = ch.delta ?? {};
        if (typeof d.content === "string" && d.content.length > 0) return true;
        if (typeof d.reasoning_content === "string" && d.reasoning_content.length > 0) return true;
        if (typeof d.reasoning === "string" && d.reasoning.length > 0) return true;
        if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) return true;
        if (ch.finish_reason) return true;
      }
    } catch {
      // Partial JSON line: keep waiting for the rest of the frame.
    }
  }
  return false;
}

type Handler = (req: Request) => Promise<Response>;

function cloneRequest(req: Request, body: string, signal: AbortSignal): Request {
  return new Request(req.url, { method: req.method, headers: req.headers, body, signal });
}

export async function withFirstOutputFailover(
  req: Request,
  rules: Record<string, FirstOutputFailoverRule> | undefined,
  handle: Handler,
  onFailover?: (from: string, to: string, waitedMs: number) => void,
): Promise<Response> {
  if (!rules || Object.keys(rules).length === 0) return handle(req);
  const bodyText = await req.text();
  let parsed: { model?: unknown; stream?: unknown };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return handle(cloneRequest(req, bodyText, req.signal));
  }
  const from = typeof parsed.model === "string" ? parsed.model : "";
  const rule = resolveFirstOutputFailover(rules, from);
  if (!rule || parsed.stream !== true) return handle(cloneRequest(req, bodyText, req.signal));
  const { to, afterMs: deadlineMs } = rule;

  const firstAbort = new AbortController();
  const onClientAbort = () => firstAbort.abort(req.signal.reason);
  req.signal.addEventListener("abort", onClientAbort, { once: true });
  const started = Date.now();
  const first = await handle(cloneRequest(req, bodyText, firstAbort.signal));
  if (!first.ok || !first.body) {
    req.signal.removeEventListener("abort", onClientAbort);
    return first;
  }

  const reader = first.body.getReader();
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  let text = "";
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel("first-output deadline"); }, Math.max(0, deadlineMs - (Date.now() - started)));
  let done = false;
  try {
    while (!timedOut) {
      const r = await reader.read();
      if (r.done) { done = true; break; }
      buffered.push(r.value);
      text += decoder.decode(r.value, { stream: true });
      if (hasFirstOutput(text)) break;
    }
  } catch {
    // The deadline timer cancels the reader, which rejects the pending read.
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    req.signal.removeEventListener("abort", onClientAbort);
    firstAbort.abort(new Error("first-output failover deadline"));
    onFailover?.(from, to, Date.now() - started);
    const retargeted = JSON.stringify({ ...parsed, model: to });
    return handle(cloneRequest(req, retargeted, req.signal));
  }

  const passthrough = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
      if (done) {
        req.signal.removeEventListener("abort", onClientAbort);
        controller.close();
      }
    },
    async pull(controller) {
      try {
        const r = await reader.read();
        if (r.done) {
          req.signal.removeEventListener("abort", onClientAbort);
          controller.close();
          return;
        }
        controller.enqueue(r.value);
      } catch (err) {
        req.signal.removeEventListener("abort", onClientAbort);
        controller.error(err);
      }
    },
    cancel(reason) {
      req.signal.removeEventListener("abort", onClientAbort);
      firstAbort.abort(reason);
      return reader.cancel(reason);
    },
  });
  return new Response(passthrough, { status: first.status, statusText: first.statusText, headers: first.headers });
}
