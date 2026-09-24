import { BridgeCoreError, type BridgeErrorCode, MAX_PROMPT_CHARS } from "../../contracts";

/**
 * Minimal MCP client for the local DevSpace control plane (legacy bridge tools).
 *
 * Config invariants: the bearer token is supplied by OC configuration, never
 * logged, never placed in URLs; the endpoint is the loopback-only DevSpace
 * server (default 127.0.0.1:17676/mcp). Transport failures surface as
 * BridgeCoreError so callers cannot mistake them for delivery outcomes.
 */
export interface DevSpaceMcpClientConfig {
  baseUrl: string;
  bearerToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export class DevSpaceMcpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private sessionReady: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: DevSpaceMcpClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async healthz(): Promise<{ ok: boolean; name?: string }> {
    const url = this.config.baseUrl.replace(/\/mcp\/?$/, "") + "/healthz";
    const response = await this.fetchImpl(url, { signal: this.signal() });
    if (!response.ok) throw new BridgeCoreError("HOST_OFFLINE", `devspace healthz ${response.status}`);
    return (await response.json()) as { ok: boolean; name?: string };
  }

  /** Streamable-HTTP MCP requires an initialize handshake to mint the session id. */
  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;
    if (!this.sessionReady) {
      this.sessionReady = (async () => {
        const response = await this.postRpc(
          { jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "opencodex-chatgpt-bridge", version: "0.1.0" },
          } },
          true,
        );
        const header = response.headers.get("mcp-session-id");
        if (header) this.sessionId = header;
        if (this.sessionId) {
          await this.fetchImpl(this.config.baseUrl, {
            method: "POST",
            // Streamable HTTP scopes every frame after initialize to the minted
            // session, so this notification must carry the id it announces.
            headers: this.headers(true),
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
            signal: this.signal(),
          });
        }
      })();
      this.sessionReady.catch(() => {
        this.sessionReady = null;
      });
    }
    await this.sessionReady;
  }

  private headers(withSession: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.config.bearerToken}`,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    if (withSession && this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private async postRpc(body: unknown, captureSession = false): Promise<Response> {
    const response = await this.fetchImpl(this.config.baseUrl, {
      method: "POST",
      headers: this.headers(!captureSession && this.sessionId !== null),
      body: JSON.stringify(body),
      signal: this.signal(),
    });
    if (response.status === 401 || response.status === 403) {
      throw new BridgeCoreError("AUTH_REQUIRED", `devspace rejected credentials (${response.status})`);
    }
    if (response.status === 404) {
      // A DevSpace restart retires the minted session id, and every later call
      // would then be rejected with the same 404. Drop it so the next call
      // re-initializes instead of failing for the life of this client.
      this.sessionId = null;
      this.sessionReady = null;
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new BridgeCoreError("HOST_OFFLINE", `devspace mcp ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return response;
  }

  /** Invoke a DevSpace MCP tool and unwrap the bridge result envelope. */
  async callTool<T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.ensureSession();
    const id = this.nextId++;
    const response = await this.postRpc({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: tool, arguments: args },
    });
    const payload = await this.parseRpcResponse(response, id);
    if (payload.error) {
      throw new BridgeCoreError("HOST_OFFLINE", `devspace rpc error ${payload.error.code}: ${payload.error.message}`);
    }
    const result = payload.result ?? {};
    if (result.isError === true) {
      throw this.bridgeFailure(tool, result);
    }
    return result as T;
  }

  /**
   * Streamable HTTP servers may answer a POST with an SSE stream carrying the
   * JSON-RPC frame; unwrap either transport into a single response object.
   * A shared stream multiplexes every request, so a frame is only an answer
   * when it carries this request's id — the first response frame may belong to
   * an earlier call.
   */
  private async parseRpcResponse(response: Response, id: number | string): Promise<JsonRpcResponse> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const raw = await response.text();
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const chunk = line.slice(5).trim();
        if (!chunk) continue;
        try {
          const frame = JSON.parse(chunk) as JsonRpcResponse;
          if (frame.id === id && (frame.result || frame.error)) return frame;
        } catch {
          // ignore keep-alive comments / non-JSON frames
        }
      }
      throw new BridgeCoreError("HOST_OFFLINE", "devspace SSE stream carried no RPC response");
    }
    return (await response.json()) as JsonRpcResponse;
  }

  /**
   * DevSpace bridge tools wrap bridge-lib failures as
   * `{ ok: false, code, message, details? }` JSON inside the text content.
   * Known codes map 1:1 onto Bridge error codes; unknown codes must not be
   * reinterpreted as delivery outcomes.
   */
  private bridgeFailure(tool: string, result: Record<string, unknown>): BridgeCoreError {
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find(c => c.type === "text")?.text ?? "{}";
    let parsed: { ok?: boolean; code?: string; message?: string; details?: Record<string, unknown> };
    try {
      parsed = JSON.parse(text);
    } catch {
      return new BridgeCoreError("HOST_OFFLINE", `${tool} returned unparseable failure payload`);
    }
    const code = parsed.code ?? "";
    if ((KNOWN_DEVSPACE_CODES as readonly string[]).includes(code)) {
      return new BridgeCoreError(code as BridgeErrorCode, parsed.message ?? code, parsed.details);
    }
    return new BridgeCoreError("HOST_OFFLINE", `${tool} failure ${code}: ${parsed.message ?? ""}`);
  }

  private signal(): AbortSignal | undefined {
    if (!this.config.timeoutMs) return undefined;
    return AbortSignal.timeout(this.config.timeoutMs);
  }
}

