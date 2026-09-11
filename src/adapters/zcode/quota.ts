import { refreshAccount } from "./account-runtime";
import { verifyDesktopSandbox } from "./desktop-sandbox";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { OcxProviderConfig } from "../../types";
import type { ProviderQuota } from "../../providers/quota-types";
import { getConfigDir } from "../../config/paths";
import { desktopProfile, desktopSandboxEnabled, desktopStatus, resolveDesktopRuntime } from "./desktop";
import { loadZcodeSettings } from "./settings";

export interface QuotaContext { identity: string; runtimeRoot: string; config: string; credentials?: string; sourceProvider: string; managed: boolean }
export type ZcodeQuotaSnapshot = { kind: "quota"; quota: ProviderQuota } | { kind: "empty" };
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Distinguish a valid empty entitlement from an unavailable or malformed probe. */
export function parseZcodeQuotaSnapshot(value: unknown, now = Date.now()): ZcodeQuotaSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { generatedAt?: unknown; limits?: unknown };
  if (!finite(v.generatedAt) || v.generatedAt > now + 60_000 || now - v.generatedAt > 30 * 60_000
    || !Array.isArray(v.limits) || v.limits.length > 256) return null;
  const result: ProviderQuota = { updatedAt: v.generatedAt };
  const seen = new Set<string>();
  for (const row of v.limits) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.type !== "string") return null;
    if (!["CREDIT_LIMIT", "TOKENS_LIMIT"].includes(row.type)) continue;
    const key = row.unit === 3 && row.number === 5 ? "fiveHour" : row.unit === 6 && row.number === 1 ? "weekly" : undefined;
    if (!key) continue;
    if (seen.has(key)) return null; // ambiguous windows are not interchangeable
    seen.add(key);
    let percent: number | undefined;
    if (finite(row.usage) && row.usage > 0 && finite(row.remaining) && row.remaining >= 0 && row.remaining <= row.usage) {
      percent = 100 * (1 - row.remaining / row.usage);
    } else if (row.usage === undefined && row.remaining === undefined && finite(row.percentage) && row.percentage >= 0 && row.percentage <= 100) {
      percent = row.percentage;
    }
    if (percent === undefined) return null;
    result[`${key}Percent`] = percent;
    if (finite(row.nextResetTime) && row.nextResetTime > 0 && row.nextResetTime <= 8.64e15) {
      result[`${key}ResetAt`] = row.nextResetTime > 1e11 ? row.nextResetTime : row.nextResetTime * 1000;
    }
  }
  return result.fiveHourPercent !== undefined || result.weeklyPercent !== undefined
    ? { kind: "quota", quota: result }
    : { kind: "empty" };
}

/** Translate consumption into the existing shared quota contract. Missing is never zero. */
export function parseZcodeQuota(value: unknown, now = Date.now()): ProviderQuota | null {
  const result = parseZcodeQuotaSnapshot(value, now);
  return result?.kind === "quota" ? result.quota : null;
}

function context(provider: OcxProviderConfig): QuotaContext {
  if (provider.adapter !== "zcode" || provider.authMode !== "local" || provider.disabled || process.platform !== "linux") throw new Error("unavailable");
  const settings = loadZcodeSettings(process.env, provider.zcodeAccountId);
  const managed = settings.desktopModels !== undefined;
  const runtime = managed ? desktopStatus(provider.zcodeAccountId).runtime : process.env.OCX_ZCODE_DESKTOP_RUNTIME;
  if (!runtime) throw new Error("unavailable");
  const runtimeRoot = dirname(dirname(dirname(resolveDesktopRuntime(runtime))));
  const config = managed ? desktopProfile(provider.zcodeAccountId).config : settings.settingsPath;
  if (!lstatSync(config).isFile() || statSync(config).size > 4 * 1024 * 1024) throw new Error("unavailable");
  if (!managed && !realpathSync(config).startsWith(realpathSync(settings.home) + sep)) throw new Error("unavailable");
  const credentialFile = managed ? desktopProfile(provider.zcodeAccountId).credentials : undefined;
  const credentials = managed && credentialFile && existsSync(credentialFile) ? credentialFile : undefined;
  if (credentials && (!lstatSync(credentials).isFile() || statSync(credentials).size > 1024 * 1024)) throw new Error("unavailable");
  const sourceProvider = provider.defaultModel?.split("/")[0] || (managed ? "builtin:zai-coding-plan" : "zai");
  if (managed && sourceProvider !== "builtin:zai-coding-plan") throw new Error("unavailable");
  const executable = join(runtimeRoot, "zcode");
  if (!lstatSync(executable).isFile()) throw new Error("unavailable");
  const identity = createHash("sha256").update(JSON.stringify([settings.scope, runtimeRoot, sourceProvider,
    ...[config, credentials, executable, join(runtimeRoot, "resources/app.asar")].filter(Boolean).map(p => {
      const st = statSync(p!); return [p, st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs];
    })])).digest("hex");
  return { identity, runtimeRoot, config, credentials, sourceProvider, managed };
}

