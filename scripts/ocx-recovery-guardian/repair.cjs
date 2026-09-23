"use strict";

// This module deliberately produces review artifacts only. It never writes a
// suggested replacement back into the repository.
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MODEL = "glm-5.3-flash";
const DEADLINE_MS = 90_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024;
const MAX_REPLACEMENT_BYTES = 32 * 1024;
const MAX_PATCHES = 3;
const ALLOWLIST = Object.freeze([
  "src/lib/runtime-diagnostics.ts",
  "src/lib/runtime-diagnostics-child.ts",
  "src/responses/state.ts",
  "src/codex/user-identity.ts",
  "scripts/windows-visible-proxy.ps1",
  "src/tray/windows-tray.ps1",
]);
const ALLOWED_REASONS = new Set([
  "event_loop_delay", "heartbeat_missing", "health_not_ready", "unexpected_exit", "manual_review", "unknown",
]);
const SENSITIVE = /(?:authorization\s*[:=]|bearer\s+[a-z0-9._~+\-/=]{8,}|(?:api[_-]?key|access[_-]?token|secret|password|credential)\s*[:=]|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\.env\b|userprofile|appdata|home(?:dir)?\s*[:=])/i;
const SOURCE_SENSITIVE_LINE = /(?:authorization|bearer|(?:api[_-]?key|access[_-]?token|secret|password|credential)|\.env\b|userprofile|appdata|profile|home(?:dir)?|(?:[a-z]:\\|\/)users[\\/])/i;

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sanitizeIncident(incident) {
  const input = incident && typeof incident === "object" ? incident : {};
  const reason = typeof input.reason === "string" && ALLOWED_REASONS.has(input.reason) ? input.reason : "unknown";
  const timing = {};
  const rawTiming = input.timing && typeof input.timing === "object" && !Array.isArray(input.timing) ? input.timing : {};
  for (const name of ["delayMs", "heartbeatGapMs", "elapsedMs", "durationMs", "observedAtMs"]) {
    const value = safeInteger(rawTiming[name]);
    if (value !== undefined) timing[name] = value;
  }
  const output = { reason, healthReady: input.healthReady === true, attempts: safeInteger(input.attempts) ?? 0, timing };
  const pid = safeInteger(input.pid);
  if (pid !== undefined) output.pid = pid;
  return output;
}

function normalizeEndpoint(value) {
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const loopback = parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port === "20128";
  const ollama = parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port === "11434";
  const mnn = parsed.protocol === "https:" && parsed.hostname === "api.mnnai.ru" && (parsed.port === "" || parsed.port === "443");
  if ((loopback || ollama || mnn) && normalizedPath === "/v1") return `${parsed.protocol}//${parsed.host}/v1`;
  return null;
}

function wireModelFor(endpoint) {
  if (endpoint === "http://127.0.0.1:11434/v1") return "glm-5.3-flash:cloud";
  if (endpoint === "http://127.0.0.1:20128/v1") return "ollama-local/glm-5.3-flash:cloud";
  return MODEL;
}

