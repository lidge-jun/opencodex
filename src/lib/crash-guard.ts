import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { redactSecretString, redactUrlForLog } from "./redact";
import { sidecarBreadcrumb, activityBreadcrumb } from "./sidecar-tracker";

/**
 * Process-level safety net for the long-running proxy daemon.
 *
 * A single request can trigger an async error inside a Bun.serve streaming
 * handler (e.g. a ReadableStream `start(controller)` callback hitting an
 * unexpected upstream response shape). Without a handler, Bun's default
 * behaviour prints the raw error — shown as `(function (controller, error)
 * {"use strict"; ... TypeError: null is not an object` — and can tear down
 * the whole proxy, killing every other in-flight Codex session.
 *
 * We must NOT let one bad stream crash the daemon. These handlers:
 *   1. Append the full error + stack to `<configDir>/crash.log` so the exact
 *      fault (with the JSC `(evaluating 'x.y')` clause and file:line) is
 *      captured for a precise root-cause fix.
 *   2. Keep the process alive — the failed request is already isolated by
 *      Bun.serve; surviving is strictly better than terminating.
 */

let installed = false;

function crashLogPath(): string {
  const dir = getConfigDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort: directory usually already exists */
  }
  return join(dir, "crash.log");
}

export function formatCrashEntry(kind: string, err: unknown, promise?: unknown): string {
  const ts = new Date().toISOString();
  const detail =
    err instanceof Error
      ? `${err.name}: ${redactDiagnosticText(err.message)}\n${redactDiagnosticText(err.stack ?? "(no stack)")}`
      : typeof err === "object"
        ? redactDiagnosticText(safeStringify(err))
        : redactDiagnosticText(String(err));
  return `\n[${ts}] ${kind}\n${detail}${diagnose(err)}${diagnosePromise(promise)}${breadcrumb()}\n`;
}

/**
 * Bun surfaces some request-time stream/abort errors with only native frames
 * (`at <anonymous> (native:1:11)`), so `err.stack` alone cannot locate the
 * fault. JSC still records the true throw site on hidden own properties
 * (`sourceURL` / `originalLine` / `originalColumn`) and `Bun.inspect` renders a
 * code snippet from them — capture both so the next occurrence is pinpointable.
 */
function diagnose(err: unknown): string {
  const lines: string[] = [];
  try {
    const ctor = (err as { constructor?: { name?: string } } | null)?.constructor?.name;
    if (ctor && ctor !== "Error" && ctor !== "Object") lines.push(`  ctor: ${ctor}`);
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      const cause = e.cause;
      if (cause !== undefined) {
        lines.push(`  cause: ${redactDiagnosticText(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause))}`);
      }
      if (e.code !== undefined) lines.push(`  code: ${redactDiagnosticText(String(e.code))}`);
      // JSC hidden throw-site fields survive even when the stack is native-only.
      const sourceURL = e.sourceURL;
      const line = e.line ?? e.originalLine;
      const column = e.column ?? e.originalColumn;
      if (typeof sourceURL === "string" && sourceURL) {
        lines.push(`  origin: ${redactUrlForLog(sourceURL)}${line !== undefined ? `:${String(line)}` : ""}${column !== undefined ? `:${String(column)}` : ""}`);
      }
    }
    const stack = err instanceof Error ? err.stack ?? "" : "";
    const hasUsableStack = /\((?!native:)[^)]*:\d+:\d+\)/.test(stack);
    if (!hasUsableStack) {
      const snippet = inspectErr(err);
      if (snippet) lines.push(`  inspect:\n${snippet.split("\n").map(l => `    ${l}`).join("\n")}`);
    }
  } catch {
    /* diagnosis must never throw */
  }
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/**
 * Bun.inspect renders the JSC source snippet (with the offending line + caret)
 * for errors whose throw site is otherwise lost to native frames.
 */
function inspectErr(err: unknown): string {
  try {
    const bun = (globalThis as { Bun?: { inspect?: (v: unknown, o?: unknown) => string } }).Bun;
    if (!bun?.inspect) return "";
    return redactDiagnosticText(bun.inspect(err, { depth: 2 }).trim());
  } catch {
    return "";
  }
}

/**
 * Inspect the rejected promise itself. Bun sometimes attaches richer context to the promise object
 * than to the reason, and the rendered form helps distinguish a fetch/stream teardown from app code.
 */
function diagnosePromise(promise: unknown): string {
  if (promise === undefined) return "";
  try {
    const bun = (globalThis as { Bun?: { inspect?: (v: unknown, o?: unknown) => string } }).Bun;
    const rendered = bun?.inspect ? bun.inspect(promise, { depth: 1 }).trim() : String(promise);
    if (!rendered || rendered === "Promise { <rejected> }") return "";
    return `\n  promise: ${redactDiagnosticText(rendered.split("\n").join(" "))}`;
  } catch {
    return "";
  }
}

/**
 * Record whether a sidecar (web-search / vision) was in flight when the fault fired. A native-only
 * rejection coinciding with sidecar work is the prime suspect; this turns the correlation into a
 * logged fact instead of an inference.
 */