/** Codes shared verbatim between DevSpace bridge-lib and this module's contract. */
const KNOWN_DEVSPACE_CODES = [
  "TARGET_ACTIVE",
  "TARGET_NOT_FOUND",
  "BINDING_NOT_FOUND",
  "BINDING_CHANGED",
  "BINDING_INACTIVE",
  "BINDING_REVISION_CONFLICT",
  "OPERATION_ID_CONFLICT",
  "SEND_IN_PROGRESS",
  "SEND_PAUSED",
  "DUPLICATE_PROMPT",
  "DELIVERY_UNKNOWN",
  "EMPTY_PROMPT",
  "PROMPT_TOO_LARGE",
  "INVALID_CHATGPT_URL",
  "INVALID_REGISTRY",
  "CAPABILITY_EXPIRED",
  "ATTACHMENT_REQUIRED",
  "CAPABILITY_ROTATED",
  "CAPABILITY_REVOKED",
  "EXECUTOR_REQUIRED",
  "EXECUTOR_NOT_FOUND",
  "PIPE_TIMEOUT",
  "PIPE_CLOSED",
  "PIPE_ERROR",
  "APP_RPC_ERROR",
  "APP_TOOL_FAILED",
  "TOOL_NOT_ALLOWED",
  "STATE_ACL_FAILED",
] as const satisfies readonly string[];

export interface CodexBridgeStatus {
  bindingId: string;
  state: string;
  codex?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

/**
 * Codex host adapter: persistent-collaboration operations against the exact
 * legacy-bound task, executed through the existing DevSpace control plane.
 * This module never re-implements discovery, locking, or delivery semantics —
 * bridge-lib remains the sole authority for existing bindings.
 */
export class CodexHostAdapter {
  constructor(private readonly client: DevSpaceMcpClient) {}

  async healthz(): Promise<boolean> {
    const health = await this.client.healthz();
    return health.ok === true;
  }

  async attach(controllerId: string): Promise<CodexBridgeStatus> {
    const result = await this.client.callTool("codex_bridge_attach", { controllerId });
    return this.toStatus(result);
  }

  async status(controllerId: string): Promise<CodexBridgeStatus> {
    const result = await this.client.callTool("codex_bridge_status", { controllerId });
    return this.toStatus(result);
  }

  async read(
    controllerId: string,
    options: { turnLimit?: number; includeOutputs?: boolean; maxOutputCharsPerItem?: number } = {},
  ): Promise<CodexBridgeStatus> {
    const result = await this.client.callTool("codex_bridge_read", { controllerId, ...options });
    return this.toStatus(result);
  }

  async wait(controllerId: string, options: { timeoutMs?: number; cursor?: string } = {}): Promise<CodexBridgeStatus> {
    const result = await this.client.callTool("codex_bridge_wait", { controllerId, ...options });
    return this.toStatus(result);
  }

  async send(controllerId: string, prompt: string): Promise<CodexBridgeStatus> {
    if (prompt.length === 0) throw new BridgeCoreError("EMPTY_PROMPT", "prompt is empty");
    if (prompt.length > MAX_PROMPT_CHARS) throw new BridgeCoreError("PROMPT_TOO_LARGE", "prompt exceeds 512 KiB");
    const result = await this.client.callTool("codex_bridge_send", { controllerId, prompt });
    return this.toStatus(result);
  }

  private toStatus(result: Record<string, unknown>): CodexBridgeStatus {
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find(c => c.type === "text")?.text ?? "{}";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new BridgeCoreError("HOST_OFFLINE", "bridge tool returned unparseable result");
    }
    if (parsed.ok === false) {
      throw new BridgeCoreError("HOST_OFFLINE", String(parsed.message ?? "bridge tool failure"));
    }
    return {
      bindingId: typeof parsed.bindingId === "string" ? parsed.bindingId : "",
      state: typeof parsed.state === "string" ? parsed.state : "",
      codex: (parsed.codex as Record<string, unknown>) ?? undefined,
      raw: parsed,
    };
  }
}
