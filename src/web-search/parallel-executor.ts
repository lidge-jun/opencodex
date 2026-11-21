import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { signalWithTimeout } from "../lib/abort";
import { packageVersion } from "../lib/package-version";
import { sidecarEnter } from "../lib/sidecar-tracker";
import type { SidecarOutcome } from "./executor";
import { MAX_SIDECAR_STREAM_BYTES } from "./parse";
import { appendSafeWebSearchSource } from "./sources";

const MCP_URL = "https://mcp.parallel.ai/mcp";
const MAX_RESULTS = 5;
const MAX_EXCERPT_CHARS = 1_000;
const version = packageVersion("");

function failure(error: string): SidecarOutcome {
  return { text: "", sources: [], error };
}

function mapSearchResult(payload: unknown): SidecarOutcome {
  if (!payload || typeof payload !== "object" || !("results" in payload) || !Array.isArray(payload.results)) {
    return failure("Parallel MCP returned invalid search results");
  }
  const sources: SidecarOutcome["sources"] = [];
  const lines: string[] = [];
  for (const result of payload.results) {
    if (!appendSafeWebSearchSource(sources, result)) continue;
    const source = sources[sources.length - 1]!;
    const excerpt = Array.isArray(result.excerpts)
      ? result.excerpts.find((value: unknown) => typeof value === "string" && value.trim())
      : undefined;
    const text = typeof excerpt === "string" ? excerpt.trim().slice(0, MAX_EXCERPT_CHARS) : "(no excerpt)";
    lines.push(`- ${source.title ?? source.url}: ${text} [${source.url}]`);
    if (sources.length === MAX_RESULTS) break;
  }
  if (sources.length === 0) return failure("Parallel MCP returned no usable search results");
  return { text: `Search results (untrusted web content):\n${lines.join("\n")}`, sources };
}

export async function runParallelWebSearch(
  query: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<SidecarOutcome> {
  const deadline = signalWithTimeout(timeoutMs, abortSignal);
  const byteLimit = new AbortController();
  const signal = AbortSignal.any([deadline.signal, byteLimit.signal]);
  const client = new Client({ name: "opencodex", version });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { "User-Agent": version ? `opencodex/${version}` : "opencodex" } },
    fetch: async (url, init) => {
      if (String(url) !== MCP_URL) throw new Error("Unexpected Parallel MCP destination");
      const signals = [signal];
      if (init?.signal) signals.push(init.signal);
      if (init?.method === "DELETE") signals.push(AbortSignal.timeout(1_000));
      const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
      if (!response.body) return response;
      let received = 0;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > MAX_SIDECAR_STREAM_BYTES) {
            const error = new Error("Parallel MCP response exceeded the byte limit");
            byteLimit.abort(error);
            controller.error(error);
          } else {
            controller.enqueue(chunk);
          }
        },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  const exit = sidecarEnter("web-search");
  try {
    const options = { signal, timeout: timeoutMs };
    await client.connect(transport, options);
    const result = await client.callTool({
      name: "web_search",
      arguments: { objective: query, search_queries: [query] },
    }, undefined, options);
    if (result.isError) return failure("Parallel MCP web_search failed");
    return mapSearchResult(result.structuredContent);
  } catch {
    // Server errors and SDK diagnostics may contain upstream response text.
    if (abortSignal?.aborted) return failure("Parallel MCP search canceled");
    if (byteLimit.signal.aborted) return failure("Parallel MCP response exceeded the byte limit");
    if (deadline.signal.aborted) return failure("Parallel MCP search timed out");
    return failure("Parallel MCP request failed");
  } finally {
    try {
      if (!signal.aborted) await transport.terminateSession();
    } catch {
      // A cleanup failure does not replace the tool outcome.
    } finally {
      await client.close();
      deadline.cleanup();
      exit();
    }
  }
}
