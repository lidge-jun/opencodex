import { isValidModelDiscoveryModelId } from "../../providers/model-discovery-limits";
import type { CodeBuddyProfile } from "./profiles";

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_MODELS = 128;

export type CodeBuddyModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: "http" | "timeout" | "invalid_output" | "empty" | "too_large"; status?: number };

export interface CodeBuddyConfigFetchDeps {
  /** Test seam for the outbound request; defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type CodeBuddyModelsFetcher = (profile: CodeBuddyProfile, apiKey: string) => CodeBuddyModelsResult | Promise<CodeBuddyModelsResult>;
let codeBuddyModelsFetcherForTests: CodeBuddyModelsFetcher | null = null;

export function setFetchCodeBuddyModelsForTests(next: CodeBuddyModelsFetcher | null): void {
  codeBuddyModelsFetcherForTests = next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The product gateway authenticates the X-API-Key and then requires a User-Agent it can parse a
// client version from: a bare default fetch/axios UA answers 400 {"code":12403,"msg":"check ua,
// get coding copilot version error"} (measured 260923 on www.codebuddy.cn and
// copilot.tencent.com). The CLI's own UA shape is `CLI/<version> CodeBuddy/<version>`; the
// version VALUE is not validated (CLI/0.0.1 measures fine), so a fixed recent shape is stable
// until the vendor tightens it — and a rejection then degrades through the same failure path as
// any other discovery failure.
const CLI_USER_AGENT = "CLI/2.126.0 CodeBuddy/2.126.0";

/**
 * Read at most `cap` bytes of an untrusted upstream body, then stop reading. A body that
 * would cross the cap is cancelled at the reader the moment the crossing chunk arrives, so a
 * malformed or compromised upstream cannot make discovery buffer an unbounded response (the
 * same contract as the vision sidecar's bounded error-body read).
 */
async function readBoundedBodyText(res: Response, cap: number): Promise<
  | { ok: true; text: string }
  | { ok: false; reason: "exceeded" | "read" }
> {
  if (!res.body) return { ok: true, text: "" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (seen + value.byteLength > cap) {
        try { void reader.cancel("CodeBuddy config body byte limit reached").catch(() => undefined); }
        catch { /* best-effort body teardown */ }
        return { ok: false, reason: "exceeded" };
      }
      seen += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return { ok: true, text: out };
  } catch {
    return { ok: false, reason: "read" };
  }
}

/** A declared Content-Length above the cap is refused before a single byte is read. */
function declaredLengthExceeds(response: Response, cap: number): boolean {
  const declared = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(declared) && declared > cap;
}

/**
 * Parse the key-scoped roster out of the product configuration envelope.
 *
 * `GET {canonicalBaseUrl}/v3/config` with the configured key answers the KEY's own account
 * configuration: `data.agents[].models` is exactly the roster the CLI's `--help` prints for a
 * signed-in account of that key (measured 260923: 17 ids, byte-identical), and `data.models`
 * carries per-model metadata for the wider account catalog. An absent or invalid key answers
 * the anonymous envelope instead — no `agents` array and an empty `models` list — so the roster
 * is proven to belong to the key by construction: it only exists when the key authenticated.
 * `custom:*` selectors are per-user CLI configuration pointing at operator-defined upstreams,
 * not shared catalog rows, and are excluded.
 */
export function parseCodeBuddyConfigRoster(body: unknown): CodeBuddyModelsResult {
  if (!isPlainObject(body)) return { ok: false, error: "invalid_output" };
  const data = body.data;
  if (!isPlainObject(data)) return { ok: false, error: "invalid_output" };
  const agents = data.agents;
  if (!Array.isArray(agents)) {
    // The authenticated envelope always carries an agents array; the anonymous one (absent or
    // invalid key) does not. Both fail closed here, but the distinction names the cause.
    return { ok: false, error: "empty" };
  }
  // The catalog mirrors what the CLI itself accepts for --model: the default agent's models.
  // agents has carried exactly one entry named "cli" so far; prefer it by name and fall back to
  // the first agent that declares a models array, so a future second agent cannot silently
  // widen the roster beyond what the chat path can actually run.
  const agent = agents.find(entry => isPlainObject(entry) && entry.name === "cli" && Array.isArray(entry.models))
    ?? agents.find(entry => isPlainObject(entry) && Array.isArray(entry.models));
  const declared = isPlainObject(agent) && Array.isArray(agent.models) ? agent.models : [];
  const models: string[] = [];
  const seen = new Set<string>();
  for (const raw of declared) {
    const id = typeof raw === "string" ? raw : isPlainObject(raw) && typeof raw.id === "string" ? raw.id : undefined;
    if (!id || id.startsWith("custom:") || seen.has(id) || !isValidModelDiscoveryModelId(id)) continue;
    seen.add(id);
    models.push(id);
    if (models.length >= MAX_MODELS) break;
  }
  return models.length > 0 ? { ok: true, models } : { ok: false, error: "empty" };
}

/**
 * Discover the roster that belongs to this exact key from the product configuration endpoint.
 *
 * The previous design parsed `codebuddy --help`, whose roster reflects the CLI's signed-in
 * account under the caller's home — a key of a different account (or a wrong key) still
 * observed the signed-in account's roster, so caching it under the key's fingerprint could
 * advertise another account's models for that key (review on #5147). The configuration request
 * authenticates with the key itself, so the roster it returns is the key's own: the CLI binary,
 * its login state, and the caller's home are all irrelevant to the answer. Measured 260923
 * against www.codebuddy.cn (CN): a valid key answers `data.agents[0].models` with the same 17
 * ids the CLI prints when signed in to that account; an invalid or absent key answers the
 * anonymous envelope with no agents and no models.
 */
export async function fetchCodeBuddyModels(
  profile: CodeBuddyProfile,
  apiKey: string,
  deps: CodeBuddyConfigFetchDeps = {},
): Promise<CodeBuddyModelsResult> {
  if (codeBuddyModelsFetcherForTests) return codeBuddyModelsFetcherForTests(profile, apiKey);
  const url = `${profile.canonicalBaseUrl}/v3/config`;
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": CLI_USER_AGENT,
    "X-API-Key": apiKey,
    "X-Requested-With": "XMLHttpRequest",
  };
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(url, {
      headers,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 8_000),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "http" };
  }
  if (response.status !== 200) {
    try { void response.body?.cancel().catch(() => undefined); }
    catch { /* best-effort body teardown */ }
    return { ok: false, error: "http", status: response.status };
  }
  if (declaredLengthExceeds(response, MAX_CONFIG_BYTES)) {
    try { void response.body?.cancel("CodeBuddy config body byte limit reached").catch(() => undefined); }
    catch { /* best-effort body teardown */ }
    return { ok: false, error: "too_large" };
  }
  const body = await readBoundedBodyText(response, MAX_CONFIG_BYTES);
  if (!body.ok) {
    return body.reason === "exceeded"
      ? { ok: false, error: "too_large" }
      : { ok: false, error: "http" };
  }
  try {
    return parseCodeBuddyConfigRoster(JSON.parse(body.text) as unknown);
  } catch {
    return { ok: false, error: "invalid_output" };
  }
}
