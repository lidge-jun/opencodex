import { verifyDesktopSandbox } from "./desktop-sandbox";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { desktopSandboxEnabled, resolveDesktopRuntime } from "./desktop";

export type NativeOAuthEvent =
  | { type: "capabilities"; supported: true }
  | { type: "authorization"; url: string }
  | { type: "authenticated"; subjectHash: string }
  | { type: "error"; code: "login_expired" | "native_oauth_failed" | "session_restore_failed" | "model_setup_failed" | "account_identity_mismatch" };

/** Strict projection even if a vendor/bootstrap version emits unexpected fields. */
export function parseNativeOAuthEvent(value: unknown): NativeOAuthEvent {
  if (!value || typeof value !== "object") throw new Error("native_oauth_failed");
  const row = value as Record<string, unknown>;
  if (row.type === "capabilities" && row.supported === true) return { type: "capabilities", supported: true };
  if (row.type === "authorization" && typeof row.url === "string" && row.url.length <= 8_192) {
    let url: URL;
    try { url = new URL(row.url); } catch { throw new Error("native_oauth_failed"); }
    if (url.protocol === "https:" && url.hostname === "chat.z.ai" && !url.username && !url.password) return { type: "authorization", url: url.href };
  }
  if (row.type === "authenticated" && typeof row.subjectHash === "string" && /^[a-f0-9]{64}$/.test(row.subjectHash)) {
    return { type: "authenticated", subjectHash: row.subjectHash };
  }
  if (row.type === "error") return { type: "error", code:
    row.code === "login_expired" || row.code === "session_restore_failed" || row.code === "model_setup_failed" || row.code === "account_identity_mismatch"
      ? row.code : "native_oauth_failed" };
  throw new Error("native_oauth_failed");
}

/** The caller supplies a newly allocated private profile, never the user's Desktop home. */
export function nativeOAuthCommand(runtime: string, profileHome: string, mode: "login" | "capabilities" | "refresh", expectedSubjectHash?: string): string[] {
  if (process.platform !== "linux") throw new Error("platform_unsupported");
  const profile = realpathSync(profileHome), st = lstatSync(profileHome);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) || profile === realpathSync(homedir())) {
    throw new Error("profile_invalid");
  }
  const runtimeRoot = dirname(dirname(dirname(resolveDesktopRuntime(runtime))));
  if (!lstatSync(join(runtimeRoot, "zcode")).isFile()) throw new Error("desktop_missing");
  if (mode === "refresh" && !/^[a-f0-9]{64}$/.test(expectedSubjectHash ?? "")) throw new Error("account_identity_mismatch");
  if (!desktopSandboxEnabled()) return [join(runtimeRoot, "zcode"),
    fileURLToPath(new URL("./oauth-bootstrap.cjs", import.meta.url)), mode, runtimeRoot, ...(expectedSubjectHash ? [expectedSubjectHash] : [])];
  const bwrap = Bun.which("bwrap", { PATH: process.env.PATH });
  if (!bwrap) throw new Error("sandbox_missing");
  verifyDesktopSandbox(bwrap);
  const args = [realpathSync(bwrap), "--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--ro-bind", "/usr", "/usr"];
  for (const path of ["/bin", "/lib", "/lib64", "/sbin"]) if (existsSync(path)) {
    args.push(...(lstatSync(path).isSymbolicLink() ? ["--symlink", readlinkSync(path), path] : ["--ro-bind", path, path]));
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/etc");
  for (const path of ["/etc/passwd", "/etc/resolv.conf", "/etc/ssl", "/etc/pki"]) if (existsSync(path)) args.push("--ro-bind", path, path);
  args.push("--ro-bind", runtimeRoot, "/zcode", "--bind", profile, homedir(),
    "--ro-bind", fileURLToPath(new URL("./oauth-bootstrap.cjs", import.meta.url)), "/bridge.cjs",
    "--clearenv", "--setenv", "HOME", homedir(), "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "ELECTRON_RUN_AS_NODE", "1", "--chdir", homedir(), "/zcode/zcode", "/bridge.cjs", mode, "/zcode",
    ...(expectedSubjectHash ? [expectedSubjectHash] : []));
  return args;
}

export async function runNativeOAuth(options: {
  runtime: string; profileHome: string; mode: "login" | "capabilities" | "refresh";
  expectedSubjectHash?: string;
  signal: AbortSignal; onEvent: (event: NativeOAuthEvent) => void;
}): Promise<void> {
  if (options.signal.aborted) throw new Error("login_cancelled");
  const [executable, ...args] = nativeOAuthCommand(options.runtime, options.profileHome, options.mode, options.expectedSubjectHash);
  const child = spawn(executable!, args, { env: desktopSandboxEnabled() ? { PATH: "/usr/bin:/bin" } : {
    PATH: "/usr/bin:/bin", HOME: homedir(), ELECTRON_RUN_AS_NODE: "1", ZCODE_DATA_BASE_DIR: options.profileHome,
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  let invalid = false, finished = false, buffer = "", total = 0;
  const stop = () => child.kill("SIGKILL");
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  const timer = setTimeout(stop, options.mode === "login" ? 310_000 : 20_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("native_oauth_failed")));
      child.stdout.on("data", chunk => {
        total += chunk.length;
        if (total > 16_384 || invalid) { invalid = true; stop(); return; }
        buffer += chunk.toString("utf8");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const event = parseNativeOAuthEvent(JSON.parse(line));
            if (finished || event.type === "error") { invalid = true; stop(); }
            finished ||= event.type === "authenticated" || event.type === "capabilities";
            options.onEvent(event);
          } catch { invalid = true; stop(); }
        }
      });
      child.once("close", code => code === 0 && finished && !invalid && !buffer && !options.signal.aborted
        ? resolve() : reject(new Error(options.signal.aborted ? "login_cancelled" : "native_oauth_failed")));
    });
  } finally { clearTimeout(timer); options.signal.removeEventListener("abort", stop); stop(); }
}
