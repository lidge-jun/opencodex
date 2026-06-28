import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config";
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
      ? `${err.name}: ${err.message}\n${err.stack ?? "(no stack)"}`
      : typeof err === "object"
        ? safeStringify(err)
        : String(err);
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
        lines.push(`  cause: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`);
      }
      if (e.code !== undefined) lines.push(`  code: ${String(e.code)}`);
      // JSC hidden throw-site fields survive even when the stack is native-only.
      const sourceURL = e.sourceURL;
      const line = e.line ?? e.originalLine;
      const column = e.column ?? e.originalColumn;
      if (typeof sourceURL === "string" && sourceURL) {
        lines.push(`  origin: ${sourceURL}${line !== undefined ? `:${String(line)}` : ""}${column !== undefined ? `:${String(column)}` : ""}`);
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
    return bun.inspect(err, { depth: 2 }).trim();
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
    return `\n  promise: ${rendered.split("\n").join(" ")}`;
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

function record(kind: string, err: unknown, promise?: unknown): void {
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

/**
 * Register global handlers that keep the proxy alive and capture full stacks.
 * Idempotent: safe to call more than once.
 */
export function installCrashGuards(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason, promise) => {
    record("unhandledRejection", reason, promise);
  });

  process.on("uncaughtException", err => {
    record("uncaughtException", err);
  });
}
