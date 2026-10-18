// Preloaded into the Perch CLI's node process (`node --import`) by the perch-cli adapter.
// Plain JS: it runs under the user's Node, not OpenCodex's Bun.
//
// 1. Drops Perch's turn uploads. `perch run` POSTs the whole turn (prompt, events and the
//    contextSnapshot rows, i.e. the client's instructions and replayed conversation) to
//    /api/perch-terminal/cli-turn every 20 s and again before it prints its result, then sends
//    /cli-learning to derive account memories. The final upload alone held the result back for
//    1.5-12 s in measurements. Both are answered locally with a 200; model calls are untouched.
// 2. Mirrors model-call SSE deltas (`answer_delta`, `reasoning_delta`) and each call's served model
//    to the fd named by OCX_PERCH_STREAM_FD as NDJSON, so the adapter can stream before the CLI
//    exits. Any failure disables the mirror; the CLI's own copy of the stream is never altered.
// 3. Serves Perch's public default-model document, /cli-context and /account lookups from short
//    caches, and leaves the account's durable memories out of every turn (see below).
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const DROPPED = /\/api\/perch-terminal\/(?:cli-turn|cli-learning)(?:[/?#]|$)/;
const DEFAULT_MODEL = /\/api\/perch-terminal\/public-model-default(?:[?#]|$)/;
const CLI_CONTEXT = /\/api\/perch-terminal\/cli-context(?:[?#]|$)/;
const ACCOUNT = /\/api\/perchai\/account(?:[?#]|$)/;
const MODEL_CALL = /\/api\/perch-terminal\/model-call(?:[/?#]|$)/;
const fd = Number(process.env.OCX_PERCH_STREAM_FD) || 0;
let mirrorOn = fd > 0;
const originalFetch = globalThis.fetch;

// Caches live in OCX_PERCH_CACHE_DIR, owned by OpenCodex. Entries tied to a sign-in are keyed by
// a hash of the bearer token, so another sign-in never reads them; the token itself is not stored.
const cacheDir = process.env.OCX_PERCH_CACHE_DIR;
const jsonResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
function tokenKey(input, init) {
  const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization");
  return authorization ? createHash("sha256").update(authorization).digest("hex") : undefined;
}

function readCache(name, key, maxAgeMs) {
  if (!cacheDir || !key) return undefined;
  try {
    const entry = JSON.parse(readFileSync(join(cacheDir, name), "utf8"));
    return entry.key === key && Date.now() - entry.at < maxAgeMs ? entry.value : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(name, key, value) {
  if (!cacheDir || !key) return;
  const file = join(cacheDir, name);
  const temp = `${file}.${process.pid}`;
  try {
    writeFileSync(temp, JSON.stringify({ key, at: Date.now(), value }), { mode: 0o600 });
    renameSync(temp, file);
  } catch { /* best effort: without a cache entry the CLI fetches normally */ }
}

// Perch's first request fetches the public default-model document (one global value, the same
// without sign-in) with a 3.5 s timeout, and without it runs unticketed and fails with "model is
// busy". A cold TLS connection alone took 2-2.6 s. A copy under 6 h old is served as is; an older
// one is served while a fresh one is fetched from process start. A fresh copy is not refreshed:
// a refresh racing the turn ticket for a cold connection slowed the ticket from ~0.7 s to ~4 s.
const DEFAULT_MODEL_TTL_MS = 6 * 3_600_000;
const freshDefaultModel = readCache("public-model-default.json", "public", DEFAULT_MODEL_TTL_MS);
const staleDefaultModel = freshDefaultModel ?? readCache("public-model-default.json", "public", Infinity);
const fetchedDefaultModel = process.env.OCX_PERCH_DEFAULT_MODEL_URL && !freshDefaultModel
  ? originalFetch(process.env.OCX_PERCH_DEFAULT_MODEL_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) })
    .then(response => (response.ok ? response.json() : null))
    .then(value => {
      if (value?.ok !== true) return null;
      writeCache("public-model-default.json", "public", value);
      return value;
    })
    .catch(() => null)
  : Promise.resolve(null);

// Perch POSTs /cli-context twice per turn (~1.1 s each, before and after its turn ticket) to pull the
// account's durable memories into the prompt, plus the session ids it passes along. Memories from
// Perch's own chats do not belong in a client turn, so they are always emptied; the session (user,
// workspace, org, plan ids) is cached per sign-in for an hour, so a plan change shows up at most an hour late.
const CLI_CONTEXT_TTL_MS = 3_600_000;
async function cliContext(input, init) {
  const key = tokenKey(input, init);
  const session = readCache("cli-context.json", key, CLI_CONTEXT_TTL_MS);
  if (session && typeof session === "object") return jsonResponse({ ok: true, session, permanentMemories: [], attachments: [] });
  const response = await originalFetch(input, init);
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (!response.ok || body?.ok !== true) return response;
  if (body.session && typeof body.session === "object") writeCache("cli-context.json", key, body.session);
  return jsonResponse({ ...body, permanentMemories: [], attachments: [] });
}

// GET /api/perchai/account (plan, membership, usage meter) gates the turn ticket and took 1-5 s,
// sometimes hitting Perch's own 5 s timeout. A copy under 10 min old for the same sign-in is served
// locally, so a plan change shows up at most 10 min late; the turn ticket and model-call endpoints
// still check the account server-side.
const ACCOUNT_TTL_MS = 10 * 60_000;
async function account(input, init) {
  const key = tokenKey(input, init);
  const cached = readCache("account.json", key, ACCOUNT_TTL_MS);
  if (cached) return jsonResponse(cached);
  const response = await originalFetch(input, init);
  try {
    const body = await response.clone().json();
    if (response.ok && body?.ok === true && body.session) writeCache("account.json", key, body);
  } catch { /* not JSON: pass the response through uncached */ }
  return response;
}

function send(message) {
  if (!mirrorOn) return;
  try {
    writeSync(fd, `${JSON.stringify(message)}\n`);
  } catch {
    mirrorOn = false;
  }
}

async function mirror(body) {
  send({ type: "model_call_start" });
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith("data:")) continue;
      let event;
      try { event = JSON.parse(line.slice(5)); } catch { continue; }
      if ((event?.type === "answer_delta" || event?.type === "reasoning_delta") && typeof event.text === "string") {
        send({ type: event.type, text: event.text });
      } else if (event?.type === "done") {
        send({ type: "model_call_done", model: typeof event.model === "string" ? event.model : null });
      }
    }
  }
}

globalThis.fetch = async function perchCliFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (DROPPED.test(url)) return jsonResponse({ ok: true });
  if (CLI_CONTEXT.test(url) && method === "POST") return cliContext(input, init);
  if (ACCOUNT.test(url) && method === "GET") return account(input, init);
  if (DEFAULT_MODEL.test(url) && method === "GET") {
    const value = freshDefaultModel ?? staleDefaultModel ?? await fetchedDefaultModel;
    if (value) return jsonResponse(value);
  }
  const response = await originalFetch.call(this, input, init);
  if (!mirrorOn || !MODEL_CALL.test(url) || !response.ok || !response.body) return response;
  const [forCli, forMirror] = response.body.tee();
  // A failed read ends the for-await, which cancels this branch; a mirror that stops writing keeps draining it.
  mirror(forMirror).catch(() => { mirrorOn = false; });
  return new Response(forCli, { status: response.status, statusText: response.statusText, headers: response.headers });
};
