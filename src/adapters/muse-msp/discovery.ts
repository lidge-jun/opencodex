import { execFile } from "node:child_process";
import { stat, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { findMuseExecutable } from "./executable";
import { MuseMspHost } from "./host";
import { createMuseIsolatedSettings } from "./isolated-settings";
import { museMspSubscriptionQuota } from "./subscription-usage";

type Row = { id: string; contextWindow: number; maxOutputTokens: number };
const childEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TEMP", "TMP"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return Object.assign(env, { TBH_CREDENTIAL_BACKEND: "file", TBH_DISABLE_TELEMETRY: "1", TBH_DISABLE_FEATURE_CONFIG: "1", MUSE_EXPERIMENTAL_SDK_ENABLED: "on" });
};

export function parseMuseCatalog(value: unknown): Row[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as any).models)) throw Error("invalid catalog");
  const models = (value as any).models;
  if (models.length > 256) throw Error("invalid catalog");
  const seen = new Set<string>();
  const rows: Row[] = models.map((item: any) => {
    if (!item || typeof item.modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.modelId)
      || seen.has(item.modelId) || !Number.isSafeInteger(item.contextLimit) || item.contextLimit < 1
      || !Number.isSafeInteger(item.outputLimit) || item.outputLimit < 1 || item.outputLimit > item.contextLimit) throw Error("invalid model");
    seen.add(item.modelId);
    return { id: item.modelId, contextWindow: item.contextLimit, maxOutputTokens: item.outputLimit };
  });
  // The CLI lists Spark base models while its Contributor variant is selected
  // by the same id with this suffix. Generate variants from the live roster;
  // never keep a fixed list of model versions.
  for (const row of [...rows]) {
    const contributor = `${row.id}-contributor`;
    if (/^muse-spark-\d+\.\d+$/.test(row.id) && !seen.has(contributor)) {
      seen.add(contributor);
      rows.push({ ...row, id: contributor });
    }
  }
  return rows;
}

let cached: { identity: string; expires: number; rows: Row[] } | undefined;
let flight: { identity: string; promise: Promise<Row[]> } | undefined;

export async function discoverMuseModels(): Promise<Row[]> {
  const source = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "muse", "auth.json");
  const s = await stat(source);
  const identity = `${source}:${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  if (cached?.identity === identity && cached.expires > Date.now()) return cached.rows.map(row => ({ ...row }));
  if (flight?.identity === identity) return (await flight.promise).map(row => ({ ...row }));
  const promise = discoverMuseModelsUncached(source).then(async rows => {
    const current = await stat(source);
    if (`${source}:${current.dev}:${current.ino}:${current.size}:${current.mtimeMs}:${current.ctimeMs}` !== identity) throw Error("Muse login changed");
    cached = { identity, expires: Date.now() + 30_000, rows };
    return rows;
  });
  flight = { identity, promise };
  try { return (await promise).map(row => ({ ...row })); }
  finally { if (flight?.promise === promise) flight = undefined; }
}

async function discoverMuseModelsUncached(source: string): Promise<Row[]> {
  const executable = findMuseExecutable();
  if (!executable) throw Error("Muse unavailable");
  const settings = await createMuseIsolatedSettings(undefined, childEnv(), { disableReminders: true,
    writeCredentials: async dir => { await symlink(source, join(dir, "auth.json")); } });
  let host: MuseMspHost | undefined;
  try {
    host = await MuseMspHost.start({ executable, cwd: tmpdir(), env: settings.env,
      args: ["serve", "--provider", "meta", "--preset", "empty", "--disable-shell", "--disable-write", "--no-session-log", "-c", "provider_retry.max_attempts=1"] },
      { timeoutMs: 15000, requireAccountLogin: true });
    return parseMuseCatalog(await host.connection.request("model/list", {}, { timeoutMs: 15000 }));
  } finally { if (host) await host.close(); await settings.close(); }
}

export async function readMuseUsage() {
  const executable = findMuseExecutable();
  if (!executable) throw Error("Muse unavailable");
  const stdout = await new Promise<string>((resolve, reject) => execFile(executable, ["usage", "--json"],
    { env: childEnv(), timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true },
    (error, output) => error ? reject(Error("Muse usage unavailable")) : resolve(output)));
  const raw = JSON.parse(stdout), a = raw?.allowance;
  return museMspSubscriptionQuota({ usage: { observedAtMs: a?.asOfMs, window: a?.window, weekly: a?.weekly } });
}
