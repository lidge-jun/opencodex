/**
 * Three answers, because the button having been pressed is not evidence that the server
 * accepted anything.
 *
 * `accepted` means the proxy said so, or stopped answering afterwards — the normal shape of
 * a clean shutdown, since the process that would send the response is the one going away.
 * `rejected` means it answered and refused. `unknown` means the request's fate is genuinely
 * not known: it may never have arrived, or it arrived and the answer was lost. These used to
 * collapse into `accepted`, which turned "the user clicked" into "the server acted" and left
 * the dashboard claiming a stop that had not happened.
 *
 * An unknown is resolved by READING the instance again, never by sending the mutation a
 * second time: a stop that did arrive would be repeated against whatever now holds the port.
 */
export type ProxyStopOutcome =
  | { status: "accepted"; message?: undefined }
  | { status: "rejected"; message: string }
  | { status: "unknown"; message: string };

interface ProxyStopPayload {
  success?: unknown;
  message?: unknown;
  error?: unknown;
}

const DEFAULT_STOP_TIMEOUT_MS = 15_000;
/** Short on purpose: this runs after the user has already waited out the stop request. */
const DEFAULT_LIVENESS_TIMEOUT_MS = 3_000;

export interface ProxyStopOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  formatFailure?: (status: number) => string;
  /** Shown when the follow-up read finds the proxy still answering. */
  formatStillRunning?: () => string;
  /** Shown when neither the request nor the follow-up read settled the question. */
  formatUnknown?: () => string;
  mode?: "standalone" | "client";
  /** Budget for the follow-up liveness read. */
  livenessTimeoutMs?: number;
}

function failureMessage(
  payload: ProxyStopPayload | null,
  status: number,
  formatFailure: (status: number) => string,
): string {
  if (typeof payload?.message === "string" && payload.message.trim()) return payload.message;
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
  return formatFailure(status);
}

/**
 * Reads `/healthz` to find out whether the runtime the stop targeted is still there.
 *
 * A refused connection is the answer we want: nothing is listening, so the stop took effect.
 * A successful read is the opposite. Anything else stays undecided rather than being rounded
 * to either.
 */
async function readLiveness(
  apiBase: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<"gone" | "answering" | "undecided"> {
  try {
    const response = await fetchFn(`${apiBase}/healthz`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? "answering" : "undecided";
  } catch {
    return "gone";
  }
}

/**
 * A received response is authoritative: a non-2xx status or `{ success: false }` is a refusal
 * the UI must surface. A lost connection is authoritative about nothing, so it is resolved by
 * reading the instance rather than assumed.
 */
export async function requestProxyStop(
  apiBase: string,
  options: ProxyStopOptions = {},
): Promise<ProxyStopOutcome> {
  const {
    fetchFn = fetch,
    timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    formatFailure = status => `Failed to stop proxy (HTTP ${status}).`,
    formatStillRunning = () => "The proxy is still answering, so it did not stop.",
    formatUnknown = () => "The proxy did not confirm the stop. Check whether it is still running.",
    mode = "standalone",
    livenessTimeoutMs = DEFAULT_LIVENESS_TIMEOUT_MS,
  } = options;
  let response: Response;
  try {
    const path = mode === "client" ? "/api/machine/disconnect" : "/api/stop";
    response = await fetchFn(`${apiBase}${path}`, {
      method: "POST",
      ...(mode === "client" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    /*
     * Timeout, abort, a refused connection and a connection dropped mid-response all land
     * here and are different events. Disconnecting a client does not end the process, so
     * there is nothing to re-read and the question stays open. Stopping the proxy does end
     * it, so its absence afterwards is the evidence.
     */
    if (mode === "client") return { status: "unknown", message: formatUnknown() };
    const liveness = await readLiveness(apiBase, fetchFn, livenessTimeoutMs);
    if (liveness === "gone") return { status: "accepted" };
    if (liveness === "answering") return { status: "unknown", message: formatStillRunning() };
    return { status: "unknown", message: formatUnknown() };
  }

  let payload: ProxyStopPayload | null = null;
  let bodyRead = true;
  try {
    payload = await response.json() as ProxyStopPayload;
  } catch {
    // The status line arrived and the body did not. On a refusal that is already enough to
    // report; on an apparent success it is not, because `success: false` rides in the body
    // this just lost.
    bodyRead = false;
  }
  if (!response.ok || payload?.success === false) {
    return { status: "rejected", message: failureMessage(payload, response.status, formatFailure) };
  }
  if (!bodyRead) return { status: "unknown", message: formatUnknown() };
  return { status: "accepted" };
}
