import { isAbsolute } from "node:path";
import { MuseMspError } from "./connection";
import { MuseApprovalCapture, type CapturedMuseApproval, type MuseClientTool } from "./approval";

type JsonRecord = Record<string, unknown>;
type CommandOptions = { timeoutMs: number; signal?: AbortSignal };
export interface MuseMspRequester {
  request(method: string, params: JsonRecord, options: CommandOptions): Promise<unknown>;
}
export interface CaptureServer {
  /** The caller must supply its own trusted capture-only executable and arguments. */
  command: string;
  args: readonly string[];
  /** Session-scoped channel capability; never place these values in argv or logs. */
  env?: Readonly<{ OCX_MUSE_CAPTURE_PORT: string; OCX_MUSE_CAPTURE_TOKEN: string }>;
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bounded(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maxBytes;
}
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/** One MSP session. The caller owns process lifetime and must buffer early notifications. */
export class MuseMspSession {
  private readonly captures = new WeakMap<MuseApprovalCapture, string>();
  private activeTurnId: string | undefined;
  private openingTurn = false;
  private turnCaptureCreated = false;
  private unusable = false;
  private constructor(
    private readonly connection: MuseMspRequester,
    readonly sessionId: string,
    private readonly commandId: () => string,
  ) {}

  static async open(
    connection: MuseMspRequester,
    config: { workspaceRoot: string; modelId: string; captureServer: CaptureServer },
    options: CommandOptions,
    commandId: () => string = () => Bun.randomUUIDv7(),
  ): Promise<MuseMspSession> {
    if (!bounded(config.workspaceRoot, 4096) || !isAbsolute(config.workspaceRoot) ||
        !bounded(config.modelId, 512) || !bounded(config.captureServer.command, 4096) ||
        !isAbsolute(config.captureServer.command) || config.captureServer.args.length > 32 ||
        config.captureServer.args.some(arg => typeof arg !== "string" || Buffer.byteLength(arg) > 4096) ||
        (config.captureServer.env !== undefined && (!/^[1-9][0-9]{0,4}$/.test(config.captureServer.env.OCX_MUSE_CAPTURE_PORT) ||
          Number(config.captureServer.env.OCX_MUSE_CAPTURE_PORT) > 65535 || !/^[0-9a-f]{64}$/.test(config.captureServer.env.OCX_MUSE_CAPTURE_TOKEN)))) {
      throw new MuseMspError("invalid_session_config");
    }
    const id = commandId();
    const result = await connection.request("session/start", {
      commandId: id,
      workspaceRoot: config.workspaceRoot,
      modelId: config.modelId,
      approvalMode: "promptUnmatched",
      config: { mcpServers: { opencodex: {
        transport: "stdio", command: config.captureServer.command, args: [...config.captureServer.args], mode: "required",
        ...(config.captureServer.env === undefined ? {} : { env: { ...config.captureServer.env } }),
      } } },
    }, options);
    if (!record(result) || !record(result.session) || !bounded(result.session.sessionId, 512)) {
      throw new MuseMspError("invalid_session_response");
    }
    return new MuseMspSession(connection, result.session.sessionId, commandId);
  }

  /** Bind a tool catalog to one turn of this session before accepting any approval event. */
  captureForTurn(turnId: string, tools: ReadonlyMap<string, MuseClientTool>): MuseApprovalCapture {
    if (this.unusable || !bounded(turnId, 512) || turnId !== this.activeTurnId || this.turnCaptureCreated ||
        [...tools.keys()].some(name => !name.startsWith("mcp__opencodex__"))) {
      throw new MuseMspError("invalid_approval_scope");
    }
    const capture = new MuseApprovalCapture(this.sessionId, turnId, tools);
    this.captures.set(capture, turnId);
    this.turnCaptureCreated = true;
    return capture;
  }

