import { buildMetadata } from "../adapters/devin/cloud-direct/metadata";
import { encodeMessage, encodeString, encodeVarintField, iterFields } from "../adapters/devin/cloud-direct/wire";
import { cancelBodyOnAbort } from "../lib/abort";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { redactSecretString } from "../lib/redact";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { getValidAccessTokenSnapshot, publicOAuthAuthenticationErrorMessage, type OAuthAccessSnapshot } from "../oauth";
import { captureOAuthAccountSelection, commitOAuthAccountSelection } from "../oauth/store";
import { resolveDevinApiBaseUrl } from "../oauth/devin/api-base";
import type { SidecarOutcome } from "./executor";
import { MAX_SIDECAR_RESPONSE_BYTES, type WebSearchSource } from "./parse";
import { safeWebSearchSources } from "./sources";

const DEVIN_WEB_SEARCH_PATH = "/exa.api_server_pb.ApiServerService/GetWebSearchResults";
const DEVIN_WEB_SEARCH_RESULTS = 5;
const DEVIN_WEB_SEARCH_SNIPPET_CHARS = 2_000;

interface DevinSearchResult extends WebSearchSource {
  snippet?: string;
}

function assertCompleteProtobuf(buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    const readVarint = (): bigint => {
      let value = 0n;
      for (let shift = 0n; shift < 70n; shift += 7n) {
        if (offset >= buf.length) throw new Error("truncated varint");
        const byte = buf[offset++]!;
        value |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return value;
      }
      throw new Error("overlong varint");
    };
    const tag = readVarint();
    const wire = Number(tag & 7n);
    if (tag >> 3n === 0n) throw new Error("invalid field number");
    if (wire === 0) readVarint();
    else if (wire === 1) offset += 8;
    else if (wire === 2) {
      const length = Number(readVarint());
      if (!Number.isSafeInteger(length)) throw new Error("invalid field length");
      offset += length;
    } else if (wire === 5) offset += 4;
    else throw new Error("unsupported wire type");
    if (offset > buf.length) throw new Error("truncated field");
  }
}

function fields(buf: Buffer): ReturnType<typeof iterFields> {
  assertCompleteProtobuf(buf);
  return iterFields(buf);
}

function decodeText(value: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}

function chunkText(chunk: Buffer): string | undefined {
  for (const field of fields(chunk)) {
    if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) return decodeText(field.value);
    if (field.num === 3 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      for (const markdownField of fields(field.value)) {
        if (markdownField.num === 2 && markdownField.wire === 2 && Buffer.isBuffer(markdownField.value)) {
          return decodeText(markdownField.value);
        }
      }
    }
  }
  return undefined;
}

function parseResult(buf: Buffer): DevinSearchResult | undefined {
  let url: string | undefined;
  let title: string | undefined;
  let text: string | undefined;
  let summary: string | undefined;
  const chunks: string[] = [];
  for (const field of fields(buf)) {
    if (field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    if (field.num === 2) text = decodeText(field.value);
    else if (field.num === 3) url = decodeText(field.value);
    else if (field.num === 4) title = decodeText(field.value);
    else if (field.num === 6) {
      const chunk = chunkText(field.value);
      if (chunk) chunks.push(chunk);
    } else if (field.num === 7) summary = decodeText(field.value);
  }
  if (!url) return undefined;
  const snippet = (summary || text || chunks.join("\n")).trim().slice(0, DEVIN_WEB_SEARCH_SNIPPET_CHARS);
  return { url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) };
}

/** Map Cognition's GetWebSearchResults protobuf response to the shared search outcome. */
export function mapDevinWebSearchResponse(buf: Buffer): SidecarOutcome {
  const parsed: DevinSearchResult[] = [];
  let summary = "";
  for (const field of fields(buf)) {
    if (field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    if (field.num === 1) {
      const result = parseResult(field.value);
      if (result) parsed.push(result);
    } else if (field.num === 3) {
      summary = decodeText(field.value)?.trim().slice(0, DEVIN_WEB_SEARCH_SNIPPET_CHARS) ?? "";
    }
  }
  const sources = safeWebSearchSources(parsed);
  if (sources.length === 0) return { text: "", sources: [], error: "devin web search returned no results" };
  const byUrl = new Map(parsed.map(result => [result.url, result]));
  const lines = sources.map(source => {
    const result = byUrl.get(source.url);
    return `- ${source.title ?? source.url}: ${result?.snippet || "(no excerpt)"} [${source.url}]`;
  });
  return { text: [summary, `Search results:\n${lines.join("\n")}`].filter(Boolean).join("\n\n"), sources };
}

/** Resolve one account snapshot for an entire alpha/search request. */
export async function resolveDevinWebSearchSnapshot(
  providerName: string,
): Promise<{ snapshot: OAuthAccessSnapshot } | { error: string }> {
  const credentialProvider = providerName === "devin-cli" ? "devin" : providerName;
  try {
    const selection = captureOAuthAccountSelection(credentialProvider);
    if (!selection) return { error: "devin web search auth failed: no signed-in account" };
    const snapshot = await getValidAccessTokenSnapshot(credentialProvider);
    const committed = await commitOAuthAccountSelection(credentialProvider, snapshot.accountId, {
      expectedSelection: selection,
      expectedCredentialGeneration: snapshot.generation,
      requireUsableAccount: true,
    });
    return committed ? { snapshot } : { error: "devin web search auth changed; retry the request" };
  } catch (error) {
    return { error: `devin web search auth failed: ${publicOAuthAuthenticationErrorMessage(error)}` };
  }
}

/** Execute one search through the signed-in Devin/Cognition account. */
export async function runDevinWebSearch(
  query: string,
  snapshot: OAuthAccessSnapshot,
  abortSignal: AbortSignal,
): Promise<SidecarOutcome> {
  const apiServerUrl = resolveDevinApiBaseUrl(snapshot.apiBaseUrl);
  const metadata = buildMetadata({
    apiKey: snapshot.accessToken,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  });
  const body = Buffer.concat([
    encodeMessage(1, metadata),
    encodeString(2, query),
    encodeVarintField(3, DEVIN_WEB_SEARCH_RESULTS),
  ]);
  const sidecarExit = sidecarEnter("web-search");
  try {
    const response = await fetch(`${apiServerUrl}${DEVIN_WEB_SEARCH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
      body: new Uint8Array(body),
      signal: abortSignal,
      redirect: "error",
    });
    const detachBodyGuard = cancelBodyOnAbort(response.body, abortSignal);
    try {
      const bounded = await readBoundedResponseBytes(response, {
        maxBytes: MAX_SIDECAR_RESPONSE_BYTES,
        signal: abortSignal,
      });
      if (bounded.oversized) return { text: "", sources: [], error: "devin web search response exceeded byte bound" };
      if (!response.ok) return { text: "", sources: [], error: `devin web search HTTP ${response.status}` };
      try {
        return mapDevinWebSearchResponse(Buffer.from(bounded.bytes));
      } catch {
        return { text: "", sources: [], error: "devin web search returned malformed protobuf" };
      }
    } finally {
      detachBodyGuard();
    }
  } catch (error) {
    const kind = abortSignal.reason instanceof Error && abortSignal.reason.name === "TimeoutError"
      ? "timeout"
      : "connect_error";
    return { text: "", sources: [], error: `devin web search ${kind}: ${redactSecretString(error instanceof Error ? error.message : String(error))}` };
  } finally {
    sidecarExit();
  }
}
