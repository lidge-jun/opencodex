import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { baseScopedEnv } from "../coding-agent/turn";
import { classifyFrame, initializeFrame, methodNotFoundFrame, permissionCancelledFrame, sessionNewFrame, setConfigOptionFrame } from "./acp";
import { probeAgyVersion, readAgyExecutable, resolveAgyBinary } from "./binary";
import { currentSelection, findSelector, isGeminiValue, matchValue, normalizeLabel, parseConfigOptions, proveModel, readThoughtLevels, type AgyThoughtLevels } from "./options";
import { createTurnWorkspace, defaultAgyAcpSpawn, reapProcessTree, type AgyAcpChild } from "./process";
import { launchForProfile } from "./profiles";

const run = promisify(execFile);
type DiscoveredModel = { id: string; agyThoughtLevels: AgyThoughtLevels };
const flights = new Map<string, Promise<DiscoveredModel[]>>();

/** Publish only IDs that the adapter can subsequently request from this selector. */
export function catalogIds(options: unknown): string[] {
  const state = parseConfigOptions(options);
  const selector = state && findSelector(state, "model");
  if (!selector?.ok || !currentSelection(selector.selector)) return [];
  const choices = selector.selector.values.filter(isGeminiValue);
  const ids = new Set<string>();
  for (const item of choices) {
    if (selector.selector.values.filter(option => option.value === item.value).length !== 1) continue;
    // Some ACP versions use opaque wire values. Advertise a label only if the
    // turn adapter resolves it unambiguously back to this specific option.
    for (const id of [item.value, normalizeLabel(item.name)]) {
      if (!/^gemini[-.][a-z0-9][a-z0-9.-]{0,126}$/i.test(id)) continue;
      const match = matchValue(choices, [id]);
      if (match.ok && match.value === item) {
        ids.add(id);
        break;
      }
    }
  }
  return [...ids];
}

/** Read selectors in one empty session. A failed model acknowledgement invalidates the snapshot. */
function readCatalog(child: AgyAcpChild, cwd: string): Promise<DiscoveredModel[]> {
  return new Promise(resolve => {
    let expected = 1;
    let sessionId = "";
    let ids: string[] = [];
    const rows: DiscoveredModel[] = [];
    let buffer = "";
    let bytes = 0;
    let done = false;
    const finish = (models: DiscoveredModel[] = []) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(models);
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
          if (expected === 1) {
            if (result?.protocolVersion !== 1) return finish();
            send(sessionNewFrame(++expected, cwd));
            continue;
          }
          const state = parseConfigOptions(result?.configOptions);
          if (!state) return finish();
          if (expected === 2) {
            if (typeof result?.sessionId !== "string" || !result.sessionId) return finish();
            sessionId = result.sessionId;
            ids = catalogIds(result.configOptions);
          } else if (!proveModel(state, "selected", ids[rows.length]).ok) {
            return finish();
          }
          const id = ids[rows.length];
          if (id && proveModel(state, "selected", id).ok) rows.push({ id, agyThoughtLevels: readThoughtLevels(state) });
          const next = ids[rows.length];
          if (!next) return finish(rows);
          const proof = proveModel(state, "initial", next);
          if (!proof.ok || !proof.target) return finish();
          send(setConfigOptionFrame(++expected, sessionId, proof.selector.id, proof.target.value));
        } catch { return finish(); }
      }
    });
    send(initializeFrame(1, "1"));
  });
}

async function probe(configDir: string, name: string): Promise<DiscoveredModel[]> {
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

export function discoverAgyModels(configDir: string, selection: { name: string; authority: string }): Promise<DiscoveredModel[]> {
  const { name, authority } = selection;
  const pending = flights.get(authority);
  if (pending) return pending;
  const flight = probe(configDir, name).catch(() => []).finally(() => flights.delete(authority));
  flights.set(authority, flight);
  return flight;
}
