import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { ProviderAdapter } from "../base";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import { MuseMspError } from "./connection";
import { MuseMspRunner } from "./runner";
import { findMuseExecutable } from "./executable";
import { museCaptureInvocation } from "./capture-invocation";
import { museNativeRouteKey } from "./route-key";
import { currentMuseNativeRuntimePool } from "./runtime-scope";

const CHILD_ENV = ["PATH", "SystemRoot", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TEMP", "TMP"] as const;
const HOST_ARGS = ["serve", "--provider", "meta", "--preset", "empty", "--disable-shell", "--disable-write", "--no-session-log", "-c", "provider_retry.max_attempts=1"];

/**
 * Experimental provider factory. It remains unregistered; developer prompt
 * projection is explicit because Muse merges it with its own instructions.
 */
export function createMuseNativeProviderAdapter(providerId: string, options: { projectDeveloperPrompt?: true; requireNativeRoute?: true }): ProviderAdapter {
  const generation = captureConfigGeneration();
  let selected: ProviderAdapter | undefined;
  return {
    name: "muse-msp",
    reportsPhysicalSends: true,
    buildRequest() { throw new MuseMspError("unsupported_transport"); },
    async *parseStream() { throw new MuseMspError("unsupported_transport"); },
    onResponseRendered(parsed, response) { selected?.onResponseRendered?.(parsed, response); },
    async runTurn(parsed, incoming, emit) {
      try {
        const pool = currentMuseNativeRuntimePool();
        if (!pool) throw new MuseMspError("server_scope_unavailable");
        if (!parsed._reasoningReplayScope?.clientPrincipalId) throw new MuseMspError("client_identity_required");
        if (options.requireNativeRoute && !parsed._museNativeRoute) throw new MuseMspError("native_route_unavailable");
        const executable = findMuseExecutable();
        if (!executable) throw new MuseMspError("muse_not_installed");
        const source = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "muse", "auth.json");
        if (!isAbsolute(source) || !existsSync(source)) throw new MuseMspError("muse_file_login_unavailable");
        const env: NodeJS.ProcessEnv = {};
        for (const name of CHILD_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
        Object.assign(env, { TBH_CREDENTIAL_BACKEND: "file", TBH_DISABLE_TELEMETRY: "1", TBH_DISABLE_FEATURE_CONFIG: "1", MUSE_EXPERIMENTAL_SDK_ENABLED: "on" });
        const tempRoot = resolve(tmpdir()), capture = museCaptureInvocation();
        const key = museNativeRouteKey({ providerId, profileRevision: "msp-file-auth-v1", executable, cwd: tempRoot, args: HOST_ARGS, env });
        selected = await pool.acquireRoute(providerId, generation, key, () => {
          const cwd = resolve(mkdtempSync(join(tempRoot, "ocx-muse-workspace-")));
          if (!cwd.startsWith(tempRoot + sep) || !basename(cwd).startsWith("ocx-muse-workspace-")) throw new MuseMspError("invalid_temp_directory");
          try {
            const runner = new MuseMspRunner({ hostExecutable: executable, hostArgs: HOST_ARGS, hostEnv: env, cwd,
              captureExecutable: capture.executable, captureArgs: capture.args, requireAccountLogin: true,
              projectDeveloperPrompt: options.projectDeveloperPrompt, retainPlainTextTurns: true, streamText: true,
              settingsProvision: { disableReminders: true, writeCredentials: async directory => { await symlink(source, join(directory, "auth.json")); } } });
            return { run: runner.run.bind(runner), onResponseRendered: runner.onResponseRendered.bind(runner),
              async close() { try { await runner.close(); } finally { await rm(cwd, { recursive: true, force: true }); } } };
          } catch (error) { rmSync(cwd, { recursive: true, force: true }); throw error; }
        }, `muse-msp:${key}`);
        await selected.runTurn!(parsed, incoming, emit);
      } catch (error) {
        const code = error instanceof MuseMspError ? error.code : "muse_unavailable";
        const message = code === "client_identity_required" ? "Muse requires a configured OpenCodex API key to identify the client session."
          : code === "muse_not_installed" ? "Install Muse Code before using this provider."
          : code === "muse_file_login_unavailable" ? "Muse file-based login is unavailable; sign in with the Muse CLI."
          : "Muse Code could not start its session.";
        emit({ type: "error", message, code, status: 400, errorType: "invalid_request_error", retryable: false });
      }
    },
  };
}
