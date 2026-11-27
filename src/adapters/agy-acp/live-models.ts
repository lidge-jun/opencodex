import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { baseScopedEnv } from "../coding-agent/turn";
import { classifyFrame, initializeFrame, methodNotFoundFrame, permissionCancelledFrame, sessionNewFrame } from "./acp";
import { probeAgyVersion, readAgyExecutable, resolveAgyBinary } from "./binary";
import { findSelector, isGeminiValue, parseConfigOptions } from "./options";
import { createTurnWorkspace, defaultAgyAcpSpawn, reapProcessTree, type AgyAcpChild } from "./process";
import { launchForProfile } from "./profiles";

const run = promisify(execFile);
const flights = new Map<string, Promise<string[]>>();

/** Publish only IDs that the adapter can subsequently request from this selector. */
export function catalogIds(options: unknown): string[] {
  const state = parseConfigOptions(options);
  const selector = state && findSelector(state, "model");
  if (!selector?.ok) return [];
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const item of selector.selector.values.filter(isGeminiValue)) {
    if (!/^gemini[-.][a-z0-9][a-z0-9.-]{0,126}$/i.test(item.value)) continue;
    if (seen.has(item.value)) ambiguous.add(item.value);
    seen.add(item.value);
  }
  return [...seen].filter(id => !ambiguous.has(id));
}

/** Read session/new and stop before session/prompt. Never accept client tool requests. */
function readCatalog(child: AgyAcpChild, cwd: string): Promise<string[]> {
  return new Promise(resolve => {
    let expected = 1;
    let buffer = "";
    let bytes = 0;
    let done = false;
    const finish = (ids: string[] = []) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ids);
    };
    const timer = setTimeout(finish, 15_000);
    const send = (frame: object) => child.stdin?.write(JSON.stringify(frame) + "\n");
    child.once("error", () => finish());
    child.once("close", () => finish());
    child.stderr?.resume();
    child.stdin?.on("error", () => finish());
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 512 * 1024) return finish();
      buffer += chunk;
      let end: number;
      while (!done && (end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const frame = classifyFrame(JSON.parse(line));
          if (frame.kind === "notification") continue;
          if (frame.kind === "request") {
            send(frame.method === "session/request_permission" ? permissionCancelledFrame(frame.id) : methodNotFoundFrame(frame.id));
            continue;
          }
          if (frame.kind !== "response" || frame.id !== expected || frame.error) return finish();
          const result = frame.result as { protocolVersion?: unknown; configOptions?: unknown; sessionId?: unknown } | null;
          if (expected === 2) return finish(typeof result?.sessionId === "string" ? catalogIds(result.configOptions) : []);
          if (result?.protocolVersion !== 1) return finish();
          expected = 2;
          send(sessionNewFrame(2, cwd));
        } catch { return finish(); }
      }
    });
    send(initializeFrame(1, "1"));
  });
}

async function probe(configDir: string, name: string): Promise<string[]> {
  const binary = resolveAgyBinary();
  const executable = binary && readAgyExecutable(binary);
  if (!executable) return [];
  const workspace = await createTurnWorkspace(configDir);
  let child: AgyAcpChild | undefined;
  try {
    const env = { ...baseScopedEnv(), NO_COLOR: "1", TMPDIR: workspace.tmp, TEMP: workspace.tmp, TMP: workspace.tmp };
    const version = await probeAgyVersion(executable.path, async path => (await run(path, ["--version"], {
      cwd: workspace.dir, env, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096, windowsHide: true,
    })).stdout);
    if (!version.ok || readAgyExecutable(binary)?.identity !== executable.identity) return [];
    const profile = launchForProfile(name, version.version);
    child = defaultAgyAcpSpawn(executable.path, ["acp", "--sandbox", ...profile.args], {
      cwd: workspace.dir, env: { ...env, ...profile.env },
    });
    return await readCatalog(child, workspace.dir);
  } finally {
    if (child?.pid !== undefined) await reapProcessTree(child, { graceMs: 1000, reapTimeoutMs: 5000 });
    await workspace.remove();
  }
}

export function discoverAgyModels(configDir: string, selection: { name: string; authority: string }): Promise<string[]> {
  const { name, authority } = selection;
  const pending = flights.get(authority);
  if (pending) return pending;
  const flight = probe(configDir, name).catch(() => []).finally(() => flights.delete(authority));
  flights.set(authority, flight);
  return flight;
}
