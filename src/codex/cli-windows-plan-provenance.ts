import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { parseStrictSemver } from "../lib/strict-semver";
import { npmCodexCommandShim } from "./cli-installation-identity";
import { MAX_NATIVE_BACKING_BYTES } from "./cli-installation-limits";
import { deriveCodexCliInstallationInput } from "./cli-installation-targets";
import type { CodexCliInstallProvenanceDeps, CodexCliInstallReport } from "./cli-install-provenance";
import { resolveCodexRuntime } from "./runtime";
import { inspectWindowsInstallationFiles as inspectFiles, type WindowsInstallationFilesResult } from "./windows-installation-files";

// Every plan observation refuses alternate names, including aliases of ancestors.
const inspectWindowsInstallationFiles: typeof inspectFiles = (requests, finalize) =>
  inspectFiles(requests.map(request => ({ ...request, requireCanonicalPath: true })), finalize);

async function withCanonicalExclusionRoots<R>(roots: readonly string[], run: () => Promise<R>,
  onRefusal?: (reason: Extract<WindowsInstallationFilesResult, { kind: "refused" }>["reason"]) => void): Promise<R | null> {
  if (!roots.length) return run();
  let result: R | null = null;
  // Keep every exclusion open across the observation/query; validate each batch
  // under the native reader's existing request ceiling without dropping a root.
  const observed = await inspectWindowsInstallationFiles(roots.slice(0, 12).map(path => ({
    path: win32.normalize(path), maxBytes: 0, metadataOnly: true, directory: true,
  })), async () => {
    result = await withCanonicalExclusionRoots(roots.slice(12), run, onRefusal); return result !== null;
  });
  if (observed.kind === "refused") onRefusal?.(observed.reason);
  return observed.kind === "observed" ? result : null;
}

import { openWindowsCliToolchainAuthority, WindowsCliToolchainCleanupError } from "./cli-update-job-store-windows";

/** Private plan evidence. Explicit `attest` observations never enter this map. */
interface WindowsPlanEvidence { readonly node: string; readonly npmCli: string; readonly arch: "x64" | "arm64";
  readonly prefix: string; readonly launcher: string; readonly backingRoot: string;
  readonly envPath: string | undefined; readonly envPathExt: string | undefined;
  readonly nodeEvidence: string; readonly npmEvidence: string; readonly exclusionRoots: readonly string[] }
const evidence = new WeakMap<CodexCliInstallReport, WindowsPlanEvidence>();
const toolchainDigests = new WeakMap<CodexCliInstallReport, string>();
type WindowsPlanRefusalGate = "selection" | "exclusion-roots" | "local-node" | "derivation"
  | "launcher-arch" | "excluded-layout" | "initial-observation" | "initial-content"
  | "backing-selection" | "final-observation" | "shim-content" | "manifest-identity"
  | "node-identity" | "backing-content" | "exception";
type WindowsPlanRefusalReason = Extract<WindowsInstallationFilesResult, { kind: "refused" }>["reason"]
  | Extract<Awaited<ReturnType<typeof deriveCodexCliInstallationInput>>, { kind: "unavailable" }>["reason"];
