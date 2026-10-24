import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { parseStrictSemver } from "../lib/strict-semver";
import { npmCodexCommandShim } from "./cli-installation-identity";
import { MAX_NATIVE_BACKING_BYTES } from "./cli-installation-limits";
import { deriveCodexCliInstallationInput } from "./cli-installation-targets";
import type { CodexCliInstallProvenanceDeps, CodexCliInstallReport } from "./cli-install-provenance";
import { resolveCodexRuntime } from "./runtime";
import { inspectWindowsInstallationFiles, type WindowsInstallationFilesResult } from "./windows-installation-files";

/** Private plan evidence. Explicit `attest` observations never enter this map. */
interface WindowsPlanEvidence { readonly node: string; readonly npmCli: string; readonly arch: "x64" | "arm64";
  readonly nodeEvidence: string; readonly npmEvidence: string }
const evidence = new WeakMap<CodexCliInstallReport, WindowsPlanEvidence>();
export const windowsCodexCliPlanEvidence = (report: CodexCliInstallReport): WindowsPlanEvidence | null => evidence.get(report) ?? null;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
type File = Extract<WindowsInstallationFilesResult, { kind: "observed" }>["files"][number];
const id = (file: File): string => JSON.stringify([file.path, file.identity, file.digest]);
const sameWindowsPath = (left: string, right: string): boolean => win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
/** Metadata queries execute only while the observed Node/npm and ancestors deny replacement. */
export async function withWindowsCodexCliPlanToolchain<R>(report: CodexCliInstallReport,
  run: () => R): Promise<Awaited<R> | null> {
  const toolchain = evidence.get(report);
  if (!toolchain) return null;
  let result: Awaited<R> | null = null;
  const observed = await inspectWindowsInstallationFiles([
    { path: toolchain.node, maxBytes: 128 * 1024 * 1024, hashOnly: true },
    { path: toolchain.npmCli, maxBytes: 256 * 1024 },
  ], async files => {
    if (id(files[0]!) !== toolchain.nodeEvidence || id(files[1]!) !== toolchain.npmEvidence) return false;
    result = await run(); return true;
  });
  return observed.kind === "observed" ? result : null;
}
const json = (file: File): Record<string, unknown> | null => {
  try { const item = JSON.parse(Buffer.from(file.bytes).toString("utf8"));
    return item && typeof item === "object" && !Array.isArray(item) ? item : null;
  } catch { return null; }
};
const entry = (item: Record<string, unknown>, name: string): unknown => typeof item.bin === "string" ? item.bin
  : item.bin && typeof item.bin === "object" ? (item.bin as Record<string, unknown>)[name] : null;
function peArch(bytes: Uint8Array): "x64" | "arm64" | null {
  const b = Buffer.from(bytes);
  if (b.length < 64 || b.toString("ascii", 0, 2) !== "MZ") return null;
  const offset = b.readUInt32LE(60);
  if (offset > b.length - 6 || b.toString("ascii", offset, offset + 4) !== "PE\0\0") return null;
  return b.readUInt16LE(offset + 4) === 0x8664 ? "x64" : b.readUInt16LE(offset + 4) === 0xaa64 ? "arm64" : null;
}

/**
 * Read-only supported subset: a proof-captured absolute standard npm cmd-shim
 * override, its global-prefix package, prefix-local Node/npm, and the prefix-local
 * optional backing. PATH-only Node selection remains refused until the snapshot
 * proves the target cmd-shim's cwd and search policy.
 */
