import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config";

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

function formatError(kind: string, err: unknown): string {
  const ts = new Date().toISOString();
  const detail =
    err instanceof Error
      ? `${err.name}: ${err.message}\n${err.stack ?? "(no stack)"}`
      : typeof err === "object"
        ? safeStringify(err)
        : String(err);
  return `\n[${ts}] ${kind}\n${detail}\n`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function record(kind: string, err: unknown): void {
  const line = formatError(kind, err);
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

  process.on("unhandledRejection", reason => {
    record("unhandledRejection", reason);
  });

  process.on("uncaughtException", err => {
    record("uncaughtException", err);
  });
}
