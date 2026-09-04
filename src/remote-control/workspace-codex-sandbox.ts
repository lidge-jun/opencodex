import { accessSync, constants, existsSync, openSync, closeSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { arch } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { inspectCodexShimBackingForCommand } from "../codex/shim";
import { findExecutableOnPath } from "./workspace-executable";
import { resolveCodexHomeDir } from "../codex/home";

function isNativeExecutable(path: string): boolean {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const header = Buffer.alloc(4);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
    return header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } catch {
    return false;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function packageRootForEntrypoint(path: string): string | null {
  let current = dirname(path);
  for (let depth = 0; depth < 10; depth += 1) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
        if (parsed.name === "@openai/codex") return current;
      } catch { /* keep walking */ }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function checkedNative(path: string): string | null {
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isFile() || !isNativeExecutable(canonical)) return null;
    accessSync(canonical, constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

function generatedShimBacking(path: string): string | null {
  try {
    const source = readFileSync(path, "utf8");
    if (Buffer.byteLength(source, "utf8") > 128 * 1024
      || !source.includes("# opencodex codex autostart shim")) return null;
    const match = /^exec '([^'\r\n]+)' "\$@"\s*$/m.exec(source);
    return match?.[1] && isAbsolute(match[1]) ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Permission profiles invoke the same native Codex binary under argv[0]
 * `codex-linux-sandbox`. npm and OpenCodex shims expose a JS/shell launcher instead,
 * so resolve the package-owned native binary without executing or modifying the install.
 */
export function resolveCodexLinuxSandboxBinary(command: string): string | null {
  if (process.platform !== "linux") return null;
  const selected = isAbsolute(command) ? command : findExecutableOnPath(command);
  if (!selected) return null;
  const shim = inspectCodexShimBackingForCommand(selected);
  const entrypoint = shim.status === "matched"
    ? shim.backingPath
    : generatedShimBacking(selected) ?? selected;
  const direct = checkedNative(entrypoint);
  if (direct) return direct;
  let canonical: string;
  try { canonical = realpathSync(entrypoint); } catch { return null; }
  const root = packageRootForEntrypoint(canonical);
  if (!root) return null;
  const target = arch() === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  const packageName = arch() === "arm64" ? "codex-linux-arm64" : "codex-linux-x64";
  const candidates = [
    join(root, "node_modules", "@openai", packageName, "vendor", target, "bin", "codex"),
    join(root, "vendor", target, "bin", "codex"),
  ];
  for (const candidate of candidates) {
    const native = checkedNative(candidate);
    if (native) return native;
  }
  return null;
}

export function codexRemotePermissionProfileCompatibility(
  codexHome = resolveCodexHomeDir(),
): { compatible: boolean; reason?: string } {
  const configPath = join(codexHome, "config.toml");
  if (!existsSync(configPath)) return { compatible: true };
  try {
    const metadata = statSync(configPath);
    if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024) {
      return { compatible: false, reason: "Codex config cannot be safely inspected for Remote Workspace permissions." };
    }
    const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (typeof config.sandbox_mode === "string" || config.sandbox_workspace_write !== undefined) {
      return {
        compatible: false,
        reason: "Codex Remote Workspace needs permission profiles, but this Codex config still selects legacy sandbox_mode.",
      };
    }
    return { compatible: true };
  } catch {
    return { compatible: false, reason: "Codex config could not be parsed for Remote Workspace permissions." };
  }
}
