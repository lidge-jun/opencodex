import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "../../config/paths";
import { closeZcodeDesktopClients, ZcodeClient } from "./client";
import type { ZcodeSettings } from "./settings";
import { resolveDesktopNode } from "./desktop-node";

export interface DesktopModel { id: string; providerId: string; modelId: string; label: string; contextWindow?: number }
interface Connection {
  version: 1; connected: boolean; generation: string;
  runtime: string; workspace: string; models: DesktopModel[];
}
export class DesktopSetupError extends Error {
  constructor(public code: string) { super(code); }
}
const fail = (code: string): never => { throw new DesktopSetupError(code); };
const root = () => join(getConfigDir(), "zcode-desktop");
const connectionPath = () => join(root(), "connection.json");
export const defaultDesktopWorkspace = () => join(root(), "workspace");

function readConnection(): Connection | undefined {
  const path = connectionPath();
  if (!existsSync(path)) return undefined;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 256 * 1024 || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()) fail("connection_invalid");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const c = JSON.parse(readFileSync(fd, "utf8")) as Connection;
      if (c.version !== 1 || typeof c.connected !== "boolean" || typeof c.generation !== "string" || !/^[a-f0-9-]{36}$/.test(c.generation) || typeof c.runtime !== "string" || typeof c.workspace !== "string" || !Array.isArray(c.models)) fail("connection_invalid");
      return c;
    } finally { closeSync(fd); }
  } catch { return fail("connection_invalid"); }
}

