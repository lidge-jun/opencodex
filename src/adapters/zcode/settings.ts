import { accountRoot } from "./accounts";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { loadDesktopSettings, type DesktopModel } from "./desktop";

export type JsonObject = Record<string, unknown>;
export function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export interface ZcodeSettings {
  accountId?: string;
  command: string[];
  home: string;
  workspace: string;
  settingsPath: string;
  scope: string;
  desktopModels?: DesktopModel[];
  /** Managed host mode preserves the user's ordinary tool environment while keeping ZCode state private. */
  hostExecution?: boolean;
  /** Managed Desktop consent authorizes non-interactive native tools; advanced launchers retain edit mode. */
  nativePermissionMode?: "edit" | "yolo";
}

/** Execution authority is operator environment or persisted GUI consent, never data-plane input. */
export function loadZcodeSettings(env: NodeJS.ProcessEnv = process.env, accountId?: string): ZcodeSettings {
  if (accountId !== undefined) accountRoot(accountId);
  // Explicit env fixtures remain hermetic. Production prefers the GUI's persisted connection.
  if (env === process.env) {
    const desktop = loadDesktopSettings(accountId);
    if (desktop) return desktop;
  }
  if (env.OCX_ZCODE_NATIVE_TOOLS !== "1") {
    throw new Error("ZCode native execution is disabled. Configure an isolated launcher and opt in with OCX_ZCODE_NATIVE_TOOLS=1.");
  }
  let command: unknown;
  try { command = JSON.parse(env.OCX_ZCODE_COMMAND ?? "null"); } catch { /* validated below */ }
  if (!Array.isArray(command) || !command.length || command.length > 32
    || command.some(v => typeof v !== "string" || v.includes("\0") || v.length > 4096)
    || !isAbsolute(command[0])) {
    throw new Error("OCX_ZCODE_COMMAND must be a JSON argv array starting with an absolute isolated launcher path.");
  }
  const home = env.OCX_ZCODE_HOME;
  const workspace = env.OCX_ZCODE_WORKSPACE;
  if (!home || !workspace || !isAbsolute(home) || !isAbsolute(workspace)) {
    throw new Error("ZCode requires explicit absolute OCX_ZCODE_HOME and OCX_ZCODE_WORKSPACE paths.");
  }
  const realHome = realpathSync(home);
  if (env.HOME && realHome === realpathSync(env.HOME)) throw new Error("ZCode must use a separate home, not the proxy home.");
  if (!statSync(realHome).isDirectory()) throw new Error("ZCode home is not a directory.");
  const settingsPath = join(realHome, ".zcode", "cli", "config.json");
  return {
    command: command as string[], home: realHome, workspace, settingsPath,
    scope: createHash("sha256").update(JSON.stringify([command, realHome, workspace])).digest("hex"),
  };
}

export interface ZcodeModel {
  id: string;
  providerId: string;
  modelId: string;
  label: string;
  contextWindow?: number;
  runtimeModel: JsonObject;
}

/** Local settings only: no credential import, cloud discovery or writes to ZCode Desktop. */
export function readZcodeModels(settings: ZcodeSettings): ZcodeModel[] {
  if (settings.desktopModels) return settings.desktopModels.map(model => ({ ...model, runtimeModel: {} }));
  try { return readModels(settings); }
  catch { throw new Error("ZCode isolated model settings are unavailable, invalid or exceed the size limit."); }
}

function readSettings(settings: ZcodeSettings): JsonObject {
  const home = realpathSync(settings.home);
  const resolved = realpathSync(settings.settingsPath);
  if (!resolved.startsWith(home + sep)) throw new Error("Settings escaped the isolated home.");
  const fd = openSync(settings.settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    // Verify the opened object, not just the path checked before open (Linux sandbox host).
    if (process.platform === "linux" && !realpathSync(`/proc/self/fd/${fd}`).startsWith(home + sep)) {
      throw new Error("Settings escaped the isolated home.");
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid settings file.");
    const bytes = Buffer.allocUnsafe(4 * 1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length === bytes.length) throw new Error("Settings grew beyond the size limit.");
    return record(JSON.parse(bytes.subarray(0, length).toString("utf8")));
  } finally { closeSync(fd); }
}

function readModels(settings: ZcodeSettings): ZcodeModel[] {
  const config = readSettings(settings);
  const result: ZcodeModel[] = [];
  for (const [providerId, value] of Object.entries(record(config.provider))) {
    const provider = record(value);
    if (provider.enabled === false || providerId === "opencodex") continue;
    const options = record(provider.options);
    // Never route an agent back into this proxy (including a differently named local entry).
    if (typeof options.baseURL === "string") {
      let url: URL;
      try { url = new URL(options.baseURL); } catch { continue; }
      if (url.protocol !== "https:" || url.username || url.password
        || /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[|.*\.localhost$)/i.test(url.hostname)) continue;
    }
    const models = Object.entries(record(provider.models));
    for (const [modelId, raw] of models) {
      if (!providerId || !modelId || providerId.includes("/") || /[\x00-\x20]/.test(providerId + modelId)) continue;
      const model = record(raw);
      const limit = record(model.limit);
      const contextWindow = typeof limit.context === "number" && limit.context > 0 ? limit.context : undefined;
      result.push({
        id: `${providerId}/${modelId}`, providerId, modelId,
        label: `${String(provider.name ?? providerId)} / ${String(model.name ?? modelId)}`,
        contextWindow,
        runtimeModel: {
          revision: "opencodex-zcode-v1", generatedAt: Date.now(), model: { providerId, modelId },
          provider: {
            providerId, kind: provider.kind ?? "openai-compatible", label: provider.name ?? providerId,
            source: provider.source ?? "custom", baseURL: options.baseURL,
            ...(provider.apiFormat ? { apiFormat: provider.apiFormat } : {}),
            ...(typeof options.apiKey === "string" && options.apiKey
              ? { apiKey: { source: "inline", value: options.apiKey } } : {}),
            apiKeyRequired: options.apiKeyRequired,
            models: models.map(([id, item]) => ({ modelId: id,
              contextWindow: record(record(item).limit).context,
              maxOutputTokens: record(record(item).limit).output })),
          },
        },
      });
      if (result.length > 2000) throw new Error("ZCode model catalog exceeds the size limit.");
    }
  }
  return result;
}

/** Never include runtimeModel (which may contain a key) in discovery or management output. */
export function discoverZcodeModels(accountId?: string): Array<{ id: string; label: string; contextWindow?: number }> {
  return readZcodeModels(loadZcodeSettings(process.env, accountId)).map(({ id, label, contextWindow }) => ({ id, label, contextWindow }));
}
