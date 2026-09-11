/**
 * Devin CLI adapter: one ACP session per turn over stdio.
 *
 * This is the local half of Devin support. The cloud-direct `devin` adapter
 * talks to Cognition's api-server; this one drives the installed `devin` CLI,
 * which carries its own credentials from `devin auth login`, so the proxy never
 * sees a token for this provider.
 *
 * runTurn-only, like the Cursor and cloud Devin adapters: a JSON-RPC handshake
 * over a child process has no fetch-shaped request to hand to the generic wire
 * path.
 *
 * The child is treated as untrusted and unprivileged. It gets a scoped
 * environment rather than the proxy's, its permission requests are refused
 * unless an operator opted in, and it is reaped rather than merely signalled,
 * because a Devin grandchild that ignores SIGTERM would otherwise keep writing
 * in the operator's tree after the turn returned.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import { baseScopedEnv } from "../coding-agent/turn";
import {
  ACP_INITIALIZE_ID,
  ACP_SESSION_NEW_ID,
  ACP_SESSION_PROMPT_ID,
  MAX_ACP_LINE_BYTES,
  MAX_ACP_TOTAL_BYTES,
  acpUpdateToEvents,
  buildAcpPrompt,
  initializeFrame,
  mapAcpStopReason,
  mapAcpUsage,
  permissionResponseFrame,
  sessionNewFrame,
  sessionPromptFrame,
} from "./acp";
import { DEVIN_CLI_INSTALL_HINT, resolveDevinCliBinary } from "./binary";

/** A turn that has not produced a prompt reply by this point is abandoned. */
const DEVIN_CLI_TURN_TIMEOUT_MS = 10 * 60 * 1000;
/** Grace between SIGTERM and SIGKILL when reaping the child. */
const DEVIN_CLI_KILL_GRACE_MS = 2_000;
/** How long to wait for the child to actually exit before giving up on it. */
const DEVIN_CLI_REAP_MS = 5_000;

/**
 * Identity URL for the provider. The CLI does the real transport over stdio;
 * this is only what the configuration records as the destination, and it has to
 * be an http(s) URL because provider config validation rejects other schemes.
 */
export const DEVIN_CLI_IDENTITY_URL = "https://cli.devin.ai";

/**
 * Opt-in for letting the CLI act on the machine.
 *
 * Off by default: this provider runs an agent in the operator's own tree, and a
 * proxy that auto-approves whatever a prompt asks for is a remote shell.
 */
const DEVIN_CLI_ALLOW_TOOLS_ENV = "OPENCODEX_DEVIN_CLI_ALLOW_TOOLS";

