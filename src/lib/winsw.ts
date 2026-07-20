/**
 * WinSW-backed native Windows service (opt-in via `ocx service install --native`).
 *
 * Design (devlog/_plan/260720_windows_service/060):
 * - WinSW 2.12.0 NET461 build, downloaded on first native install and verified against
 *   a pinned SHA-256 (fail-closed: mismatch deletes the file and throws). The binary is
 *   NOT bundled in npm; offline installs get an explicit manual-placement hint.
 * - Runs as the USER account (v2 `<serviceaccount>` domain/user/allowservicelogon —
 *   never LocalSystem: the ACL hardening in windows-secret-acl grants only the user SID,
 *   so a SYSTEM service could not read the token file, and SYSTEM-owned writes would
 *   change the user-access contract).
 * - No password in XML: `winsw install /p` prompts on the console (stdin inherit).
 * - Absolute paths only — no %USERPROFILE% indirection (that exists for OEM-codepage
 *   batch parsing; WinSW XML is Unicode).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandUserPath, getConfigDir } from "../config";
import { durableBunPath } from "./bun-runtime";
import { serviceApiTokenFilePath } from "./service-secrets";

export const WINSW_VERSION = "2.12.0";
export const WINSW_URL = `https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW.NET461.exe`;
/** SHA-256 of the official v2.12.0 WinSW.NET461.exe release asset (655872 bytes). */
export const WINSW_SHA256 = "b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f";

/** SCM service id — distinct from the Task Scheduler task name (opencodex-proxy). */
export const WINSW_SERVICE_ID = "opencodex-proxy-native";

export function winswDir(): string {
  return join(getConfigDir(), "winsw");
}

/** WinSW discovers its config as the same-basename XML next to the exe. */
export function winswExePath(): string {
  return join(winswDir(), `${WINSW_SERVICE_ID}.exe`);
}

export function winswXmlPath(): string {
  return join(winswDir(), `${WINSW_SERVICE_ID}.xml`);
}

