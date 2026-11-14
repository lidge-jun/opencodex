import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileStreamed } from "../../config/atomic-write";
import { parseJsonc } from "../../lib/jsonc";
import type { GatewayClientContext, GatewayOverride } from "./types";

export const GATEWAY_PLACEHOLDER_KEY = "opencodex-local";

export const sha256 = (bytes: Uint8Array | Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function readBytes(path: string): Buffer | null {
  try { return readFileSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Atomic byte-exact write that follows a dotfile symlink and keeps the old permission bits. */
export function writeBytes(path: string, bytes: Uint8Array, createMode = 0o644): void {
  let mode: number | undefined;
  try { mode = statSync(path).mode & 0o777; } catch { mode = undefined; }
  atomicWriteFileStreamed(path, fd => { writeFileSync(fd, bytes); });
  if (process.platform !== "win32") {
    try { chmodSync(path, mode ?? createMode); } catch { /* best effort */ }
  }
}

/** Create `dir` (and parents); returns the directories that did not exist before, outermost first. */
export function mkdirTracked(dir: string): string[] {
  const created: string[] = [];
  for (let cur = dir; !existsSync(cur); cur = dirname(cur)) created.unshift(cur);
  mkdirSync(dir, { recursive: true });
  return created;
}

/** Remove the directories this connector created, deepest first, only while empty. */
export function rmdirsIfEmpty(dirs: readonly string[]): void {
  for (const dir of [...dirs].reverse()) {
    try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* gone or not empty */ }
  }
}

export const removeFile = (path: string): void => rmSync(path, { force: true });

export function stashPath(ctx: GatewayClientContext, id: string): string {
  return join(ctx.stateDir, "gateway-clients", `${id}.json`);
}

export function readStash<T>(ctx: GatewayClientContext, id: string): T | null {
  const bytes = readBytes(stashPath(ctx, id));
  if (!bytes) return null;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as { version?: number } & T;
    return value && value.version === 1 ? value : null;
  } catch { return null; }
}

export function writeStash(ctx: GatewayClientContext, id: string, value: object): void {
  const path = stashPath(ctx, id);
  mkdirSync(dirname(path), { recursive: true });
  writeBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600);
}

export const dropStash = (ctx: GatewayClientContext, id: string): void => removeFile(stashPath(ctx, id));

export const normalizeUrl = (url: unknown): string => typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";

/** Where an organisation's admin_settings.json lives (Google's enterprise gateway docs). */
export function adminSettingsPath(ctx: GatewayClientContext): string | undefined {
  if (ctx.adminSettingsPath) return ctx.adminSettingsPath;
  if (ctx.platform === "win32") {
    const base = ctx.env.ProgramData;
    return base ? join(base, "Antigravity", "admin_settings.json") : undefined;
  }
  return ctx.platform === "darwin"
    ? "/Library/Application Support/Antigravity/admin_settings.json"
    : "/etc/antigravity/admin_settings.json";
}

/** What admin_settings.json sets under `gateway`, or null when nothing. */
export function adminGatewayOverride(ctx: GatewayClientContext): GatewayOverride | null {
  const path = adminSettingsPath(ctx);
  if (!path) return null;
  const bytes = readBytes(path);
  if (!bytes) return null;
  let gateway: unknown;
  try { gateway = (parseJsonc(bytes.toString("utf8")) as { gateway?: unknown } | null)?.gateway; }
  catch { return { source: "admin_settings", code: "admin-unreadable", detail: "admin_settings.json exists but could not be read, so its gateway settings are unknown" }; }
  if (!gateway || typeof gateway !== "object" || Object.keys(gateway).length === 0) return null;
  return { source: "admin_settings", code: "admin-gateway", detail: "organization admin_settings.json sets the gateway and wins over the user settings and AGY_LLM_GATEWAY_* variables" };
}

/** The env override, or null. Only the environment of the process OpenCodex runs in is visible. */
export function envGatewayOverride(ctx: GatewayClientContext, targetUrl?: string): GatewayOverride | null {
  const raw = ctx.env.AGY_LLM_GATEWAY_URL?.trim();
  if (!raw) return null;
  if (targetUrl && normalizeUrl(raw) === normalizeUrl(targetUrl)) return null;
  let shown = "an unparseable value";
  try { shown = new URL(raw).origin; } catch { /* keep generic */ }
  return { source: "env", code: "env-gateway", detail: `AGY_LLM_GATEWAY_URL is set to ${shown} in the environment OpenCodex sees (other shells are not checked) and wins over ~/.antigravity/settings.json` };
}