export type DevinCliSpawn = (binary: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ChildProcessWithoutNullStreams;

export function devinCliToolsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DEVIN_CLI_ALLOW_TOOLS_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function createDevinCliAdapter(provider: OcxProviderConfig, deps?: { spawn?: DevinCliSpawn }): ProviderAdapter {
  const spawnChild: DevinCliSpawn = deps?.spawn
    ?? ((binary, args, options) => spawn(binary, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Give the child its own process group on POSIX so the reap below can
      // signal the whole tree. Devin spawns shells and tools of its own when
      // the operator allows them, and signalling only the direct pid leaves
      // those descendants writing in the operator's tree after the turn ended.
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams);

  return {
    name: "devin-cli",

    buildRequest() {
      // Placeholder: this adapter never travels the fetch path. The URL is the
      // provider's identity, not a destination anything connects to.
      return { url: provider.baseUrl || DEVIN_CLI_IDENTITY_URL, method: "POST", headers: {}, body: "" };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "Devin CLI adapter uses runTurn; the fetch/parseStream path is disabled." };
    },

    async runTurn(parsed: OcxParsedRequest, incoming: IncomingMeta, emit: (event: AdapterEvent) => void) {
      if (incoming.abortSignal?.aborted) {
        emit({ type: "error", message: "Devin CLI turn was aborted before start." });
        return;
      }
      const binary = resolveDevinCliBinary();
      if (!binary) {
        emit({ type: "error", message: `Devin CLI not found. ${DEVIN_CLI_INSTALL_HINT}` });
        return;
      }

      const modelId = parsed.modelId.includes("/")
        ? parsed.modelId.slice(parsed.modelId.lastIndexOf("/") + 1)
        : parsed.modelId;
      const cwd = process.env.OPENCODEX_DEVIN_CLI_CWD?.trim() || process.cwd();
      const toolsAllowed = devinCliToolsAllowed();

      await new Promise<void>((resolve) => {
        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawnChild(binary, ["acp"], {
            cwd,
            env: {
              // A scoped environment, not the proxy's. The child would
              // otherwise inherit every credential this process holds.
              ...baseScopedEnv(),
              NO_COLOR: "1",
              DEVIN_PERMISSION_MODE: toolsAllowed ? (process.env.DEVIN_PERMISSION_MODE ?? "bypass") : "ask",
            },
          });
        } catch (error) {
          emit({ type: "error", message: `Devin CLI failed to start (${binary}): ${(error as Error).message}. ${DEVIN_CLI_INSTALL_HINT}` });
          return resolve();
        }

        let settled = false;
        let closed = false;
        let sawProtocolFrame = false;
        let sawPromptReply = false;
        let buffer = "";
        let totalBytes = 0;
        let usage: OcxUsage | undefined;
        let stopReason: string | undefined;
        let stderrTail = "";

        const turnTimer = setTimeout(
          () => finish(`Devin CLI turn exceeded ${DEVIN_CLI_TURN_TIMEOUT_MS}ms`),
          DEVIN_CLI_TURN_TIMEOUT_MS,
        );
        const onAbort = () => finish("Devin CLI turn was aborted.");

        /**
         * Reap the child rather than just signalling it, then resolve.
         *
         * `child.killed` only records that a signal was sent. Resolving on that
         * lets a grandchild keep running in the operator's tree after runTurn
         * returned, which is why this waits for `close` and escalates.
         */
        function reapAndResolve(): void {
          if (closed || child.exitCode !== null || child.signalCode !== null) return resolve();
          let done = false;
          const settle = () => {
            if (done) return;
            done = true;
            clearTimeout(killTimer);
            clearTimeout(reapTimer);
            resolve();
          };
          child.once("close", settle);
          signalTree("SIGTERM");
          const killTimer = setTimeout(() => signalTree("SIGKILL"), DEVIN_CLI_KILL_GRACE_MS);
          const reapTimer = setTimeout(settle, DEVIN_CLI_REAP_MS);
        }

        /**
         * Signal the child's whole process group where the platform has one.
         * Devin launches shells and tools of its own once the operator allows
         * them, and those descendants do not receive a signal aimed at the
         * direct pid. Falls back to the single process when the group send is
         * unavailable or the group is already gone.
         */
        function signalTree(signal: NodeJS.Signals): void {
          const pid = child.pid;
          if (pid !== undefined && process.platform !== "win32") {
            try {
              process.kill(-pid, signal);
              return;
            } catch { /* no group, or already reaped - fall through */ }
          }
          try { child.kill(signal); } catch { /* already gone */ }
        }

        /** Terminate the turn exactly once, with an error when given a reason. */
        function finish(errorMessage?: string): void {
          if (settled) return;
          settled = true;
          clearTimeout(turnTimer);
          incoming.abortSignal?.removeEventListener("abort", onAbort);
          child.stdout.destroy();
          if (errorMessage) emit({ type: "error", message: errorMessage, ...(usage ? { usage } : {}) });
          else emit({ type: "done", ...(usage ? { usage } : {}), ...(stopReason ? { stopReason } : {}) });
          reapAndResolve();
        }

        incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });
        // The signal can fire between the pre-spawn check and this listener.
        if (incoming.abortSignal?.aborted) return finish("Devin CLI turn was aborted.");

        const send = (frame: Record<string, unknown>): void => {
          if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(frame)}\n`);
        };
        // EPIPE after the child is killed is an ordinary race, not a crash.
        child.stdin.on("error", () => {});

        child.on("error", (err) => finish(`Devin CLI failed to start (${binary}): ${err.message}. ${DEVIN_CLI_INSTALL_HINT}`));

        child.on("close", (code) => {
          closed = true;
          if (settled) return;
          // Flush a final frame that arrived without a trailing newline before
          // deciding the turn failed: the prompt reply carrying usage and the
          // stop reason is often the last line written.
          flush(buffer);
          buffer = "";
          if (settled) return;
          // A close without a prompt reply is a failure, not an empty success.
          const detail = stderrTail.trim().slice(-400);
          finish(
            `Devin CLI exited (code ${code ?? "null"}) before answering the prompt` +
            (detail ? `: ${detail}` : "."),
          );
        });

        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          // Bounded: diagnostics are for the error message, not a buffer to grow.
          stderrTail = (stderrTail + chunk).slice(-4096);
        });

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (settled) return;
          totalBytes += Buffer.byteLength(chunk, "utf8");
          if (totalBytes > MAX_ACP_TOTAL_BYTES) return finish("Devin CLI produced more output than one turn may consume.");
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            flush(line);
            if (settled) return;
          }
          if (Buffer.byteLength(buffer, "utf8") > MAX_ACP_LINE_BYTES) {
            finish("Devin CLI emitted a single line larger than the frame cap.");
          }
        });

        // The prompt reply carrying usage and the stop reason is often the last
        // thing written, and it is not guaranteed to end with a newline. Flush
        // the remainder when the stream ends rather than waiting for the child
        // to exit and then calling a complete turn a failure.
        child.stdout.on("end", () => {
          const tail = buffer;
          buffer = "";
          flush(tail);
        });

        function flush(raw: string): void {
          const line = raw.trim();
          if (!line || settled) return;
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(line) as Record<string, unknown>;
          } catch {
            // The CLI prints a banner before the protocol starts, so plain text
            // is expected up to the first valid frame. After that the stream is
            // protocol, and a line that is shaped like a frame but does not
            // parse is corruption: dropping it silently loses a session/update
            // or lets the turn wait out the timeout for a reply that already
            // arrived damaged.
            if (sawProtocolFrame || line.startsWith("{")) {
              finish("Devin CLI emitted a malformed ACP frame.");
            }
            return;
          }
          sawProtocolFrame = true;
          handle(frame);
        }

        /** JSON-RPC ids are allowed to come back as strings. */
        const idOf = (value: unknown): number | undefined => {
          if (typeof value === "number") return value;
          if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
          return undefined;
        };

        function handle(frame: Record<string, unknown>): void {
          if (settled) return;
          const id = idOf(frame.id);
          const error = frame.error as { message?: string } | undefined;

          if (id === ACP_INITIALIZE_ID) {
            if (error) return finish(`Devin CLI initialize failed: ${error.message ?? "unknown error"}`);
            send(sessionNewFrame(cwd, modelId));
            return;
          }
          if (id === ACP_SESSION_NEW_ID) {
            if (error) return finish(`Devin CLI session/new failed: ${error.message ?? "unknown error"}`);
            const sessionId = (frame.result as { sessionId?: string } | undefined)?.sessionId;
            if (!sessionId) return finish("Devin CLI session/new returned no sessionId.");
            send(sessionPromptFrame(sessionId, buildAcpPrompt(parsed)));
            return;
          }
          if (frame.method === "session/request_permission" && frame.id != null) {
            const params = frame.params as { options?: Array<{ optionId?: string; name?: string; kind?: string }> } | undefined;
            send(permissionResponseFrame(frame.id as number | string, params?.options, toolsAllowed));
            return;
          }
          if (frame.method === "session/update") {
            const update = (frame.params as { update?: Record<string, unknown> } | undefined)?.update;
            if (!update) return;
            for (const event of acpUpdateToEvents(update)) emit(event);
            return;
          }
          if (id === ACP_SESSION_PROMPT_ID) {
            if (error) return finish(`Devin CLI session/prompt failed: ${error.message ?? "unknown error"}`);
            sawPromptReply = true;
            const result = frame.result as { stopReason?: unknown; usage?: unknown } | undefined;
            usage = mapAcpUsage(result?.usage) ?? usage;
            stopReason = mapAcpStopReason(result?.stopReason);
            finish();
          }
        }

        void sawPromptReply;
        send(initializeFrame(process.env.OPENCODEX_VERSION ?? "0.0.0"));
      });
    },
  };
}
