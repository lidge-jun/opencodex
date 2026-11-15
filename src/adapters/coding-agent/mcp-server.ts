import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface CodingAgentMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface PendingResultEntry {
  text: string;
  isError: boolean;
}

/** Advertise client tools without executing them: only Codex/client may execute a call. */
export async function serveCodingAgentMcpTools(
  tools: CodingAgentMcpTool[],
  serverName: string,
  capturePath?: string,
  resultsPath?: string,
): Promise<void> {
  const exitOnStdinClose = (): void => process.exit(0);
  process.stdin.on("end", exitOnStdinClose);
  process.stdin.on("close", exitOnStdinClose);

  let nextSeq = 0;
  const pendingBySeq = new Map<number, (entry: PendingResultEntry) => void>();
  const deliveredBySeq = new Map<number, PendingResultEntry>();
  let processedLines = 0;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const stopPollingIfIdle = (): void => {
    if (pendingBySeq.size === 0 && pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const drainResultsFile = (): void => {
    if (!resultsPath || !existsSync(resultsPath)) return;
    let raw = "";
    try {
      raw = readFileSync(resultsPath, "utf8");
    } catch {
      return;
    }
    const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
    if (!complete) return;
    const lines = complete.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (; processedLines < lines.length; processedLines++) {
      const line = lines[processedLines]!.trim();
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const rec = parsed as Record<string, unknown>;
        const seq = rec.seq;
        if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= 0) continue;
        const entry: PendingResultEntry = {
          text: typeof rec.text === "string" ? rec.text : "",
          isError: rec.isError === true,
        };
        const resolver = pendingBySeq.get(seq);
        if (resolver) {
          pendingBySeq.delete(seq);
          resolver(entry);
        } else {
          deliveredBySeq.set(seq, entry);
        }
      } catch {
        // Ignore malformed line; caller fails closed on timeout if needed.
      }
    }
    stopPollingIfIdle();
  };

  const ensurePolling = (): void => {
    if (!resultsPath || pollTimer !== undefined) return;
    pollTimer = setInterval(drainResultsFile, 20);
    pollTimer.unref?.();
  };

  const names = new Set(tools.map(tool => tool.name));
  const server = new Server({ name: serverName, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (capturePath) {
      try { writeFileSync(capturePath, "", { mode: 0o600, flag: "wx" }); } catch { /* already created */ }
    }
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (!names.has(request.params.name)) throw new Error("unknown isolated tool");
    const seq = ++nextSeq;
    if (capturePath) {
      appendFileSync(
        capturePath,
        `${JSON.stringify({ seq, name: request.params.name, arguments: request.params.arguments ?? {} })}\n`,
        { mode: 0o600 },
      );
    }
    if (!resultsPath) {
      return new Promise<never>(() => {});
    }
    drainResultsFile();
    const immediate = deliveredBySeq.get(seq);
    if (immediate) {
      deliveredBySeq.delete(seq);
      return {
        content: [{ type: "text", text: immediate.text }],
        ...(immediate.isError ? { isError: true } : {}),
      };
    }
    const resolved = await new Promise<PendingResultEntry>(resolve => {
      pendingBySeq.set(seq, resolve);
      ensurePolling();
    });
    return {
      content: [{ type: "text", text: resolved.text }],
      ...(resolved.isError ? { isError: true } : {}),
    };
  });
  await server.connect(new StdioServerTransport());
}

export async function runCodingAgentMcpServer(
  catalogPath: string,
  capturePath?: string,
  resultsPath?: string,
): Promise<void> {
  const tools = JSON.parse(await readFile(catalogPath, "utf8")) as CodingAgentMcpTool[];
  await serveCodingAgentMcpTools(tools, "opencodex-coding-agent-tools", capturePath || undefined, resultsPath || undefined);
}

if (import.meta.main) await runCodingAgentMcpServer(process.argv[2] ?? "", process.argv[3], process.argv[4]);