function winswLogDir(): string {
  return getConfigDir();
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function currentCodexHomeAbsolute(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? resolve(expandUserPath(raw)) : join(homedir(), ".codex");
}

export interface WinswEntry {
  bun: string;
  cli: string;
}

/**
 * Build the WinSW v2 XML. Never embeds the API token value — the app loads it from
 * OCX_API_TOKEN_FILE at startup (cli handleStart). PATH is baked for parity with the
 * Task Scheduler wrapper / launchd / systemd: the SCM service environment lacks the
 * user's interactive PATH, which provider subprocesses may need.
 */
export function buildWinswXml(entry: WinswEntry, env: NodeJS.ProcessEnv = process.env): string {
  const domain = env.USERDOMAIN?.trim() || ".";
  const user = env.USERNAME?.trim() || "";
  const envLines = [
    `  <env name="OCX_SERVICE" value="1"/>`,
    `  <env name="OCX_API_TOKEN_FILE" value="${xmlEscape(serviceApiTokenFilePath())}"/>`,
    `  <env name="PATH" value="${xmlEscape(env.PATH ?? "")}"/>`,
    env.CODEX_HOME?.trim() ? `  <env name="CODEX_HOME" value="${xmlEscape(currentCodexHomeAbsolute())}"/>` : null,
    env.OPENCODEX_HOME?.trim() ? `  <env name="OPENCODEX_HOME" value="${xmlEscape(getConfigDir())}"/>` : null,
  ].filter((line): line is string => Boolean(line));
  return `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>${WINSW_SERVICE_ID}</id>
  <name>OpenCodex Proxy (native)</name>
  <description>OpenCodex proxy running as a native Windows service (windowless, starts at boot).</description>
  <executable>${xmlEscape(entry.bun)}</executable>
  <arguments>${xmlEscape(`"${entry.cli}" start`)}</arguments>
${envLines.join("\n")}
  <logpath>${xmlEscape(winswLogDir())}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>4</keepFiles>
  </log>
  <onfailure action="restart" delay="5 sec"/>
  <stoptimeout>20 sec</stoptimeout>
  <serviceaccount>
    <domain>${xmlEscape(domain)}</domain>
    <user>${xmlEscape(user)}</user>
    <allowservicelogon>true</allowservicelogon>
  </serviceaccount>
</service>
`;
}

export function sha256Hex(data: Uint8Array | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Ensure the pinned WinSW binary exists locally; download + verify on first use.
 * Fail-closed: any hash mismatch deletes the file and throws.
 */
export async function ensureWinswBinary(fetchImpl: typeof fetch = fetch): Promise<string> {
  const exe = winswExePath();
  if (existsSync(exe)) {
    const digest = sha256Hex(readFileSync(exe));
    if (digest === WINSW_SHA256) return exe;
    unlinkSync(exe);
    console.warn("⚠️  Existing WinSW binary failed hash verification; re-downloading.");
  }
  if (!existsSync(winswDir())) mkdirSync(winswDir(), { recursive: true });
  let body: ArrayBuffer;
  try {
    const res = await fetchImpl(WINSW_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.arrayBuffer();
  } catch (err) {
    throw new Error(
      `Failed to download WinSW ${WINSW_VERSION} (${err instanceof Error ? err.message : String(err)}). ` +
        `Offline? Place the official WinSW.NET461.exe (v${WINSW_VERSION}) at ${exe} and retry.`,
    );
  }
  const bytes = Buffer.from(body);
  const digest = sha256Hex(bytes);
  if (digest !== WINSW_SHA256) {
    throw new Error(
      `WinSW download failed SHA-256 verification (got ${digest}, expected ${WINSW_SHA256}). ` +
        "Refusing to install an unverified service binary.",
    );
  }
  writeFileSync(exe, bytes);
  return exe;
}

function runWinsw(args: string[]): string {
  return execFileSync(winswExePath(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
}

/** `install /p` prompts for the service-account password on the console — stdin must be inherited. */
function runWinswInteractive(args: string[]): void {
  execFileSync(winswExePath(), args, { stdio: "inherit" });
}

function scQc(): string {
  const sc = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "sc.exe");
  return execFileSync(existsSync(sc) ? sc : "sc.exe", ["qc", WINSW_SERVICE_ID], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
}

export type WinswStatus = "started" | "stopped" | "nonexistent" | "unknown";

/** WinSW v2 `status` prints exactly Started / Stopped / NonExistent. */
export function parseWinswStatus(output: string): WinswStatus {
  const normalized = output.trim().toLowerCase();
  if (normalized.includes("nonexistent")) return "nonexistent";
  if (normalized.includes("started")) return "started";
  if (normalized.includes("stopped")) return "stopped";
  // Anything else is an unparseable result — NOT proof of absence. Callers must
  // fail closed: only an exact NonExistent may skip stop/uninstall.
  return "unknown";
}

export function statusWinswRaw(): WinswStatus {
  if (existsSync(winswExePath())) {
    try {
      return parseWinswStatus(runWinsw(["status"]));
    } catch {
      // The query itself failed (access denied, damaged/quarantined exe, ...). Treat the
      // service as possibly-installed so lifecycle operations still attempt stop/uninstall
      // instead of skipping a live SCM service that would keep respawning the proxy.
      return "unknown";
    }
  }
  // A missing exe does NOT prove the SCM registration is gone (quarantined binary,
  // partial uninstall): a stale opencodex-proxy-native registration can outlive it.
  // Confirm absence against the SCM itself before reporting "nonexistent".
  if (process.platform !== "win32") return "nonexistent";
  const probe = probeScmRegistration();
  // probe === "error": the SCM could not be queried — fail closed, never claim absence.
  return probe === false ? "nonexistent" : "unknown";
}

/**
 * Probe the SCM for the native service registration.
 * Returns true (registered), false (confirmed absent — exit 1060 only), or "error"
 * (query itself failed: access denied, sc.exe missing, ...). Only a confirmed
 * ERROR_SERVICE_DOES_NOT_EXIST may prove absence to lifecycle callers.
 */
export function probeScmRegistration(run: () => string = queryScmForService): boolean | "error" {
  try {
    run();
    return true;
  } catch (err) {
    const e = err as { status?: number | null; stderr?: string | Buffer | null; stdout?: string | Buffer | null; message?: string };
    // sc.exe does not reliably channel the 1060 line — it can land on stderr OR stdout
    // depending on the host — so scan every captured stream and the error message.
    const text = [e.stderr, e.stdout, e.message]
      .map(v => (typeof v === "string" ? v : ""))
      .join("\n");
    if (e.status === 1060 || /FAILED 1060/i.test(text)) return false;
    return "error";
  }
}

function scExePath(): string {
  const sc = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "sc.exe");
  return existsSync(sc) ? sc : "sc.exe";
}

function queryScmForService(): string {
  return execFileSync(scExePath(), ["query", WINSW_SERVICE_ID], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
}

/**
 * Verify the installed SCM service runs as the intended user, not LocalSystem (WinSW's
 * default when the XML account section is ignored/malformed). Rolls back on mismatch.
 */
function assertServiceAccountApplied(env: NodeJS.ProcessEnv = process.env): void {
  const qc = scQc();
  const startName = /SERVICE_START_NAME\s*:\s*(.+)/i.exec(qc)?.[1]?.trim() ?? "";
  const user = env.USERNAME?.trim() ?? "";
  if (/localsystem/i.test(startName) || (user && !startName.toLowerCase().includes(user.toLowerCase()))) {
    try { runWinsw(["uninstall"]); } catch { /* rollback is best-effort */ }
    throw new Error(
      `Native service was registered as "${startName || "unknown"}" instead of the current user; ` +
        "rolled back. Re-run `ocx service install --native` and enter the account credentials when prompted.",
    );
  }
}

export interface WinswInstallDeps {
  ensureBinary?: () => Promise<string>;
  writeXml?: (path: string, content: string) => void;
  interactive?: (args: string[]) => void;
  run?: (args: string[]) => string;
  verifyAccount?: () => void;
  status?: () => WinswStatus;
}

/**
 * Install (or repair) the native service. Re-running against an existing service skips
 * `install /p` — assets are rewritten and the service restarted without re-prompting
 * credentials (WinSW `install` fails with "service already exists").
 */
export async function installWinswService(entry: WinswEntry, deps: WinswInstallDeps = {}): Promise<void> {
  const ensureBinary = deps.ensureBinary ?? ensureWinswBinary;
  const writeXml = deps.writeXml ?? ((path: string, content: string) => writeFileSync(path, content, "utf8"));
  const interactive = deps.interactive ?? runWinswInteractive;
  const run = deps.run ?? runWinsw;
  const verifyAccount = deps.verifyAccount ?? assertServiceAccountApplied;
  const status = deps.status ?? statusWinswRaw;

  await ensureBinary();
  writeXml(winswXmlPath(), buildWinswXml(entry));
  const existing = status();
  if (existing === "unknown") {
    throw new Error(
      "Could not query the native service state (WinSW status failed or returned an unexpected result). " +
        "Refusing to guess the install state — check 'ocx service status' and retry.",
    );
  }
  if (existing === "nonexistent") {
    // WinSW self-elevates via UAC; a refused prompt aborts install (no silent fallback).
    // v2.12 recognizes prompting only as args[1]: `install /p` (XML is auto-discovered
    // as the same-basename file next to the exe).
    interactive(["install", "/p"]);
    verifyAccount();
  } else {
    // Use `stopwait` (not `stop`) so the SCM service fully stops before `start` — bare
    // `stop` only sends the stop request; `start` against a STOP_PENDING service fails.
    try { run(["stopwait"]); } catch { /* already stopped */ }
  }
  run(["start"]);
}

export function startWinswService(): void { runWinsw(["start"]); }
export function stopWinswService(): void { try { runWinsw(["stopwait"]); } catch { /* not running */ } }
export function uninstallWinswService(): void {
  if (!existsSync(winswExePath())) {
    // The binary is gone but the SCM registration can outlive it (quarantine, partial
    // uninstall). WinSW can't run without its exe, so remove the stale registration
    // directly via sc.exe — otherwise the SCM service survives every cleanup path.
    if (process.platform === "win32") {
      const probe = probeScmRegistration();
      if (probe === "error") {
        // Presence unknown — fail closed: keep service state, surface the failure
        // instead of reporting a clean uninstall over a possibly-live registration.
        throw new Error(
          `Cannot verify the native service registration (sc.exe query failed). ` +
            `Uninstall aborted; check 'sc query ${WINSW_SERVICE_ID}' and retry.`,
        );
      }
      if (probe === true) {
        try {
          execFileSync(scExePath(), ["stop", WINSW_SERVICE_ID], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        } catch { /* not running */ }
        execFileSync(scExePath(), ["delete", WINSW_SERVICE_ID], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      }
    }
    return;
  }
  try { runWinsw(["stopwait"]); } catch { /* not running */ }
  try { runWinsw(["uninstall"]); } catch (err) {
    // Surface the failure so the caller can decide; silent swallow hides UAC refusals.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes("nonexistent")) throw new Error(`WinSW uninstall failed: ${msg}`);
    // "NonExistent" means already absent — that's fine.
  }
  // exe/xml intentionally retained for credential-free reinstall; `--purge` is out of scope.
}

export function winswStatusSummary(): string {
  const status = statusWinswRaw();
  if (status === "nonexistent") {
    // A stale SCM service can outlive a deleted exe; surface the repair path.
    return existsSync(winswXmlPath()) && !existsSync(winswExePath())
      ? "native assets present but WinSW binary missing — run 'ocx service install --native' to repair"
      : "";
  }
  return `native (WinSW ${WINSW_VERSION}): ${status}`;
}

/** Default entry mirrors the Task Scheduler baking: durable Bun + cli.ts. */
export function defaultWinswEntry(cliDir: string): WinswEntry {
  return { bun: durableBunPath(), cli: join(cliDir, "cli", "index.ts") };
}