interface WindowsPlanRefusal { readonly gate: WindowsPlanRefusalGate; readonly reason?: WindowsPlanRefusalReason }
const refusals = new WeakMap<CodexCliInstallReport, WindowsPlanRefusal>();
/** Test diagnostics only: fixed codes, never paths, exception messages or public report fields. */
export const windowsCodexCliPlanRefusalForTests = (report: CodexCliInstallReport): WindowsPlanRefusal | null => refusals.get(report) ?? null;
export const windowsCodexCliToolchainDigest = (report: CodexCliInstallReport): string | undefined => toolchainDigests.get(report);
export const windowsCodexCliPlanEvidence = (report: CodexCliInstallReport): WindowsPlanEvidence | null => evidence.get(report) ?? null;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
type File = Extract<WindowsInstallationFilesResult, { kind: "observed" }>["files"][number];
const id = (file: File): string => JSON.stringify([file.path, file.identity, file.digest]);
const sameWindowsPath = (left: string, right: string): boolean => win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
function selectedWindowsOverride(candidate: string, env: NodeJS.ProcessEnv, configDir?: string): boolean {
  return env.CODEX_CLI_PATH?.trim() === candidate && resolveCodexRuntime({ platform: "win32", env, configDir,
    probeVersion: false, discoverAlternatives: false, existsSync: path => path === candidate,
    readFileSync: () => { throw new Error("state not required for explicit override"); },
    readdirSync: () => [], statSync: () => { throw new Error("discovery disabled"); },
  }).runtime.command === candidate;
}
/** Synchronous selection fence after the last awaited authority check, before native start. */
export function windowsCodexCliSelectionMatches(report: CodexCliInstallReport, deps: CodexCliInstallProvenanceDeps): boolean {
  const captured = evidence.get(report), env = deps.env;
  return !!captured && !!env && deps.selectionAttested === true && env.PATH === captured.envPath
    && env.PATHEXT === captured.envPathExt && selectedWindowsOverride(captured.launcher, env, deps.configDir);
}
/** Metadata queries execute only while the observed Node/npm and ancestors deny replacement. */
export async function withWindowsCodexCliPlanToolchain<R>(report: CodexCliInstallReport,
  run: () => R): Promise<Awaited<R> | null> {
  const toolchain = evidence.get(report);
  if (!toolchain) return null;
  return withCanonicalExclusionRoots(toolchain.exclusionRoots, async () => {
  let authority;
  try { authority = await openWindowsCliToolchainAuthority(toolchain.node, win32.dirname(win32.dirname(toolchain.npmCli)), true); }
  catch (error) { if (error instanceof WindowsCliToolchainCleanupError) throw error; return null; }
  let result: Awaited<R> | null = null;
  try { const observed = await inspectWindowsInstallationFiles([
    { path: toolchain.node, maxBytes: 128 * 1024 * 1024, hashOnly: true },
    { path: toolchain.npmCli, maxBytes: 256 * 1024 },
  ], async files => {
    if (id(files[0]!) !== toolchain.nodeEvidence || id(files[1]!) !== toolchain.npmEvidence) return false;
    toolchainDigests.set(report, authority.digest);
    result = await run(); return true;
  });
  return observed.kind === "observed" ? result : null;
  } finally { if (!await authority.release()) throw new Error("toolchain_release_unverified"); }
  });
}

