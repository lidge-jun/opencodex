import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveAgyBinary } from "../../adapters/agy-acp/binary";
import { profileNames, profileRoot, removeProfile, selectedName, selectProfile, validProfileName } from "../../adapters/agy-acp/profiles";
import { getConfigDir } from "../../config/paths";
import { desktopGuiOrigin, hasDesktopForwardingHeaders } from "../../lib/desktop-gui-origin";
import { selfLaunchArgv } from "../../lib/self-launch-argv";
import { shellQuote } from "../../service/definition";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBodyOr } from "./body";
import type { ManagementContext } from "./context";

// Open a short-lived, private Terminal document. The official CLI owns all login I/O.
async function openLoginTerminal(name: string): Promise<void> {
  const binary = resolveAgyBinary();
  if (!binary) throw new Error("agy unavailable");
  const dir = await mkdtemp(join(tmpdir(), "ocx-agy-"));
  const file = join(dir, "Antigravity.command");
  try {
    const argv = ["/usr/bin/env", "HOME=" + homedir(), "OPENCODEX_HOME=" + getConfigDir(),
      "OPENCODEX_AGY_BIN=" + binary, process.execPath,
      ...selfLaunchArgv(["account", "agy", "add", name], { sourceEntrypoint: join(import.meta.dir, "../../cli/index.ts") })];
    const script = ["#!/bin/sh", "/bin/rm -f " + shellQuote(file), "/bin/rmdir " + shellQuote(dir),
      "exec " + argv.map(shellQuote).join(" "), ""].join("\n");
    await writeFile(file, script, { flag: "wx", mode: 0o700 });
    await promisify(execFile)("/usr/bin/open", ["-b", "com.apple.Terminal", file], { timeout: 10000 });
  } catch (error) {
    await rm(dir, { force: true, recursive: true });
    throw error;
  }
}

export async function handleAgyAccounts(ctx: ManagementContext, openTerminal = openLoginTerminal, root = profileRoot()): Promise<Response> {
  const local = ctx.trustedLoopbackIngress && !hasDesktopForwardingHeaders(ctx.req)
    && desktopGuiOrigin(ctx.config, ctx.url.origin) === ctx.url.origin;
  if (!local || (ctx.principal !== "gui-session" && ctx.principal !== "admin-token")) return jsonResponse({ error: "local_only" }, 403);
  if (process.platform === "win32") return jsonResponse({ error: "posix_required" }, 400);
  const canOpenTerminal = process.platform === "darwin" && ctx.principal === "gui-session";
  const list = () => ({ names: ["default", ...profileNames(root)], selected: selectedName(), canOpenTerminal });
  if (ctx.req.method === "GET") return jsonResponse(list());
  if (ctx.req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  const body = await readManagementJsonBodyOr(ctx.req, null);
  if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string" || !("action" in body))
    return jsonResponse({ error: "invalid_request" }, 400);
  const { name, action } = body;
  if (action === "remove") {
    if (!validProfileName(name)) return jsonResponse({ error: "invalid_request" }, 400);
    removeProfile(name, getConfigDir(), root);
    return jsonResponse(list());
  }
  if (action === "use") {
    if (name !== "default" && (!validProfileName(name) || !profileNames(root).includes(name))) return jsonResponse({ error: "unknown_profile" }, 404);
    selectProfile(name, getConfigDir(), root);
    return jsonResponse(list());
  }
  if (action !== "add" || !validProfileName(name)) return jsonResponse({ error: "invalid_request" }, 400);
  if (!canOpenTerminal) return jsonResponse({ error: "terminal_unavailable" }, 403);
  if (profileNames(root).includes(name)) return jsonResponse({ error: "profile_exists" }, 409);
  try { await openTerminal(name); }
  catch { return jsonResponse({ error: "terminal_unavailable" }, 503); }
  return jsonResponse({ pending: name }, 202);
}
