import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getConfigDir } from "../config";
import { tryAcquireShimRestoreLock } from "../codex/shim-restore-lock";
import { findExecutableOnPath } from "../remote-control/workspace-executable";
import { CLAUDE_SHIM_MARKER, findNativePosixClaude, supportsClaudeShim } from "./native-executable";

const names = ["claude", "activate.sh", "receipt.json"] as const;
const quote = (s: string): string => "'" + s.replaceAll("'", "'\\''") + "'";
const digest = (s: string): string => createHash("sha256").update(s).digest("hex");
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

function privateEntry(path: string, directory: boolean, mode: number): void {
  const s = lstatSync(path);
  if ((directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
      || s.uid !== process.getuid?.() || (s.mode & 0o777) !== mode) {
    throw new Error(`Unsafe or foreign Claude shim entry: ${path}`);
  }
}

function contents(path: string, mode: number): string {
  privateEntry(path, false, mode);
  if (lstatSync(path).size > 8192) throw new Error("Unexpected Claude shim artifact size.");
  return readFileSync(path, "utf8");
}

function inspect(root: string): boolean {
  try { privateEntry(root, true, 0o700); } catch (error) { if (missing(error)) return false; throw error; }
  if (readdirSync(root).sort().join(",") !== [...names].sort().join(",")) {
    throw new Error("Unexpected Claude shim directory contents; leaving them untouched.");
  }
  const receipt = contents(join(root, "receipt.json"), 0o600);
  const wrapper = contents(join(root, "claude"), 0o700);
  const activation = contents(join(root, "activate.sh"), 0o600);
  if (!wrapper.startsWith(`#!/bin/sh\n${CLAUDE_SHIM_MARKER}\n`) || receipt !== JSON.stringify([digest(wrapper), digest(activation)])) {
    throw new Error("Claude shim no longer matches its receipt; leaving it untouched.");
  }
  return true;
}

export function claudeShimRoot(): string {
  return join(resolve(getConfigDir()), "claude-shim");
}

export function hasManagedClaudeShim(): boolean {
  try { return supportsClaudeShim() && inspect(claudeShimRoot()); } catch { return false; }
}

/** Private overlay only. An atomic directory rename makes all files visible together. */
export function manageClaudeShim(args: readonly string[]): number {
  if (args.length !== 1 || !["install", "status", "uninstall"].includes(args[0]!)) {
    console.error("Usage: ocx claude-shim <install|status|uninstall>");
    return 2;
  }
  if (!supportsClaudeShim()) {
    console.error("Claude command shims are supported on Linux and macOS.");
    return 1;
  }
  const root = claudeShimRoot();
  const activation = join(root, "activate.sh");
  const wrapper = join(root, "claude");
  const action = args[0];
  try {
    if (action === "status") {
      if (!inspect(root)) { console.log("Claude shim: not installed"); return 0; }
      const selected = findExecutableOnPath("claude");
      const target = selected ? statSync(selected, { bigint: true }) : undefined;
      const own = statSync(wrapper, { bigint: true });
      console.log(`Claude shim: installed, ${target?.dev === own.dev && target?.ino === own.ino ? "active" : "inactive on PATH"}`);
      console.log(`Native Claude: ${findNativePosixClaude() ?? "not found"}\nActivation: . ${quote(activation)}`);
      return 0;
    }
    const home = dirname(root);
    if (action === "uninstall" && !inspect(root)) { console.log("Claude shim: not installed"); return 0; }
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const parent = lstatSync(home);
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022)) {
      throw new Error("Claude shim requires a user-owned OpenCodex home that is not group/world writable.");
    }
    const lock = `${root}.lock`;
    const lease = tryAcquireShimRestoreLock(undefined, lock);
    if (!lease) throw new Error(`Claude shim lock is busy or its owner cannot be verified: ${lock}. Retry after the owner exits. For an ownerless lock, verify that no shim operation is running before removing the empty lock directory.`);
    try {
      const installed = inspect(root);
      if (action === "install") {
        if (!installed) {
          const launcher = findExecutableOnPath("ocx");
          if (!launcher || !isAbsolute(launcher) || !findNativePosixClaude()) throw new Error("Put native Claude and the installed ocx launcher on PATH first.");
          const data = `#!/bin/sh\n${CLAUDE_SHIM_MARKER}\nOPENCODEX_HOME=${quote(home)} exec ${quote(launcher)} internal claude-shim-launch -- "$@"\n`;
          const env = `# Activate the OpenCodex Claude command shim\ncase "$PATH" in\n  ${quote(root)}|${quote(root)}:*) ;;\n  *) export PATH=${quote(root)}\${PATH:+:$PATH} ;;\nesac\n`;
          const stage = mkdtempSync(`${root}.stage-`);
          try {
            writeFileSync(join(stage, "claude"), data, { mode: 0o700, flag: "wx" });
            writeFileSync(join(stage, "activate.sh"), env, { mode: 0o600, flag: "wx" });
            writeFileSync(join(stage, "receipt.json"), JSON.stringify([digest(data), digest(env)]), { mode: 0o600, flag: "wx" });
            inspect(stage);
            renameSync(stage, root);
          } finally { rmSync(stage, { recursive: true, force: true }); }
        }
        console.log(`Claude shim: installed\nActivation: . ${quote(activation)}\nExecutable: ${wrapper}`);
      } else if (installed) {
        // Quarantine before removing so PATH never sees a partly uninstalled wrapper.
        const stage = mkdtempSync(`${root}.remove-`);
        const owned = join(stage, "owned");
        let deleted = false;
        try {
          renameSync(root, owned);
          if (!inspect(owned)) throw new Error("Claude shim changed during removal.");
          for (const name of names) { unlinkSync(join(owned, name)); deleted = true; }
          rmdirSync(owned);
        } catch (error) {
          if (deleted) throw new Error(`Claude shim removal interrupted; retained files at ${owned}`);
          if (readdirSync(stage).includes("owned")) {
            try { renameSync(owned, root); } catch { throw new Error(`Claude shim removal interrupted; retained files at ${owned}`); }
          }
          throw error;
        } finally {
          if (readdirSync(stage).length === 0) rmdirSync(stage);
        }
        console.log("Claude shim removed. Remove any activation line you added and refresh your shell command cache.");
      }
      return 0;
    } finally { lease.release(); }
  } catch (error) {
    console.error(`Claude shim: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
