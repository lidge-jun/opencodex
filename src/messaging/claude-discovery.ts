import { readBoundedResponseBytes } from "../lib/bounded-body";
import { isRecord, isThreadId, LocalMessagingError } from "./types";

interface ClaudeSession {
  id: string;
  kind: "interactive" | "background";
  status: "busy" | "waiting" | "idle";
}

const invalidDirectory = () => new LocalMessagingError("invalid_claude_directory", "Claude Code returned an invalid or oversized session directory.");

/** Use the documented agent directory. Its entries are metadata, not delivery routes. */
export async function discoverClaudeSessions(claude: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<ClaudeSession[]> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const unavailable = () => new LocalMessagingError("claude_directory_unavailable", "Claude Code could not list local sessions. Check that the selected CLI supports agents --json.");
  const childEnv = Object.fromEntries(["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "CLAUDE_CONFIG_DIR"]
    .flatMap(key => env[key] === undefined ? [] : [[key, env[key]!] as const]));
  let child;
  try {
    deadline.throwIfAborted();
    child = Bun.spawn([claude, "agents", "--json"], {
      env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "ignore", signal: deadline, killSignal: "SIGKILL",
    });
  } catch { throw unavailable(); }
  let bytes: Uint8Array;
  try {
    const capture = await readBoundedResponseBytes(new Response(child.stdout), { maxBytes: 256 * 1024, signal: deadline });
    if (capture.oversized) throw invalidDirectory();
    if (await child.exited !== 0 || deadline.aborted) throw unavailable();
    bytes = capture.bytes;
  } catch (error) {
    if (error instanceof LocalMessagingError) throw error;
    throw unavailable();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }

  let rows: unknown;
  try { rows = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw invalidDirectory(); }
  if (!Array.isArray(rows) || rows.length > 256) throw invalidDirectory();
  const sessions: ClaudeSession[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) throw invalidDirectory();
    if (row.sessionId == null || row.pid == null) continue;
    const { sessionId, pid, kind, status } = row;
    if (!isThreadId(sessionId) || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0
      || (kind !== "interactive" && kind !== "background")
      || (status !== "busy" && status !== "waiting" && status !== "idle")) throw invalidDirectory();
    const id = sessionId.toLowerCase();
    if (seen.has(id)) throw invalidDirectory();
    seen.add(id);
    sessions.push({ id, kind, status });
  }
  return sessions;
}
