/**
 * Live Cursor model discovery via the `GetUsableModels` RPC (HTTP/2 + Connect-unary protobuf).
 *
 * Returns the account's actually-usable model ids (the full effort-suffixed variants Cursor offers
 * for THIS plan), so the routed catalog reflects reality instead of a static superset. Returns null on
 * any failure (caller falls back to the static seed).
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

export async function fetchCursorUsableModels(opts: CursorUsableModelsOptions): Promise<string[] | null> {
  const baseUrl = (opts.baseUrl ?? "https://api2.cursor.sh").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 8000;

  return new Promise<string[] | null>(resolve => {
    let settled = false;
    const finish = (value: string[] | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let client: http2.ClientHttp2Session;
    try {
      client = http2.connect(baseUrl);
    } catch {
      return finish(null);
    }

    const timer = setTimeout(() => {
      client.destroy();
      finish(null);
    }, timeoutMs);
    const close = (value: string[] | null): void => {
      clearTimeout(timer);
      client.close();
      finish(value);
    };

    client.on("error", () => close(null));

    const req = client.request({
      ":method": "POST",
      ":path": CURSOR_GET_USABLE_MODELS_PATH,
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      authorization: `Bearer ${opts.apiKey}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": opts.clientVersion ?? CURSOR_DISCOVERY_CLIENT_VERSION,
      "x-cursor-client-type": "cli",
    });

    let status = 0;
    const chunks: Buffer[] = [];
    req.on("response", headers => {
      status = Number(headers[":status"] ?? 0);
    });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", () => close(null));
    req.on("end", () => {
      if (status !== 200) return close(null);
      try {
        const response = fromBinary(GetUsableModelsResponseSchema, new Uint8Array(Buffer.concat(chunks)));
        // Account filtering uses wire `model_id` values only. Aliases like `composer-2-5` must not
        // make stale configured ids such as `composer-2` look activated.
        const ids = (response.models ?? [])
          .map(model => (model as { modelId?: string }).modelId)
          .filter((id): id is string => typeof id === "string" && id.length > 0);
        close(ids.length > 0 ? ids : null);
      } catch {
        close(null);
      }
    });

    req.end(); // CRITICAL: no body argument (empty Buffer breaks Bun's HTTP/2 framing).
  });
}