export async function inspectWindowsCodexCliPlanInstall(
  deps: CodexCliInstallProvenanceDeps, fallback: CodexCliInstallReport, excluded: (path: string) => boolean,
): Promise<CodexCliInstallReport> {
  const env = deps.env ?? {};
  // The bounded content read is opt-in: a bare ownership check holds the same
  // reparse-refusing handles and identity set but streams no file content.
  const observe = deps.observeInstallContent === true;
  const candidate = env.CODEX_CLI_PATH?.trim();
  if (!deps.selectionAttested || !candidate || !/^[a-z]:[\\/]/i.test(candidate)
    || win32.basename(candidate) !== "codex.cmd"
    || (deps.selectedCommand != null && deps.selectedCommand !== candidate)) return fallback;
  const prefix = win32.dirname(candidate);
  const localNodePath = win32.join(prefix, "node.exe");
  const localNode = await inspectWindowsInstallationFiles([{ path: localNodePath, maxBytes: 0, metadataOnly: true }]);
  if (localNode.kind === "refused" && localNode.reason !== "not-found") return fallback;
  const selectedPath = env.PATH;
  const selectedPathExt = env.PATHEXT;
  const derivation = await deriveCodexCliInstallationInput({
    codexCliPath: candidate, path: selectedPath ?? null, pathExt: selectedPathExt ?? null,
  }, { platform: "win32" });
  if (derivation.kind !== "derived" || derivation.input.candidate !== candidate
    || derivation.input.npmPrefix !== prefix) return fallback;
  const node = derivation.input.node;
  const npmCli = derivation.input.npmCli;
  const npmRoot = win32.dirname(win32.dirname(npmCli));
  const pathNode = !sameWindowsPath(node, localNodePath);
  if (pathNode) return fallback;
  const root = win32.join(prefix, "node_modules", "@openai", "codex");
  const manifest = win32.join(root, "package.json");
  const npmManifest = win32.join(npmRoot, "package.json");
  const bin = win32.join(root, "bin", "codex.js");
  const paths = [candidate, node, npmCli, root];
  if (prefix === win32.parse(prefix).root || paths.some(excluded)) return fallback;
  // Only already handle-observed files can pass the real resolver's existence
  // predicate. The explicit override wins before saved-state/shim/PATH candidates.
  const selected = () => resolveCodexRuntime({ platform: "win32", env, configDir: deps.configDir,
    probeVersion: false, discoverAlternatives: false, existsSync: path => path === candidate,
    readFileSync: () => { throw new Error("state not required for explicit override"); },
    readdirSync: () => [], statSync: () => { throw new Error("discovery disabled"); },
  }).runtime.command === candidate && env.CODEX_CLI_PATH?.trim() === candidate;
  try {
    const first = await inspectWindowsInstallationFiles([
      { path: manifest, maxBytes: 256 * 1024 }, { path: npmManifest, maxBytes: 256 * 1024 },
      { path: node, maxBytes: 4096, prefixOnly: true },
    ]);
    if (first.kind !== "observed") return fallback;
    const initial = new Map(first.files.map(file => [file.path, file]));
    const main = json(initial.get(manifest)!); const npm = json(initial.get(npmManifest)!);
    const arch = peArch(initial.get(node)!.bytes);
    if (!main || main.name !== "@openai/codex" || typeof main.version !== "string" || !parseStrictSemver(main.version)
      || entry(main, "codex") !== "bin/codex.js" || !npm || npm.name !== "npm"
      || typeof npm.version !== "string" || !parseStrictSemver(npm.version) || entry(npm, "npm") !== "bin/npm-cli.js"
      || !arch || (deps.arch && deps.arch !== arch)) return fallback;
    const pkg = `@openai/codex-win32-${arch}`;
    const triple = arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc";
    // Node's nearest-first package lookup, bounded to this independent prefix.
    const lanes = [win32.join(root, "bin", "node_modules"), win32.join(root, "node_modules"),
      win32.join(prefix, "node_modules", "@openai", "node_modules"), win32.join(prefix, "node_modules")];
    const backingSelection = async (): Promise<string | null> => {
      for (const lane of lanes) {
        const path = win32.join(lane, pkg, "package.json");
        const probe = await inspectWindowsInstallationFiles([{ path, maxBytes: 0, metadataOnly: true }]);
        if (probe.kind === "observed") return path;
        if (probe.reason !== "not-found") return null;
      }
      return null; // No global module lookup or vendor fallback adoption.
    };
    const backingManifest = await backingSelection();
    if (!backingManifest) return fallback;
    const native = win32.join(win32.dirname(backingManifest), "vendor", triple, "bin", "codex.exe");
    // Ownership requires the manifests, shim and backing manifest bytes plus the
    // bounded Node header read above; entrypoint, npm CLI, Node and native
    // contents only feed the opt-in digest, so they stay metadata-held without it.
    const owned = (path: string) => ({ path, maxBytes: 256 * 1024 });
    const bound = (path: string) => observe ? { path, maxBytes: 256 * 1024 } : { path, maxBytes: 0, metadataOnly: true };
    const requests = [owned(manifest), owned(npmManifest), owned(candidate), bound(bin), bound(npmCli), owned(backingManifest)];
    const final = await inspectWindowsInstallationFiles([...requests,
      observe
        ? { path: node, maxBytes: 128 * 1024 * 1024, hashOnly: true }
        : { path: node, maxBytes: 0, metadataOnly: true },
      observe
        ? { path: native, maxBytes: MAX_NATIVE_BACKING_BYTES, hashOnly: true }
        : { path: native, maxBytes: 0, metadataOnly: true },
    ], async () => selected() && env.PATH === selectedPath && env.PATHEXT === selectedPathExt
      && await deriveCodexCliInstallationInput({ codexCliPath: candidate,
        path: selectedPath ?? null, pathExt: selectedPathExt ?? null }, { platform: "win32" })
        .then(current => current.kind === "derived" && current.input.candidate === candidate
          && current.input.npmPrefix === prefix && current.input.node === node && current.input.npmCli === npmCli)
      && await backingSelection() === backingManifest);
    if (final.kind !== "observed") return fallback;
    const files = new Map(final.files.map(file => [file.path, file]));
    if (!npmCodexCommandShim(files.get(candidate)!.bytes)) return fallback;
    for (const path of [manifest, npmManifest]) if (id(initial.get(path)!) !== id(files.get(path)!)) return fallback;
    if (JSON.stringify(initial.get(node)!.identity) !== JSON.stringify(files.get(node)!.identity)) return fallback;
    const backing = json(files.get(backingManifest)!);
    if (!backing || "exports" in backing || ![pkg, "@openai/codex"].includes(String(backing.name))
      || ![main.version, `${main.version}-win32-${arch}`].includes(String(backing.version))) return fallback;
    const content = observe ? hash(JSON.stringify(["windows-npm-read-only-plan-v2", arch, prefix, candidate, node, npmCli,
      ...final.files.map(file => [file.path, file.identity, file.digest])])) : null;
    const report: CodexCliInstallReport = Object.freeze({ ...fallback, managed: true, selectionAttested: true,
      provenance: "npm-global", reason: "managed_npm_global", packageVersion: main.version,
      versionEvidence: Object.freeze({ kind: "package-manifest" }), installDigest: hash(prefix),
      installContentDigest: content, shim: Object.freeze({ status: "not-tracked", backingKind: null }),
      evidence: Object.freeze(["package_manifest", "package_manifest_digest",
        ...(content ? ["install_content_digest" as const] : []), "global_npm_layout"] as const),
    });
    evidence.set(report, Object.freeze({ node, npmCli, arch, nodeEvidence: id(files.get(node)!), npmEvidence: id(files.get(npmCli)!) }));
    return report;
  } catch { return fallback; }
}