function isWithin(base, target) {
  const relative = path.relative(base, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function assertNoSymlinks(base, target) {
  if (!isWithin(base, target)) throw new Error("candidate escapes incident directory");
  let current = base;
  const pieces = path.relative(base, target).split(path.sep);
  for (const piece of pieces) {
    current = path.join(current, piece);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("candidate path contains symlink");
  }
}

function assertNoSymlinksAlong(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const piece of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("path contains symlink");
  }
}

function redactSource(text) {
  const lines = text.split(/(?<=\n)/u);
  return lines.map(line => SOURCE_SENSITIVE_LINE.test(line) ? "[REDACTED_SENSITIVE_SOURCE_LINE]\n" : line).join("");
}

function truncateUtf8(text, limit) {
  if (Buffer.byteLength(text) <= limit) return text;
  let truncated = Buffer.from(text, "utf8").subarray(0, limit).toString("utf8");
  while (Buffer.byteLength(truncated) > limit) truncated = truncated.slice(0, -1);
  return truncated;
}

function sourceSnapshot(projectRoot) {
  const root = fs.realpathSync(projectRoot);
  const entries = [];
  const perSourceBytes = Math.floor(MAX_SOURCE_BYTES / ALLOWLIST.length);
  for (const relativePath of ALLOWLIST) {
    const absolute = path.resolve(root, relativePath);
    if (!isWithin(root, absolute) || !fs.existsSync(absolute) || fs.lstatSync(absolute).isSymbolicLink()) continue;
    const original = fs.readFileSync(absolute, "utf8");
    const sanitized = redactSource(original);
    // Every supplied file gets context; no large first file can consume the
    // complete disclosure budget.
    const snippet = truncateUtf8(sanitized, perSourceBytes);
    entries.push({ relativePath, absolute, original, hash: sha256(original), snippet });
  }
  return { root, entries };
}

function promptFor(incident, sources) {
  return [
    "You are producing a review-only candidate for a local recovery incident.",
    "Return one JSON object only (no markdown/fences): {\"diagnosis\":string,\"patches\":[{\"path\":string,\"find\":string,\"replace\":string}] }.",
    "If bounded evidence does not justify a patch, return {\"diagnosis\":\"brief bounded explanation\",\"patches\":[]} exactly in that shape.",
    "Do not emit markdown, tools, shell commands, credentials, paths outside the supplied repository-relative allowlist, or an executable instruction.",
    "Use only exact model glm-5.3-flash. Patches are candidates only and will not be applied automatically.",
    `Incident: ${JSON.stringify(incident)}`,
    "Approved source snippets (some sensitive lines were redacted):",
    JSON.stringify(sources.map(entry => ({ path: entry.relativePath, content: entry.snippet }))),
  ].join("\n");
}

async function readBoundedBody(response, signal) {
  if (!response || !response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  const abort = () => { void reader.cancel(); };
  if (signal) signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal && signal.aborted) throw Object.assign(new Error("response cancelled"), { name: "AbortError" });
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* bounded cancellation only */ }
        const error = new Error("response too large");
        error.code = "RESPONSE_TOO_LARGE";
        throw error;
      }
      chunks.push(next.value);
    }
  } finally {
    if (signal) signal.removeEventListener("abort", abort);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function responseContent(text) {
  let outer;
  try { outer = JSON.parse(text); } catch { throw Object.assign(new Error("response JSON invalid"), { code: "RESPONSE_JSON" }); }
  const content = outer && outer.choices && outer.choices[0] && outer.choices[0].message && outer.choices[0].message.content;
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error("model content invalid"), { code: "MODEL_OUTPUT_INVALID" });
  }
  let candidate;
  try { candidate = JSON.parse(content); } catch { throw Object.assign(new Error("model JSON invalid"), { code: "MODEL_OUTPUT_INVALID" }); }
  return candidate;
}

function uniqueIndex(text, needle) {
  if (!needle) return -1;
  const first = text.indexOf(needle);
  return first >= 0 && text.indexOf(needle, first + needle.length) < 0 ? first : -1;
}

function validateModelOutput(output, snapshots) {
  if (!output || typeof output !== "object" || Array.isArray(output) || typeof output.diagnosis !== "string"
    || !Array.isArray(output.patches) || output.patches.length > MAX_PATCHES || SENSITIVE.test(output.diagnosis)
    || Object.keys(output).length !== 2 || !Object.prototype.hasOwnProperty.call(output, "diagnosis") || !Object.prototype.hasOwnProperty.call(output, "patches")) {
    throw Object.assign(new Error("model output shape invalid"), { code: "MODEL_OUTPUT_INVALID" });
  }
  const sourceByPath = new Map(snapshots.map(item => [item.relativePath, item]));
  const seen = new Set();
  const patches = [];
  for (const patch of output.patches) {
    if (!patch || typeof patch !== "object" || typeof patch.path !== "string" || typeof patch.find !== "string" || typeof patch.replace !== "string"
      || !sourceByPath.has(patch.path) || seen.has(patch.path) || !patch.find || Buffer.byteLength(patch.replace) > MAX_REPLACEMENT_BYTES
      || SENSITIVE.test(patch.find) || SENSITIVE.test(patch.replace) || Object.keys(patch).length !== 3
      || !Object.prototype.hasOwnProperty.call(patch, "path") || !Object.prototype.hasOwnProperty.call(patch, "find") || !Object.prototype.hasOwnProperty.call(patch, "replace")) {
      throw Object.assign(new Error("model patch invalid"), { code: "MODEL_OUTPUT_INVALID" });
    }
    const snapshot = sourceByPath.get(patch.path);
    const index = uniqueIndex(snapshot.original, patch.find);
    if (index < 0) throw Object.assign(new Error("model find not unique"), { code: "MODEL_OUTPUT_INVALID" });
    seen.add(patch.path);
    patches.push({ ...patch, snapshot, index, candidate: snapshot.original.slice(0, index) + patch.replace + snapshot.original.slice(index + patch.find.length) });
  }
  return patches;
}