/** Transfer a held toolchain observation to a transaction, including unknown child lifetimes. */
export async function holdWindowsCodexCliPlanToolchain(report: CodexCliInstallReport) {
  const toolchain = evidence.get(report);
  if (!toolchain) return null;
  let authority;
  try { authority = await openWindowsCliToolchainAuthority(toolchain.node, win32.dirname(win32.dirname(toolchain.npmCli)), true); }
  catch (error) { if (error instanceof WindowsCliToolchainCleanupError) throw error; return null; }
  const admitted = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<void>();
  const observing = withCanonicalExclusionRoots(toolchain.exclusionRoots, () => inspectWindowsInstallationFiles([
    { path: toolchain.node, maxBytes: 128 * 1024 * 1024, hashOnly: true },
    { path: toolchain.npmCli, maxBytes: 256 * 1024 },
  ], async files => {
    if (id(files[0]!) !== toolchain.nodeEvidence || id(files[1]!) !== toolchain.npmEvidence) return false;
    admitted.resolve(true);
    await release.promise;
    return true;
  }));
  void observing.then(() => admitted.resolve(false), () => admitted.resolve(false));
  if (!await admitted.promise) { await authority.release(); return null; }
  return { async release() { release.resolve(); const observed = await observing;
    return await authority.release() && observed?.kind === "observed"; } };
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
 * override, its global-prefix package, a held-bound Node/npm toolchain, and the
 * in-prefix optional backing. When the prefix has no node.exe, the toolchain is
 * the npm pair the captured PATH resolves — the updater's own metadata vehicle,
 * never a claim about which interpreter a later codex.cmd invocation resolves:
 * the shim's bare `node` falls through to the ambient invocation working
 * directory, which no launcher snapshot can prove. A separate toolchain
 * therefore also requires the launcher arch anchor, keeping the backing lane
 * tied to the selection instead of to an arbitrary PATH hit.
 */
export async function inspectWindowsCodexCliPlanInstall(
  deps: CodexCliInstallProvenanceDeps, fallback: CodexCliInstallReport, excluded: (path: string) => boolean,
  exclusionRoots: readonly string[] = [],
): Promise<CodexCliInstallReport> {
  const refuse = (gate: WindowsPlanRefusalGate, reason?: WindowsPlanRefusalReason): CodexCliInstallReport => {
    refusals.set(fallback, Object.freeze(reason === undefined ? { gate } : { gate, reason }));
    return fallback;
  };
  const env = deps.env ?? {};
  const candidate = env.CODEX_CLI_PATH?.trim();
  if (!deps.selectionAttested || !candidate || !/^[a-z]:[\\/]/i.test(candidate)
    || win32.basename(candidate) !== "codex.cmd"
    || (deps.selectedCommand != null && deps.selectedCommand !== candidate)) return refuse("selection");
  if (exclusionRoots.length) {
    const roots = Object.freeze([...exclusionRoots]);
    let reason: WindowsPlanRefusalReason | undefined;
    const report = await withCanonicalExclusionRoots(roots,
      () => inspectWindowsCodexCliPlanInstall(deps, fallback, excluded), value => { reason ??= value; });
    if (report) {
      const toolchain = evidence.get(report);
      if (toolchain) evidence.set(report, Object.freeze({ ...toolchain, exclusionRoots: roots }));
    }
    return report ?? refuse("exclusion-roots", reason);
  }
  // The bounded content read is opt-in: a bare ownership check holds the same
  // reparse-refusing handles; only bounded ownership/header reads remain.
  const observe = deps.observeInstallContent === true;
  const prefix = win32.dirname(candidate);
  const localNodePath = win32.join(prefix, "node.exe");
  const localNode = await inspectWindowsInstallationFiles([{ path: localNodePath, maxBytes: 0, metadataOnly: true }]);
  if (localNode.kind === "refused" && localNode.reason !== "not-found") return refuse("local-node", localNode.reason);
  const selectedPath = env.PATH;
  const selectedPathExt = env.PATHEXT;
  const derivation = await deriveCodexCliInstallationInput({
    codexCliPath: candidate, path: selectedPath ?? null, pathExt: selectedPathExt ?? null,
  }, { platform: "win32" });
  if (derivation.kind !== "derived" || derivation.input.candidate !== candidate
    || derivation.input.npmPrefix !== prefix) return refuse("derivation", derivation.kind === "unavailable" ? derivation.reason : undefined);
  const node = derivation.input.node;
  const npmCli = derivation.input.npmCli;
  const npmRoot = win32.dirname(win32.dirname(npmCli));
  const pathNode = !sameWindowsPath(node, localNodePath);
  // A prefix-local node.exe is provably the shim's own interpreter; a PATH-resolved
  // separate toolchain is bound as the updater's metadata vehicle only. Without the
  // launcher arch the toolchain's arch cannot be tied to the selection at all, so a
  // separate toolchain stays refused rather than claim an unanchored backing lane.
  if (pathNode && !deps.arch) return refuse("launcher-arch");
  const root = win32.join(prefix, "node_modules", "@openai", "codex");
  const manifest = win32.join(root, "package.json");
  const npmManifest = win32.join(npmRoot, "package.json");
  const bin = win32.join(root, "bin", "codex.js");
  const paths = [candidate, node, npmCli, root];
  if (prefix === win32.parse(prefix).root || paths.some(excluded)) return refuse("excluded-layout");
  // Only already handle-observed files can pass the real resolver's existence
  // predicate. The explicit override wins before saved-state/shim/PATH candidates.
  const selected = () => selectedWindowsOverride(candidate, env, deps.configDir);
  try {
    const first = await inspectWindowsInstallationFiles([
      { path: manifest, maxBytes: 256 * 1024 }, { path: npmManifest, maxBytes: 256 * 1024 },
      { path: node, maxBytes: 4096, prefixOnly: true },
    ]);
    if (first.kind !== "observed") return refuse("initial-observation", first.reason);
    const initial = new Map(first.files.map(file => [file.path, file]));
    const main = json(initial.get(manifest)!); const npm = json(initial.get(npmManifest)!);
    const arch = peArch(initial.get(node)!.bytes);
    if (!main || main.name !== "@openai/codex" || typeof main.version !== "string" || !parseStrictSemver(main.version)
      || entry(main, "codex") !== "bin/codex.js" || !npm || npm.name !== "npm"
      || typeof npm.version !== "string" || !parseStrictSemver(npm.version) || entry(npm, "npm") !== "bin/npm-cli.js"
      || !arch || (deps.arch && deps.arch !== arch)) return refuse("initial-content");
    const pkg = `@openai/codex-win32-${arch}`;
    const triple = arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc";
    // Node's nearest-first package lookup, bounded to this independent prefix.
    const lanes = [win32.join(root, "bin", "node_modules"), win32.join(root, "node_modules"),
      win32.join(prefix, "node_modules", "@openai", "node_modules"), win32.join(prefix, "node_modules")];
    let backingRefusal: WindowsPlanRefusalReason | undefined;
    const backingSelection = async (): Promise<string | null> => {
      for (const lane of lanes) {
        const path = win32.join(lane, pkg, "package.json");
        const probe = await inspectWindowsInstallationFiles([{ path, maxBytes: 0, metadataOnly: true }]);
        if (probe.kind === "observed") return path;
        if (probe.reason !== "not-found") { backingRefusal = probe.reason; return null; }
      }
      return null; // No global module lookup or vendor fallback adoption.
    };
    const backingManifest = await backingSelection();
    if (!backingManifest) return refuse("backing-selection", backingRefusal ?? "not-found");
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
    if (final.kind !== "observed") return refuse("final-observation", backingRefusal ?? final.reason);
    const files = new Map(final.files.map(file => [file.path, file]));
    if (!npmCodexCommandShim(files.get(candidate)!.bytes)) return refuse("shim-content");
    for (const path of [manifest, npmManifest]) if (id(initial.get(path)!) !== id(files.get(path)!)) return refuse("manifest-identity");
    if (JSON.stringify(initial.get(node)!.identity) !== JSON.stringify(files.get(node)!.identity)) return refuse("node-identity");
    const backing = json(files.get(backingManifest)!);
    if (!backing || "exports" in backing || ![pkg, "@openai/codex"].includes(String(backing.name))
      || ![main.version, `${main.version}-win32-${arch}`].includes(String(backing.version))) return refuse("backing-content");
    const content = observe ? hash(JSON.stringify(["windows-npm-read-only-plan-v3", arch, prefix, candidate, node, npmCli,
      ...final.files.map(file => [file.path, file.identity, file.digest])])) : null;
    const report: CodexCliInstallReport = Object.freeze({ ...fallback, managed: true, selectionAttested: true,
      provenance: "npm-global", reason: "managed_npm_global", packageVersion: main.version,
      versionEvidence: Object.freeze({ kind: "package-manifest" }), installDigest: hash(prefix),
      installContentDigest: content, shim: Object.freeze({ status: "not-tracked", backingKind: null }),
      evidence: Object.freeze(["package_manifest", "package_manifest_digest",
        ...(content ? ["install_content_digest" as const] : []), "global_npm_layout"] as const),
    });
    evidence.set(report, Object.freeze({ node, npmCli, arch, prefix, launcher: candidate,
      envPath: selectedPath, envPathExt: selectedPathExt,
      backingRoot: win32.dirname(backingManifest), nodeEvidence: id(files.get(node)!), npmEvidence: id(files.get(npmCli)!), exclusionRoots: Object.freeze([]) }));
    return report;
  } catch { return refuse("exception"); }
}