function breadcrumb(): string {
  try {
    const lines: string[] = [];
    const b = sidecarBreadcrumb();
    if (b.inFlight > 0 || b.lastLabel) {
      lines.push(`  sidecar: inFlight=${b.inFlight} last=${b.lastLabel || "-"} sinceMs=${b.sinceMs}`);
    }
    const a = activityBreadcrumb();
    if (a.note) lines.push(`  activity: ${a.note} sinceMs=${a.sinceMs}`);
    const fetches = recentFetches();
    if (fetches) lines.push(fetches);
    return lines.length ? `\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

let benignSuppressed = 0;
let benignLastLoggedAt = 0;
const BENIGN_LOG_INTERVAL_MS = 5 * 60_000;

/**
 * Bun raises an off-path `unhandledRejection: TypeError: null is not an object` (native-only stack)
 * whenever a streaming `fetch(..., { signal })` response body is torn down by an abort before/while
 * we read it — turn supersede, client disconnect, upstream RST. The daemon is never at risk (the
 * failed request is already isolated), the throw has no JS source location, and call-site body
 * cancellation cannot fully close the runtime-internal window. Treat this exact shape as benign:
 * keep the process alive, drop the alarmist banner, and fold repeats into a rate-limited summary so
 * crash.log stays readable for genuinely novel faults.
 */
export function isBenignAbortTeardown(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  if (err.message !== "null is not an object") return false; // bare form only (no `(evaluating …)`)
  const stack = err.stack ?? "";
  // Native-only: no JS source frame. A real app TypeError would carry a `(file:line:col)` frame.
  return !/\((?!native:)[^)]*:\d+:\d+\)/.test(stack);
}

function record(kind: string, err: unknown, promise?: unknown): void {
  if (kind === "unhandledRejection" && isBenignAbortTeardown(err)) {
    benignSuppressed++;
    const now = Date.now();
    if (now - benignLastLoggedAt < BENIGN_LOG_INTERVAL_MS) return; // fold repeats silently
    benignLastLoggedAt = now;
    const summary = `\n[${new Date(now).toISOString()}] benign-abort-teardown x${benignSuppressed}`
      + ` (Bun fetch-body abort; proxy unaffected)${diagnose(err)}${diagnosePromise(promise)}${breadcrumb()}\n`;
    benignSuppressed = 0;
    try { appendFileSync(crashLogPath(), summary); } catch { /* logging must never throw */ }
    return; // no stderr banner — this is expected noise, not a crash
  }
  const line = formatCrashEntry(kind, err, promise);
  // Always surface to stderr so foreground `ocx start` users still see it,
  // then persist for later diagnosis.
  console.error(`⚠️  ${kind} (proxy stayed up; logged to crash.log)`);
  console.error(line.trimStart());
  try {
    appendFileSync(crashLogPath(), line);
  } catch {
    /* logging must never throw */
  }
}

interface FetchTrace { url: string; at: number; origin: string; settled: boolean; rejected?: string }
const FETCH_RING_MAX = 12;
const fetchRing: FetchTrace[] = [];
let fetchInstrumented = false;

/**
 * The recurring native-only rejection carries no source location, and every JS `await fetch(...)`
 * is already try/caught — so the offending promise is created INSIDE Bun's fetch and rejects off the
 * awaited path. Wrap global fetch to record each call's origin (a JS stack captured at call time) and
 * whether it later rejected. crash-guard then dumps the still-pending / recently-rejected fetches so
 * the next fault names the exact call site Bun lost.
 */
function instrumentFetch(): void {
  if (fetchInstrumented) return;
  const g = globalThis as { fetch?: typeof fetch };
  const original = g.fetch;
  if (typeof original !== "function") return;
  fetchInstrumented = true;
  g.fetch = function instrumentedFetch(this: unknown, ...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    let url = "";
    try {
      const input = args[0];
      url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request)?.url ?? "";
    } catch { /* best-effort */ }
    const origin = (new Error().stack ?? "").split("\n").slice(2, 5).map(l => l.trim()).join(" <- ");
    const trace: FetchTrace = { url: redactUrlForLog(url), at: Date.now(), origin, settled: false };
    fetchRing.push(trace);
    if (fetchRing.length > FETCH_RING_MAX) fetchRing.shift();
    let p: ReturnType<typeof fetch>;
    try {
      p = original.apply(this, args);
    } catch (e) {
      trace.settled = true;
      trace.rejected = redactDiagnosticText(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      throw e;
    }
    return p.then(
      r => { trace.settled = true; return r; },
      e => { trace.settled = true; trace.rejected = redactDiagnosticText(e instanceof Error ? `${e.name}: ${e.message}` : String(e)); throw e; },
    );
  } as typeof fetch;
}

/** Render the recent fetch ring (pending first) for the crash breadcrumb. */
function recentFetches(): string {
  try {
    if (fetchRing.length === 0) return "";
    const now = Date.now();
    const rows = fetchRing.slice(-6).map(f => {
      const state = !f.settled ? "PENDING" : f.rejected ? `REJECTED(${f.rejected})` : "ok";
      return `    [${state}] ${f.url} ageMs=${now - f.at}${!f.settled ? ` origin=${f.origin}` : ""}`;
    });
    return `  fetches:\n${rows.join("\n")}`;
  } catch {
    return "";
  }
}

function redactDiagnosticText(value: string): string {
  return redactSecretString(value);
}

/**
 * Register global handlers that keep the proxy alive and capture full stacks.
 * Idempotent: safe to call more than once.
 */
export function installCrashGuards(): void {
  if (installed) return;
  installed = true;
  instrumentFetch();

  process.on("unhandledRejection", (reason, promise) => {
    record("unhandledRejection", reason, promise);
  });

  process.on("uncaughtException", err => {
    record("uncaughtException", err);
  });
}
