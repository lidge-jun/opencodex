/**
 * Live Cursor model discovery via the `GetUsableModels` RPC (HTTP/2 + Connect-unary protobuf).
 *
 * Returns the account's actually-usable model ids (the full effort-suffixed variants Cursor offers
 * for THIS plan), so the routed catalog reflects reality instead of a static superset. Failures are
 * classified so callers can surface the reason before applying their existing degradation policy.
 *
 * Protocol notes (hard-won, see devlog 350.110):
 * - content-type `application/proto` + `connect-protocol-version: 1` (NOT `application/connect+proto`,
 *   which the endpoint rejects with 415).
 * - The request body is the EMPTY `GetUsableModelsRequest` → 0 bytes. It MUST be sent with `req.end()`
 *   and NO argument; `req.end(Buffer.alloc(0))` triggers `NGHTTP2_FRAME_SIZE_ERROR` on Bun, and a
 *   5-byte gRPC/Connect frame makes the server mis-parse it ("illegal tag: field no 0").
 */
import http2 from "node:http2";
import { fromBinary } from "@bufbuild/protobuf";
import { GetUsableModelsResponseSchema } from "./gen/agent_pb";

const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const CURSOR_DISCOVERY_CLIENT_VERSION = "cli-2026.02.13-41ac335";

export interface CursorUsableModelsOptions {
  apiKey: string;
  baseUrl?: string;
  clientVersion?: string;
  timeoutMs?: number;
}

export type CursorUsableModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: "auth" | "http" | "transport" | "timeout" | "decode" | "empty"; detail?: string };

const RETRYABLE_DISCOVERY_ERRORS = new Set(["timeout", "transport"]);
const DISCOVERY_RETRY_TIMEOUT_MS = 3_000;

/**
 * Live discovery with ONE bounded retry for transient pre-response failures (fresh HTTP/2
 * session each attempt). Completed non-2xx responses ("http"), auth, decode, and empty are
 * deterministic and never retried. The retry attempt's deadline is capped so a cache-miss
 * catalog poll cannot stall much past the primary timeout (~11.5s worst case, accepted in
 * devlog 260723_cursor_context_continuity/030).
 */
export async function fetchCursorUsableModels(opts: CursorUsableModelsOptions): Promise<CursorUsableModelsResult> {
  const first = await fetchCursorUsableModelsOnce(opts);
  if (first.ok || !RETRYABLE_DISCOVERY_ERRORS.has(first.error)) return first;
  await new Promise(resolve => setTimeout(resolve, 250 + Math.floor(Math.random() * 250)));
  return fetchCursorUsableModelsOnce({ ...opts, timeoutMs: Math.min(opts.timeoutMs ?? 8000, DISCOVERY_RETRY_TIMEOUT_MS) });
}

async function fetchCursorUsableModelsOnce(opts: CursorUsableModelsOptions): Promise<CursorUsableModelsResult> {
  const baseUrl = (opts.baseUrl ?? "https://api2.cursor.sh").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 8000;

  return new Promise<CursorUsableModelsResult>(resolve => {
    let settled = false;
    const finish = (value: CursorUsableModelsResult): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let client: http2.ClientHttp2Session;
    try {
      client = http2.connect(baseUrl);
    } catch {
      return finish({ ok: false, error: "transport", detail: "HTTP/2 connection setup failed" });
    }

    const timer = setTimeout(() => {
      finish({ ok: false, error: "timeout", detail: `No response within ${timeoutMs}ms` });
      client.destroy();
    }, timeoutMs);
    const close = (value: CursorUsableModelsResult): void => {
      clearTimeout(timer);
      client.close();
      finish(value);
    };

    client.on("error", () => close({ ok: false, error: "transport", detail: "HTTP/2 session failed" }));

    let req: http2.ClientHttp2Stream;
    try {
      req = client.request({
        ":method": "POST",
        ":path": CURSOR_GET_USABLE_MODELS_PATH,
        "content-type": "application/proto",
        "connect-protocol-version": "1",
        authorization: `Bearer ${opts.apiKey}`,
        "x-ghost-mode": "true",
        "x-cursor-client-version": opts.clientVersion ?? CURSOR_DISCOVERY_CLIENT_VERSION,
        "x-cursor-client-type": "cli",
        "x-session-id": crypto.randomUUID(),
      });
    } catch {
      return close({ ok: false, error: "transport", detail: "HTTP/2 request setup failed" });
    }

    let status = 0;
    const chunks: Buffer[] = [];
    req.on("response", headers => {
      status = Number(headers[":status"] ?? 0);
    });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", () => close({ ok: false, error: "transport", detail: "HTTP/2 request failed" }));
    req.on("end", () => {
      if (status === 401 || status === 403) {
        return close({ ok: false, error: "auth", detail: `HTTP ${status}` });
      }
      if (status !== 200) return close({ ok: false, error: "http", detail: `HTTP ${status || "unknown"}` });
      try {
        const response = fromBinary(GetUsableModelsResponseSchema, new Uint8Array(Buffer.concat(chunks)));
        // Account filtering uses wire `model_id` values only. Aliases like `composer-2-5` must not
        // make stale configured ids such as `composer-2` look activated.
        const ids: string[] = [];
        const seenIds = new Set<string>();
        for (const model of response.models ?? []) {
          const rawId = (model as { modelId?: string }).modelId;
          if (typeof rawId !== "string") continue;
          const id = rawId.trim();
          if (id.length === 0 || /[\x00-\x1f]/.test(id) || seenIds.has(id)) continue;
          seenIds.add(id);
          ids.push(id);
          if (ids.length === 500) break;
        }
        close(ids.length > 0 ? { ok: true, models: ids } : { ok: false, error: "empty" });
      } catch {
        close({ ok: false, error: "decode", detail: "Invalid GetUsableModels protobuf response" });
      }
    });

    req.end(); // CRITICAL: no body argument (empty Buffer breaks Bun's HTTP/2 framing).
  });
}