function persist(connection: Connection): void {
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  const temp = join(root(), `${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(connection), { mode: 0o600, flag: "wx" });
  renameSync(temp, connectionPath());
}

/** Only an installed Desktop layout, never an arbitrary executable or shell command. */
export function resolveDesktopRuntime(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || path.includes("\0")) return fail("desktop_missing");
  for (const candidate of [path, join(path, "resources/glm/zcode.cjs"), join(path, "Contents/Resources/glm/zcode.cjs")]) {
    try {
      const real = realpathSync(candidate);
      if (basename(real) !== "zcode.cjs" || basename(dirname(real)) !== "glm") continue;
      const resources = dirname(dirname(real));
      if (!existsSync(join(resources, "app.asar")) || !statSync(real).isFile()) continue;
      return real;
    } catch { /* try the next installed layout */ }
  }
  return fail("desktop_missing");
}

export function detectDesktopRuntimes(): string[] {
  const candidates = ["/opt/ZCode", "/opt/zcode", "/Applications/ZCode.app", join(homedir(), "Applications/ZCode.app")];
  if (process.platform === "linux") {
    try {
      for (const pid of readdirSync("/proc").filter(p => /^\d+$/.test(p)).slice(0, 4096)) {
        try {
          if (statSync(`/proc/${pid}`).uid !== process.getuid?.()) continue;
          const exe = readlinkSync(`/proc/${pid}/exe`);
          if (/^zcode(?:-bin)?$/i.test(basename(exe))) candidates.push(dirname(exe));
        } catch { /* process exited or belongs to another user */ }
      }
    } catch { /* no process discovery */ }
  }
  const found = new Set<string>();
  for (const candidate of candidates) { try { found.add(resolveDesktopRuntime(candidate)); } catch { /* absent */ } }
  return [...found].slice(0, 8);
}

export function validateDesktopWorkspace(path: string): string {
  if (!path || !isAbsolute(path) || path.includes("\0") || path.length > 4096) return fail("workspace_invalid");
  if (resolve(path) === resolve(defaultDesktopWorkspace())) mkdirSync(path, { recursive: true, mode: 0o700 });
  let workspace: string;
  try { workspace = realpathSync(path); if (!statSync(workspace).isDirectory()) return fail("workspace_invalid"); }
  catch { return fail("workspace_invalid"); }
  const home = realpathSync(homedir());
  if (workspace === home || home.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep)) return fail("workspace_invalid");
  if (workspace !== resolve(defaultDesktopWorkspace())) {
    for (const protectedPath of [join(home, ".zcode"), join(home, ".codex"), join(home, ".ssh"), join(home, ".config"), getConfigDir(), root()]) {
      if (workspace === protectedPath || workspace.startsWith(protectedPath + sep) || protectedPath.startsWith(workspace + sep)) return fail("workspace_invalid");
    }
  }
  return workspace;
}

export function desktopFolders(path?: string) {
  const home = realpathSync(homedir());
  const current = path ? realpathSync(path) : home;
  if (current !== home && !current.startsWith(home + sep)) return fail("workspace_invalid");
  if (current !== home) validateDesktopWorkspace(current);
  const folders = readdirSync(current, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .slice(0, 200).map(entry => ({ name: entry.name, path: join(current, entry.name) }));
  return { current, parent: current === home ? null : dirname(current), folders };
}

function prerequisites(): { bwrap: string; node: string } {
  if (process.platform !== "linux") return fail("platform_unsupported");
  const bwrap = Bun.which("bwrap"); if (!bwrap) return fail("sandbox_missing");
  let node: string;
  try { node = resolveDesktopNode(); }
  catch (error) { return fail(error instanceof Error && error.message === "node_missing" ? "node_missing" : "node_incompatible"); }
  return { bwrap: realpathSync(bwrap), node: realpathSync(node) };
}

function desktopProfile(): { config: string; credentials?: string } {
  const base = join(homedir(), ".zcode/v2");
  const config = join(base, "config.json");
  try { if (!lstatSync(config).isFile() || statSync(config).size > 4 * 1024 * 1024) return fail("profile_missing"); }
  catch { return fail("profile_missing"); }
  const credentials = join(base, "credentials.json");
  return { config, ...(existsSync(credentials) && lstatSync(credentials).isFile() ? { credentials } : {}) };
}

function settingsFor(connection: Connection): ZcodeSettings {
  const { bwrap, node } = prerequisites();
  const runtime = resolveDesktopRuntime(connection.runtime);
  const workspace = validateDesktopWorkspace(connection.workspace);
  const profile = desktopProfile();
  // Do not carry a native conversation across Desktop login/profile changes. Metadata-only
  // fencing is conservative (a refresh may start a new session) and never reads credential bytes.
  const profileStamp = createHash("sha256").update(JSON.stringify([profile.config, profile.credentials].filter(Boolean).map(path => {
    const st = statSync(path!); return [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs];
  }))).digest("hex");
  const privateHome = join(root(), "home", connection.generation, profileStamp);
  const db = join(privateHome, ".zcode/cli/db");
  mkdirSync(db, { recursive: true, mode: 0o700 });
  const sandboxHome = homedir(); // preserve the official credential cipher's HOME/username identity
  const args = ["--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--ro-bind", "/usr", "/usr"];
  for (const path of ["/bin", "/lib", "/lib64", "/sbin"]) {
    if (!existsSync(path)) continue;
    const st = lstatSync(path);
    args.push(...(st.isSymbolicLink() ? ["--symlink", readlinkSync(path), path] : ["--ro-bind", path, path]));
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/etc");
  for (const path of ["/etc/passwd", "/etc/resolv.conf", "/etc/ssl", "/etc/pki"]) if (existsSync(path)) args.push("--ro-bind", path, path);
  args.push("--ro-bind", dirname(runtime), "/runtime", "--ro-bind", node, "/usr/bin/node",
    "--ro-bind", fileURLToPath(new URL("./desktop-bootstrap.cjs", import.meta.url)), "/bridge/desktop-bootstrap.cjs",
    "--bind", privateHome, sandboxHome, "--bind", workspace, "/workspace",
    "--ro-bind", profile.config, "/desktop/config.json",
    "--tmpfs", `${sandboxHome}/.zcode/cli`, "--bind", db, `${sandboxHome}/.zcode/cli/db`);
  if (profile.credentials) args.push("--ro-bind", profile.credentials, "/desktop/.zcode/v2/credentials.json");
  args.push("--clearenv", "--setenv", "HOME", sandboxHome, "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "ZCODE_DATA_BASE_DIR", "/desktop", "--chdir", "/workspace",
    "/usr/bin/node", "/bridge/desktop-bootstrap.cjs");
  return { command: [bwrap, ...args], home: privateHome, workspace: "/workspace", settingsPath: "",
    scope: `desktop:${connection.generation}:${profileStamp}`, desktopModels: connection.models };
}

/** Persisted GUI consent is separate from provider config; data-plane requests cannot set it. */
export function loadDesktopSettings(): ZcodeSettings | undefined {
  if (connecting) return fail("busy");
  const connection = readConnection();
  if (!connection) return undefined;
  if (!connection.connected) return fail("disconnected");
  return settingsFor(connection);
}

export function desktopStatus() {
  let issue: string | undefined;
  try { prerequisites(); desktopProfile(); } catch (e) { issue = e instanceof DesktopSetupError ? e.code : "connection_invalid"; }
  let connection: Connection | undefined;
  try { connection = readConnection(); } catch { issue = "connection_invalid"; }
  const runtimes = detectDesktopRuntimes();
  if (connection?.connected) {
    try { resolveDesktopRuntime(connection.runtime); validateDesktopWorkspace(connection.workspace); }
    catch (e) { issue = e instanceof DesktopSetupError ? e.code : "connection_invalid"; }
  }
  return { connected: connection?.connected === true && !issue, issue, runtimes,
    runtime: connection?.runtime ?? runtimes[0] ?? "", workspace: connection?.workspace ?? defaultDesktopWorkspace(),
    models: connection?.models ?? [], platform: process.platform };
}

let connecting = false;
export async function connectDesktop(runtime: string, workspace: string): Promise<ReturnType<typeof desktopStatus>> {
  if (connecting) return fail("busy");
  connecting = true;
  try {
    const connection: Connection = { version: 1, connected: true, generation: randomUUID(),
      runtime: resolveDesktopRuntime(runtime), workspace: validateDesktopWorkspace(workspace), models: [] };
    const client = new ZcodeClient(settingsFor(connection));
    try {
      const result = await client.request("opencodex/desktopModels", {}, 15_000);
      if (!Array.isArray(result.models) || !result.models.length || result.models.length > 1000) return fail("models_missing");
      connection.models = result.models.filter((m: DesktopModel) => typeof m.id === "string" && typeof m.providerId === "string"
        && m.providerId.startsWith("builtin:zai") && typeof m.modelId === "string" && !/[\x00-\x20]/.test(m.id)
        && m.id === `${m.providerId}/${m.modelId}`).map((m: DesktopModel) => ({
          id: m.id, providerId: m.providerId, modelId: m.modelId, label: String(m.label).slice(0, 240),
          ...(typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
        }));
      if (!connection.models.length) return fail("models_missing");
      // Official protocol readiness only. This does not send a prompt or spend inference quota.
      await client.request("workspace/readState", { workspace: { workspacePath: "/workspace", workspaceKey: "/workspace" } }, 15_000);
    } finally { await client.close(); }
    await closeZcodeDesktopClients();
    persist(connection);
    return desktopStatus();
  } catch (e) { if (e instanceof DesktopSetupError) throw e; return fail("runtime_failed"); }
  finally { connecting = false; }
}

export async function disconnectDesktop(): Promise<void> {
  if (connecting) return fail("busy");
  const previous = readConnection();
  persist({ version: 1, connected: false, generation: randomUUID(), runtime: previous?.runtime ?? "", workspace: previous?.workspace ?? defaultDesktopWorkspace(), models: [] });
  await closeZcodeDesktopClients();
}
