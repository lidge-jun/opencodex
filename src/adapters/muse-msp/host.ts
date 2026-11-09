import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { MuseMspConnection, MuseMspError } from "./connection";
import { MuseMspInbox } from "./inbox";
import { initializeMuseMsp, requireMuseAccountLogin } from "./handshake";

/** Owns only the direct child created here. The caller supplies isolated settings and environment. */
export class MuseMspHost {
  readonly inbox = new MuseMspInbox();
  readonly connection: MuseMspConnection;
  private readonly invalidation = new AbortController();
  readonly invalidated = this.invalidation.signal;
  private readonly exited: Promise<void>;
  private closed = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly requireAccountLogin?: true) {
    // Streams can report a late EPIPE after the connection has detached its handlers.
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    this.connection = new MuseMspConnection(child.stdout, child.stdin, message => {
      // An observed credential change invalidates the assumptions under which
      // this host was opened. The notification is not a pre-dispatch barrier.
      if (message.method === "account/changed") {
        this.invalidation.abort(); this.inbox.close("host_account_changed"); this.connection.close(); return;
      }
      // These host notifications indicate a changed or unserved route. Stop the
      // retained session instead of accepting a result under an uncertain identity.
      if (message.method === "session/modelChanged" || message.method === "session/modelRouteUnserved") {
        this.invalidation.abort(); this.inbox.close("host_route_changed"); this.connection.close(); return;
      }
      // MSP view gaps or an unavailable live view mean that the item, usage,
      // or approval sequence may be incomplete. This prototype does not page
      // or re-anchor the view, so continuing would misrepresent the turn.
      if (message.method === "view/gap" || message.method === "session/viewHealthChanged") {
        this.invalidation.abort(); this.inbox.close("host_view_unavailable"); this.connection.close(); return;
      }
      // Retry notifications are emitted after a retry has been scheduled, not as
      // an admission gate. Fail the session instead of silently accepting a replay;
      // closing cannot prove a racing retry did not already dispatch.
      if (message.method === "turn/retryScheduled" || message.method === "turn/modelRetryScheduled") {
        this.invalidation.abort(); this.inbox.close("host_retry_scheduled"); this.connection.close(); return;
      }
      if (message.method === "approval/request" && (typeof message.id === "string" || typeof message.id === "number")) {
        // MSP's empty acknowledgement is not an approval decision. Send it immediately,
        // even while the Responses client is between requests, then enqueue the event for
        // the session/turn/catalog validation which gates the actual approval decision.
        const { id, ...rest } = message;
        void this.connection.respond(id, {}).then(
          () => this.inbox.push({ ...rest, method: "approval/requested" }),
          () => { this.connection.close(); this.inbox.close("host_error"); },
        );
      } else this.inbox.push(message);
    });
    // Never persist or forward arbitrary diagnostics, which may contain prompts or credentials.
    child.stderr.resume();
    this.exited = new Promise(resolve => {
      child.once("error", () => { this.invalidation.abort(); this.connection.close(); this.inbox.close("host_error"); resolve(); });
      child.once("close", () => { this.invalidation.abort(); this.connection.close(); this.inbox.close("host_exited"); resolve(); });
    });
  }

  static async start(config: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv },
    options: { timeoutMs: number; signal?: AbortSignal; requireAccountLogin?: true }): Promise<MuseMspHost> {
    if (!isAbsolute(config.executable) || !isAbsolute(config.cwd) || !Array.isArray(config.args) || config.args.length > 64 ||
        config.args.some(arg => typeof arg !== "string" || Buffer.byteLength(arg) > 4096) || !config.env ||
        !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000) throw new MuseMspError("invalid_host_config");
    if (options.signal?.aborted) throw new MuseMspError("cancelled");
    const child = spawn(config.executable, config.args, { cwd: config.cwd, env: { ...config.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    const host = new MuseMspHost(child, options.requireAccountLogin);
    try {
      await initializeMuseMsp(host.connection, { timeoutMs: options.timeoutMs, signal: options.signal, requireEphemeral: true, requireAccountLogin: options.requireAccountLogin });
      return host;
    } catch (error) { await host.close(); throw error; }
  }

  /** Recheck before starting a user turn; this cannot make the later dispatch atomic. */
  async checkAccountLogin(options: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
    if (!this.requireAccountLogin) return;
    try { await requireMuseAccountLogin(this.connection, options); }
    catch (error) { this.invalidation.abort(); this.inbox.close("host_account_unavailable"); this.connection.close(); throw error; }
    if (this.invalidated.aborted) throw new MuseMspError("host_account_unavailable");
  }

  /** Close this child only; never enumerate or kill processes by name or port. */
  async close(): Promise<void> {
    if (this.closed) return this.exited;
    this.closed = true; this.invalidation.abort(); this.connection.close(); this.inbox.close();
    this.child.stdin.end();
    const timer = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(); }, 1000);
    timer.unref?.();
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}
