// Runs on the host by default, or inside an explicitly enabled OS sandbox. Desktop credentials/configuration are mounted read-only.
// Only the official runtime consumes provider keys. The compatible settings file is private and
// turn-scoped; it never reaches management responses, logs or the Desktop source profile.
const fs = require("node:fs");
const { spawn } = require("node:child_process");

function hostExecutionHooks() {
  return {
    enabled: true,
    maxOutputBytes: 2 * 1024 * 1024,
    events: {
      PreToolUse: [{
        matcher: "^Bash$",
        hooks: [{
          type: "process",
          command: process.execPath,
          args: [require.resolve("./desktop-host-tool-hook.cjs")],
          timeoutMs: 2_000,
        }],
      }],
    },
  };
}

function normalizeDesktopConfig(input, options = {}) {
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
  const config = { provider };
  const model = desktopModelCatalog(config)[0]?.id;
  return {
    ...config,
    ...(model ? { model: { main: model, lite: model } } : {}),
    // This is an official ZCode user-config hook, not a vendor-runtime patch. Managed host
    // consent makes Bash deterministic even when the model omits the per-call flag. The
    // optional outer Bubblewrap path never installs it and remains a hard confinement layer.
    ...(options.hostExecution ? { hooks: hostExecutionHooks() } : {}),
  };
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
  let temporaryHome;
  let child;
  let host = false;
  let terminating = false;
  let forceTimer;
  let exitTimer;
  const cleanup = () => { if (temporaryHome) fs.rmSync(temporaryHome, { recursive: true, force: true }); };
  const signalChildTree = signal => {
    if (!child) return;
    if (host && process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, signal); return; } catch { /* fall back to the direct child */ }
    }
    try { child.kill(signal); } catch { /* the child already exited */ }
  };
  const terminateChildTree = () => {
    if (terminating) return;
    terminating = true;
    try { child?.stdin.destroy(); } catch { /* already closed */ }
    signalChildTree("SIGTERM");
    // The official runtime and every non-detached native tool share this process group.
    // Escalate before the outer client can force-kill this bootstrap, so its exit cleanup runs.
    forceTimer = setTimeout(() => signalChildTree("SIGKILL"), 250);
    exitTimer = setTimeout(() => process.exit(1), 450);
  };
  process.on("exit", () => { signalChildTree("SIGKILL"); cleanup(); });
  try {
    const args = process.argv.slice(2);
    host = args[0] === "--host";
    if (host ? args.length !== 6 || args[5] !== "app-server" : args.length !== 1 || args[0] !== "app-server") throw new Error("unsupported command");
    const path = host ? args[2] : "/desktop/config.json";
    if (fs.statSync(path).size > 4 * 1024 * 1024) throw new Error("oversized");
    const input = JSON.parse(fs.readFileSync(path, "utf8"));
    const config = normalizeDesktopConfig(input, { hostExecution: host });
    let env = process.env;
    let settingsPath = `${env.HOME}/.zcode/cli/config.json`;
    if (host) {
      // ZCode reads user config from os.homedir() and exposes no config-path CLI flag. Patch
      // that lookup only in the official runtime process; process.env.HOME stays real for
      // the native tools it starts. This is state separation, not filesystem confinement.
      const paths = require("node:path");
      const stateHome = args[4];
      if (!paths.isAbsolute(stateHome) || stateHome.includes("\0")) throw new Error("invalid state home");
      const stableDb = paths.join(stateHome, ".zcode/cli/db");
      temporaryHome = fs.mkdtempSync(paths.join(stateHome, "turn-"));
      fs.mkdirSync(paths.join(temporaryHome, ".zcode/cli"), { recursive: true, mode: 0o700 });
      fs.symlinkSync(stableDb, paths.join(temporaryHome, ".zcode/cli/db"), "dir");
      settingsPath = paths.join(temporaryHome, ".zcode/cli/config.json");
      config.storage = { dir: paths.join(stateHome, ".zcode") };
      env = { ...process.env, ZCODE_DATA_BASE_DIR: stateHome, OCX_ZCODE_RUNTIME_HOME: temporaryHome };
    }
    fs.writeFileSync(settingsPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    const childArgs = host
      ? ["--require", require.resolve("./desktop-host-preload.cjs"), args[1], "app-server"]
      : ["/runtime/zcode.cjs", "app-server"];
    child = spawn(host ? process.execPath : "/usr/bin/node", childArgs, {
      stdio: ["pipe", "inherit", "inherit"], shell: false, env,
      ...(host ? { cwd: args[3], detached: process.platform !== "win32" } : {}),
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
      } catch { terminateChildTree(); }
    });
    lines.on("close", () => child.stdin.end());
    child.stdin.on("error", terminateChildTree);
    process.on("SIGTERM", terminateChildTree);
    child.on("error", () => process.exit(1));
    child.on("exit", code => {
      clearTimeout(forceTimer); clearTimeout(exitTimer);
      process.exit(code ?? 1);
    });
  } catch {
    // Never expose parser excerpts, provider keys or paths from Desktop's configuration.
    process.stderr.write("ZCode Desktop configuration is unavailable or incompatible.\n");
    process.exitCode = 1;
  }
}