export function zcodeQuotaIdentity(provider: OcxProviderConfig): string {
  try { return context(provider).identity; } catch { return "unavailable"; }
}

function command(c: QuotaContext): string[] {
  const args = ["--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--ro-bind", "/usr", "/usr"];
  for (const p of ["/bin", "/lib", "/lib64", "/sbin"]) if (existsSync(p)) {
    args.push(...(lstatSync(p).isSymbolicLink() ? ["--symlink", readlinkSync(p), p] : ["--ro-bind", p, p]));
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/etc");
  for (const p of ["/etc/passwd", "/etc/resolv.conf", "/etc/ssl", "/etc/pki"]) if (existsSync(p)) args.push("--ro-bind", p, p);
  args.push("--ro-bind", c.runtimeRoot, "/zcode", "--tmpfs", homedir(), "--ro-bind", c.config, "/desktop/config.json");
  if (c.credentials) args.push("--ro-bind", c.credentials, "/desktop/credentials.json");
  args.push("--ro-bind", fileURLToPath(new URL("./quota-bootstrap.cjs", import.meta.url)), "/bridge.cjs",
    "--clearenv", "--setenv", "HOME", homedir(), "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "ELECTRON_RUN_AS_NODE", "1",
    "--chdir", homedir(), "/zcode/zcode", "/bridge.cjs", c.managed ? "desktop" : "advanced", c.sourceProvider);
  return args;
}

/** One short-lived official host, without a writable user workspace or persistent credentials. */
async function probe(c: QuotaContext): Promise<ZcodeQuotaSnapshot | null> {
  const sandbox = desktopSandboxEnabled();
  const bwrap = sandbox ? Bun.which("bwrap", { PATH: process.env.PATH }) : undefined;
  if (sandbox && !bwrap) return null;
  try { if (bwrap) verifyDesktopSandbox(bwrap); } catch { return null; }
  let temporaryHome: string | undefined;
  try {
    if (!sandbox) {
      const directory = join(getConfigDir(), "zcode-desktop", "quota");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      temporaryHome = mkdtempSync(join(directory, "probe-"));
    }
    return await new Promise(resolve => {
    const child = spawn(bwrap || join(c.runtimeRoot, "zcode"), bwrap ? command(c) : [
      fileURLToPath(new URL("./quota-bootstrap.cjs", import.meta.url)), c.managed ? "managed" : "advanced", c.sourceProvider,
    ], { stdio: ["ignore", "pipe", "pipe"], env: bwrap ? { PATH: "/usr/bin:/bin" } : {
      PATH: "/usr/bin:/bin", HOME: homedir(), ELECTRON_RUN_AS_NODE: "1",
      ZCODE_DATA_BASE_DIR: temporaryHome!, OCX_ZCODE_QUOTA_HOST: "1",
      OCX_ZCODE_QUOTA_RUNTIME: c.runtimeRoot, OCX_ZCODE_QUOTA_CONFIG: c.config,
      ...(c.credentials ? { OCX_ZCODE_QUOTA_CREDENTIALS: c.credentials } : {}),
    } });
    let output = "";
    let invalid = false;
    const timer = setTimeout(() => { invalid = true; child.kill("SIGKILL"); }, 45_000);
    child.stderr.resume();
    child.stdout.on("data", chunk => {
      if (invalid) return;
      if (Buffer.byteLength(output) + chunk.length > 32_000) { invalid = true; child.kill("SIGKILL"); return; }
      output += chunk.toString("utf8");
    });
    child.once("error", () => { clearTimeout(timer); resolve(null); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code || invalid) return resolve(null);
      try { resolve(parseZcodeQuotaSnapshot(JSON.parse(output))); } catch { resolve(null); }
    });
    });
  } finally { if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true }); }
}

const inflight = new Map<string, Promise<ZcodeQuotaSnapshot | null>>();
export async function readZcodeQuota(provider: OcxProviderConfig, deps: { context?: typeof context; probe?: typeof probe } = {}): Promise<({ identity: string } & ZcodeQuotaSnapshot) | null> {
  let c: QuotaContext;
  try { if (provider.zcodeAccountId && !deps.context) await refreshAccount(provider.zcodeAccountId); c = (deps.context ?? context)(provider); } catch { return null; }
  // Coalesce per profile, without letting the first account starve every other account.
  let pending = inflight.get(c.identity);
  if (!pending) {
    if (inflight.size >= 20) return null;
    pending = (deps.probe ?? probe)(c).catch(() => null);
    inflight.set(c.identity, pending);
    void pending.finally(() => { if (inflight.get(c.identity) === pending) inflight.delete(c.identity); });
  }
  const snapshot = await pending;
  try { return snapshot && (deps.context ?? context)(provider).identity === c.identity ? { identity: c.identity, ...snapshot } : null; }
  catch { return null; }
}