function bundledBunPath(projectRoot) {
  const executable = process.platform === "win32" ? "bun.exe" : "bun";
  const candidate = path.resolve(projectRoot, "node_modules", "bun", "bin", executable);
  if (!isWithin(projectRoot, candidate) || !fs.existsSync(candidate)) return null;
  try {
    assertNoSymlinksAlong(candidate);
    return fs.lstatSync(candidate).isFile() ? candidate : null;
  } catch { return null; }
}

function verifySyntax(candidatePath, relativePath, projectRoot) {
  if (relativePath.endsWith(".ts")) {
    const bunPath = bundledBunPath(projectRoot);
    if (!bunPath) return { patchStatus: "needs_review", verifier: "bundled_bun_unavailable" };
    const program = "const fs=require('node:fs'); const input=fs.readFileSync(process.argv[1],'utf8'); new Bun.Transpiler({loader:'ts'}).transformSync(input);";
    const result = spawnSync(bunPath, ["-e", program, candidatePath], { stdio: "ignore", timeout: 10_000, windowsHide: true });
    return result.error ? { patchStatus: "needs_review", verifier: "bundled_bun_unavailable" }
      : result.status === 0 ? { patchStatus: "syntax_ok", verifier: "bun_transpiler" }
        : { patchStatus: "syntax_invalid", verifier: "bun_transpiler" };
  }
  if (relativePath.endsWith(".ps1")) {
    const program = "$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$t,[ref]$e)|Out-Null;if($e.Count){exit 1};exit 0";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", program, candidatePath], { stdio: "ignore", timeout: 10_000, windowsHide: true });
    return result.error ? { patchStatus: "needs_review", verifier: "powershell_parser_unavailable" }
      : result.status === 0 ? { patchStatus: "syntax_ok", verifier: "powershell_parser" }
        : { patchStatus: "syntax_invalid", verifier: "powershell_parser" };
  }
  return { patchStatus: "needs_review", verifier: "unsupported_extension" };
}

