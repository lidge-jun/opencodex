import {
  appendFileSync,
  closeSync,
  openSync,
  readSync,
  statSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const READ_CHUNK_BYTES = 64 * 1024;

export interface IncrementalResultsFs {
  statSync: (path: string) => Pick<Stats, "size" | "ino" | "birthtimeMs">;
  openSync: (path: string, flags: string) => number;
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number;
  closeSync: (fd: number) => void;
}

const DEFAULT_INCREMENTAL_FS: IncrementalResultsFs = {
  statSync,
  openSync,
  readSync,
  closeSync,
};

/**
 * Incrementally reads newline-delimited UTF-8 records from an append-only file.
 * Splits on raw `0x0a` bytes before decoding so multi-byte UTF-8 sequences split across writes
 * or read chunks are buffered intact rather than replaced with U+FFFD.
 */
export function createIncrementalResultsReader(
  resultsPath: string,
  onLine: (line: string) => void,
  fsOps: IncrementalResultsFs = DEFAULT_INCREMENTAL_FS,
): () => void {
  let byteOffset = 0;
  let lastIno: number | undefined;
  let lastBirthtimeMs: number | undefined;
  const pendingChunks: Buffer[] = [];

  const reset = (clearIdentity = false): void => {
    byteOffset = 0;
    pendingChunks.length = 0;
    if (clearIdentity) {
      lastIno = undefined;
      lastBirthtimeMs = undefined;
    }
  };

  const consumeChunk = (chunk: Buffer): void => {
    let cursor = 0;
    while (cursor < chunk.length) {
      const nlIndex = chunk.indexOf(0x0a, cursor);
      if (nlIndex === -1) {
        // Copy the trailing partial line because `chunk` aliases the reusable read buffer.
        pendingChunks.push(Buffer.from(chunk.subarray(cursor)));
        break;
      }
      const segment = chunk.subarray(cursor, nlIndex);
      let lineText: string;
      if (pendingChunks.length > 0) {
        pendingChunks.push(segment);
        lineText = Buffer.concat(pendingChunks).toString("utf8");
        pendingChunks.length = 0;
      } else {
        lineText = segment.toString("utf8");
      }
      onLine(lineText);
      cursor = nlIndex + 1;
    }
  };

  return (): void => {
    let stat: Pick<Stats, "size" | "ino" | "birthtimeMs">;
    try {
      stat = fsOps.statSync(resultsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        reset(true);
      }
      return;
    }

    // Windows filesystems can report `ino === 0`; treat `0 === 0` as absent rather than identical or changed.
    const inoChanged =
      lastIno !== undefined && (stat.ino !== 0 || lastIno !== 0) && stat.ino !== lastIno;
    const birthtimeChanged =
      lastBirthtimeMs !== undefined &&
      (stat.birthtimeMs !== 0 || lastBirthtimeMs !== 0) &&
      stat.birthtimeMs !== lastBirthtimeMs;
    if (stat.size < byteOffset || inoChanged || birthtimeChanged) {
      reset();
    }
    lastIno = stat.ino;
    lastBirthtimeMs = stat.birthtimeMs;

    if (stat.size <= byteOffset) return;

    let fd: number;
    try {
      fd = fsOps.openSync(resultsPath, "r");
    } catch {
      return;
    }
    try {
      const scratch = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, stat.size - byteOffset));
      while (byteOffset < stat.size) {
        const toRead = Math.min(scratch.length, stat.size - byteOffset);
        const bytesRead = fsOps.readSync(fd, scratch, 0, toRead, byteOffset);
        if (bytesRead <= 0) break;
        byteOffset += bytesRead;
        consumeChunk(scratch.subarray(0, bytesRead));
      }
    } catch {
      // Ignore transient read errors; the next poll resumes from the last committed byteOffset.
    } finally {
      try {
        fsOps.closeSync(fd);
      } catch {
        // Ignore close errors on cleanup.
      }
    }
  };
}

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
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const stopPollingIfIdle = (): void => {
    if (pendingBySeq.size === 0 && pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const processResultLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line) return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const rec = parsed as Record<string, unknown>;
      const seq = rec.seq;
      if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= 0) return;
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
  };

  const readIncrementalResults = resultsPath
    ? createIncrementalResultsReader(resultsPath, processResultLine)
    : undefined;

  const drainResultsFile = (): void => {
    if (!readIncrementalResults) return;
    readIncrementalResults();
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