  async startTurn(input: string, reasoningEffort: string | undefined, options: CommandOptions & { allowQueued?: true }, images: import("./initial-history").MuseHistoryImage[] = []): Promise<string> {
    if (!bounded(input, 4 * 1024 * 1024) || (reasoningEffort !== undefined && !EFFORTS.has(reasoningEffort))) {
      throw new MuseMspError("invalid_turn_input");
    }
    if (this.unusable) throw new MuseMspError("session_unusable");
    if (this.activeTurnId !== undefined || this.openingTurn) throw new MuseMspError("turn_already_active");
    this.openingTurn = true;
    try {
      const commandId = this.commandId();
      const result = await this.connection.request("turn/start", {
        commandId, sessionId: this.sessionId, input: [{ type: "text", text: input }, ...images],
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      }, options);
      if (!record(result) || result.commandId !== commandId || result.status !== "accepted" ||
          !(result.disposition === "started" || (options.allowQueued && result.disposition === "queued")) || !bounded(result.turnId, 512)) {
        throw new MuseMspError("invalid_turn_response");
      }
      this.activeTurnId = result.turnId;
      this.turnCaptureCreated = false;
      return result.turnId;
    } catch (error) {
      // An admission acknowledgement can be lost after the host started work. Do not submit again.
      this.unusable = true;
      throw error;
    } finally {
      this.openingTurn = false;
    }
  }

  /** Only use for the private capture-only MCP server, never for a real tool execution. */
  async steer(text: string, options: CommandOptions): Promise<void> {
    if (this.unusable || !this.activeTurnId || !bounded(text, 1024 * 1024)) throw new MuseMspError("invalid_steering");
    const commandId = this.commandId(), turnId = this.activeTurnId;
    const result = await this.connection.request("turn/steer", {commandId, sessionId:this.sessionId,
      expectedTurnId:turnId, input:[{type:"text",text}]}, options);
    if (!record(result) || result.commandId !== commandId || result.status !== "accepted" || result.turnId !== turnId)
      throw new MuseMspError("invalid_steering_response");
  }

  async admitCapture(turnId: string, capture: MuseApprovalCapture, approval: CapturedMuseApproval, options: CommandOptions): Promise<void> {
    if (this.unusable || this.activeTurnId !== turnId || this.captures.get(capture) !== turnId || !capture.claim(approval, this.sessionId, turnId)) {
      throw new MuseMspError("unowned_approval");
    }
    try {
      const commandId = this.commandId();
      const result = await this.connection.request("approval/decide", {
        commandId, sessionId: this.sessionId, approvalId: approval.approvalId,
        requirementId: approval.requirement, choiceId: "allow_once",
      }, options);
      if (!record(result) || result.commandId !== commandId || result.status !== "accepted" ||
          result.approvalId !== approval.approvalId || result.terminal !== true) {
        throw new MuseMspError("invalid_approval_response");
      }
    } catch (error) {
      this.unusable = true;
      throw error;
    }
  }

  async cancelTurn(turnId: string, options: CommandOptions): Promise<void> {
    if (!bounded(turnId, 512) || turnId !== this.activeTurnId) throw new MuseMspError("invalid_turn_id");
    try {
      const commandId = this.commandId();
      const result = await this.connection.request("turn/cancel", { commandId, sessionId: this.sessionId, turnId }, options);
      if (!record(result) || result.commandId !== commandId || result.status !== "accepted" || result.turnId !== turnId) {
        throw new MuseMspError("invalid_cancel_response");
      }
    } catch (error) {
      this.unusable = true;
      throw error;
    }
  }

  /** Accept only the host's terminal event for this session's active turn. */
  finishTurn(event: unknown): void {
    if (!record(event) || event.method !== "turn/completed" || !record(event.params) ||
        event.params.sessionId !== this.sessionId || event.params.turnId !== this.activeTurnId ||
        this.activeTurnId === undefined || !["completed", "failed", "cancelled"].includes(String(event.params.terminal))) {
      throw new MuseMspError("invalid_turn_terminal");
    }
    this.activeTurnId = undefined;
    this.turnCaptureCreated = false;
  }
}