function writeCandidates(incidentDir, projectRoot, patches) {
  const incidentRoot = path.resolve(incidentDir);
  assertNoSymlinksAlong(incidentRoot);
  if (!fs.statSync(incidentRoot).isDirectory()) throw Object.assign(new Error("incident directory invalid"), { code: "CANDIDATE_WRITE" });
  const candidateRoot = path.join(incidentRoot, "candidate");
  fs.mkdirSync(candidateRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinks(incidentRoot, candidateRoot);
  const metadata = [];
  for (const patch of patches) {
    if (sha256(fs.readFileSync(patch.snapshot.absolute, "utf8")) !== patch.snapshot.hash) {
      throw Object.assign(new Error("snapshot changed"), { code: "SNAPSHOT_CHANGED" });
    }
    const outputPath = path.resolve(candidateRoot, patch.path);
    if (!isWithin(candidateRoot, outputPath)) throw Object.assign(new Error("candidate escapes root"), { code: "CANDIDATE_WRITE" });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    assertNoSymlinks(incidentRoot, outputPath);
    try { fs.writeFileSync(outputPath, patch.candidate, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
    catch { throw Object.assign(new Error("candidate write rejected"), { code: "CANDIDATE_WRITE" }); }
    const verification = verifySyntax(outputPath, patch.path, projectRoot);
    metadata.push({ path: patch.path, snapshotSha256: patch.snapshot.hash, candidateSha256: sha256(patch.candidate), patchStatus: verification.patchStatus, verifier: verification.verifier });
  }
  const metadataPath = path.join(candidateRoot, "metadata.json");
  assertNoSymlinks(incidentRoot, metadataPath);
  try { fs.writeFileSync(metadataPath, JSON.stringify({ patches: metadata }), { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  catch { throw Object.assign(new Error("metadata write rejected"), { code: "CANDIDATE_WRITE" }); }
  return metadata;
}

function receipt(incident, fields) {
  return { version: 1, incidentSha256: sha256(JSON.stringify(incident)), model: MODEL, requestCount: fields.requestCount ?? 0, ...fields };
}

async function runRepair({ incident, projectRoot, incidentDir, endpoint, fallbackEndpoint, model = MODEL, readKey, readFallbackKey, fetchFn = fetch, signal } = {}) {
  const sanitized = sanitizeIncident(incident);
  if (model !== MODEL || typeof readKey !== "function" || typeof fetchFn !== "function" || typeof projectRoot !== "string" || typeof incidentDir !== "string") {
    return receipt(sanitized, { outcome: "failed", failureClass: "INPUT_INVALID" });
  }
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
    return receipt(sanitized, { outcome: "failed", failureClass: "INPUT_INVALID" });
  }
  if (signal && signal.aborted) return receipt(sanitized, { outcome: "cancelled", failureClass: "CANCELLED" });
  const origin = normalizeEndpoint(endpoint);
  if (!origin || !fs.existsSync(projectRoot) || !fs.existsSync(incidentDir)) return receipt(sanitized, { outcome: "failed", failureClass: "INPUT_INVALID" });
  try {
    assertNoSymlinksAlong(path.resolve(incidentDir));
    if (!fs.statSync(path.resolve(incidentDir)).isDirectory()) throw new Error("incident directory invalid");
  } catch { return receipt(sanitized, { outcome: "failed", failureClass: "SAFETY_REJECTED" }); }
  const fallbackOrigin = fallbackEndpoint === undefined ? null : normalizeEndpoint(fallbackEndpoint);
  if (fallbackEndpoint !== undefined && (!fallbackOrigin || fallbackOrigin === origin || typeof readFallbackKey !== "function")) {
    return receipt(sanitized, { outcome: "failed", failureClass: "INPUT_INVALID" });
  }
  let snapshots;
  try { snapshots = sourceSnapshot(projectRoot); } catch { return receipt(sanitized, { outcome: "failed", failureClass: "INPUT_INVALID" }); }
  if (snapshots.entries.length !== ALLOWLIST.length) return receipt(sanitized, { outcome: "failed", failureClass: "SAFETY_REJECTED" });
  const endpoints = fallbackOrigin ? [origin, fallbackOrigin] : [origin];
  let lastFailure = "NETWORK";
  let requestCount = 0;
  for (let index = 0; index < endpoints.length; index += 1) {
    if (signal && signal.aborted) return receipt(sanitized, { outcome: "cancelled", failureClass: "CANCELLED", requestCount });
    let key;
    try { key = await (index === 0 ? readKey : readFallbackKey)(); }
    catch { return receipt(sanitized, { outcome: "failed", failureClass: "AUTH_UNAVAILABLE", requestCount }); }
    if (signal && signal.aborted) return receipt(sanitized, { outcome: "cancelled", failureClass: "CANCELLED", requestCount });
    if (typeof key !== "string" || !key) return receipt(sanitized, { outcome: "failed", failureClass: "AUTH_UNAVAILABLE", requestCount });
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (signal) {
      signal.addEventListener("abort", forwardAbort, { once: true });
      if (signal.aborted) {
        forwardAbort();
        signal.removeEventListener("abort", forwardAbort);
        return receipt(sanitized, { outcome: "cancelled", failureClass: "CANCELLED", requestCount });
      }
    }
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error("repair request timed out"), { name: "AbortError" }));
      }, DEADLINE_MS);
    });
    try {
      requestCount += 1;
      const response = await Promise.race([fetchFn(`${endpoints[index]}/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: wireModelFor(endpoints[index]), stream: false, max_tokens: 4096, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "user", content: promptFor(sanitized, snapshots.entries) }] }),
        signal: controller.signal,
      }), deadline]);
      if (!response || !response.ok) {
        lastFailure = "HTTP_STATUS";
        if (index + 1 < endpoints.length) continue;
        return receipt(sanitized, { outcome: "failed", failureClass: lastFailure, requestCount });
      }
      const output = responseContent(await Promise.race([readBoundedBody(response, controller.signal), deadline]));
      const patches = validateModelOutput(output, snapshots.entries);
      if (patches.length === 0) return receipt(sanitized, { outcome: "no_candidate", diagnosis: output.diagnosis, candidateCount: 0, requestCount });
      const metadata = writeCandidates(incidentDir, snapshots.root, patches);
      return receipt(sanitized, { outcome: "candidate_ready", diagnosis: output.diagnosis, candidateCount: metadata.length, patches: metadata, requestCount });
    } catch (error) {
      if (signal && signal.aborted) return receipt(sanitized, { outcome: "cancelled", failureClass: "CANCELLED", requestCount });
      lastFailure = controller.signal.aborted || (error && error.name === "AbortError") ? "TIMEOUT" : error && error.code ? error.code : "NETWORK";
      if ((lastFailure === "NETWORK" || lastFailure === "TIMEOUT" || lastFailure === "RESPONSE_TOO_LARGE" || lastFailure === "RESPONSE_JSON")
        && index + 1 < endpoints.length) continue;
      return receipt(sanitized, { outcome: "failed", failureClass: lastFailure, requestCount });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", forwardAbort);
    }
  }
  return receipt(sanitized, { outcome: "failed", failureClass: lastFailure, requestCount });
}

module.exports = { runRepair };
