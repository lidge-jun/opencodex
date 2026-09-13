// Runs on the host by default, or inside an explicitly enabled OS sandbox. Desktop credentials/configuration are mounted read-only.
// Only the official runtime consumes provider keys. The compatible settings file lives in tmpfs,
// never in OpenCodex's data directory, management responses, logs or the Desktop profile.
const fs = require("node:fs");
const { spawn } = require("node:child_process");

function normalizeDesktopConfig(input) {
  const provider = {};
  for (const [id, raw] of Object.entries(input?.provider ?? {})) {
    if (!raw || typeof raw !== "object" || raw.enabled === false || id === "opencodex") continue;
    // Desktop's built-in Z.AI profiles only. Do not import arbitrary proxy chains/custom providers.
    if (!id.startsWith("builtin:zai")) continue;
    const options = raw.options ?? {};
    if (options.apiKeyRequired !== false && !(typeof options.apiKey === "string" && options.apiKey.trim())) continue;
    let url;
    try { url = new URL(options.baseURL); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname !== "api.z.ai" || url.username || url.password) continue;
    const cleanOptions = { baseURL: url.href };
    if (typeof options.apiKey === "string" && options.apiKey.trim()) cleanOptions.apiKey = options.apiKey;
    if (typeof options.apiKeyRequired === "boolean") cleanOptions.apiKeyRequired = options.apiKeyRequired;
    provider[id] = {
      name: typeof raw.name === "string" ? raw.name : id,
      kind: raw.kind === "anthropic" ? "anthropic" : "openai-compatible",
      source: "custom", enabled: true, options: cleanOptions,
      models: raw.models && typeof raw.models === "object" && !Array.isArray(raw.models) ? raw.models : {},
    };
  }
  const first = Object.entries(provider).find(([, p]) => Object.keys(p.models).length);
  const model = first ? `${first[0]}/${Object.keys(first[1].models)[0]}` : undefined;
  return { provider, ...(model ? { model: { main: model, lite: model } } : {}) };
}

function desktopModelCatalog(config) {
  return Object.entries(config.provider).flatMap(([providerId, p]) =>
    Object.entries(p.models).filter(([id, m]) => id && !/[\x00-\x20]/.test(id) && m && typeof m === "object").slice(0, 200).map(([modelId, m]) => ({
      id: `${providerId}/${modelId}`, providerId, modelId,
      label: `${p.name} / ${typeof m.name === "string" ? m.name : modelId}`.slice(0, 240),
      ...(Number.isFinite(m.limit?.context) && m.limit.context > 0 ? { contextWindow: m.limit.context } : {}),
    })));
}
module.exports = { normalizeDesktopConfig, desktopModelCatalog };
if (require.main === module) {
  let temporarySettings;
  const cleanup = () => { if (temporarySettings) fs.rmSync(temporarySettings, { recursive: true, force: true }); };
  process.on("exit", cleanup);
  try {
    const args = process.argv.slice(2);
    const host = args[0] === "--host";
    if (host ? args.length !== 6 || args[5] !== "app-server" : args.length !== 1 || args[0] !== "app-server") throw new Error("unsupported command");
    const path = host ? args[2] : "/desktop/config.json";
    if (fs.statSync(path).size > 4 * 1024 * 1024) throw new Error("oversized");
    const input = JSON.parse(fs.readFileSync(path, "utf8"));
    const config = normalizeDesktopConfig(input);
    let env = process.env;
    let settingsPath = `${env.HOME}/.zcode/cli/config.json`;
    if (host) {
      // Keep only ZCode-owned state private. HOME/XDG remain the real host environment so
      // native tools behave like ordinary host tools rather than an accidental soft sandbox.
      const paths = require("node:path");
      const stateHome = args[4];
      if (!paths.isAbsolute(stateHome) || stateHome.includes("\0")) throw new Error("invalid state home");
      temporarySettings = fs.mkdtempSync(paths.join(stateHome, "turn-"));
      settingsPath = paths.join(temporarySettings, "config.json");
      config.storage = { dir: paths.join(stateHome, ".zcode") };
      env = { ...process.env, ZCODE_DATA_BASE_DIR: stateHome };
    }
    fs.writeFileSync(settingsPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    const childArgs = [host ? args[1] : "/runtime/zcode.cjs", "app-server"];
    if (host) childArgs.push("--settings", settingsPath);
    const child = spawn(host ? process.execPath : "/usr/bin/node", childArgs, {
      stdio: ["pipe", "inherit", "inherit"], shell: false, env, ...(host ? { cwd: args[3] } : {}),
    });
    const lines = require("node:readline").createInterface({ input: process.stdin });
    lines.on("line", line => {
      try {
        if (line.length > 1024 * 1024) throw new Error("oversized request");
        const frame = JSON.parse(line);
        if (frame.method === "opencodex/desktopModels") {
          const models = desktopModelCatalog(config);
          process.stdout.write(JSON.stringify({ id: frame.id, result: { models } }) + "\n");
          return;
        }
        if (["workspace/readState", "session/create", "session/resume", "session/send"].includes(frame.method)) {
          const params = frame.params ?? {};
          const ref = params._zcodeModel ?? params.model;
          const providerId = ref?.providerId ?? Object.keys(config.provider)[0];
          const provider = config.provider[providerId];
          const modelId = ref?.modelId ?? Object.keys(provider?.models ?? {})[0];
          if (!provider || !Object.hasOwn(provider.models, modelId)) throw new Error("missing model");
          delete params._zcodeModel;
          params.runtimeModel = {
            revision: "opencodex-desktop-v1", generatedAt: Date.now(), model: { providerId, modelId },
            provider: { providerId, kind: provider.kind, label: provider.name, source: provider.source,
              baseURL: provider.options.baseURL, apiKeyRequired: provider.options.apiKeyRequired,
              ...(provider.options.apiKey ? { apiKey: { source: "inline", value: provider.options.apiKey } } : {}),
              models: Object.entries(provider.models).map(([id, m]) => ({ modelId: id,
                contextWindow: m.limit?.context, maxOutputTokens: m.limit?.output })),
            },
          };
          frame.params = params;
        }
        child.stdin.write(JSON.stringify(frame) + "\n");
      } catch { child.kill("SIGTERM"); }
    });
    lines.on("close", () => child.stdin.end());
    child.stdin.on("error", () => child.kill("SIGTERM"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    child.on("error", () => process.exit(1));
    child.on("exit", code => process.exit(code ?? 1));
  } catch {
    // Never expose parser excerpts, provider keys or paths from Desktop's configuration.
    process.stderr.write("ZCode Desktop configuration is unavailable or incompatible.\n");
    process.exitCode = 1;
  }
}
