import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareStrictSemver, parseStrictSemver } from "../lib/strict-semver";
import { npmInvocation } from "../update/npm-invocation.mjs";
import {
  inspectCodexCliInstall,
  type CodexCliInstallKind,
  type CodexCliInstallProvenanceDeps,
  type CodexCliInstallReport,
} from "./cli-install-provenance";
import {
  scanCodexSessionProcesses,
  type CodexAppServerProcessIo,
  type CodexAppServerProcessScan,
} from "./app-server-processes";

/**
 * Phase 2 of the Codex CLI update manager: a deterministic dry-run plan.
 *
 * Phase 1 ({@link inspectCodexCliInstall}) answers who owns the installation. It never
 * queries a registry, never enumerates processes and never writes. This module adds the
 * three inputs it deliberately left out — an exact resolved target with registry
 * integrity, live session blockers, and a decision — and nothing else.
 *
 * Two invariants shape the whole module:
 *
 *  - No persisted state. The plan is not stored anywhere; {@link CodexCliUpdatePlan.planId}
 *    is a digest over the evidence the decision rests on, so an approved change to any
 *    bound field produces a different id.
 *  - Nothing is terminated or restarted. A live Codex session refuses the plan; it is
 *    never signalled, killed or waited on. The plan performs no application-state
 *    mutation: it resolves registry metadata and reads the process table under a
 *    temporary isolated npm root (cwd, npmrc, cache and logs) that is removed
 *    afterwards; a forcibly terminated run may leave that temp root behind, so the
 *    cleanup contract is best-effort rather than absolute.
 */

export const CODEX_CLI_PACKAGE = "@openai/codex";
export const CODEX_CLI_UPDATE_SCHEMA_VERSION = 1 as const;

/**
 * The one registry this workflow is allowed to resolve, pack and install from.
 *
 * npm view/pack inherit the operator's npm configuration by default, so a project or
 * user .npmrc — or an npm_config_* env var — can redirect "@openai/codex" to another
 * registry whose version query, integrity query and tarball all agree with each
 * other. Every npm call below pins this registry explicitly AND runs with the
 * registry-affecting configuration isolated, so the pinned origin is the only source
 * the evidence can come from.
 */
export const CODEX_CLI_REGISTRY = "https://registry.npmjs.org";

/** Only the stable channel is exposed; a moving dist-tag is resolved before it is used. */
export type CodexCliUpdateChannel = "latest";

export type CodexCliUpdateRefusal =
  | "windows_inspection_deferred"
  | "not_managed"
  | "installed_version_unverified"
  | "target_unresolved"
  | "already_current"
  | "target_not_newer"
  | "blocked_active_session"
  | "blocked_process_state_unknown";

/**
 * `not-evaluated` is not a weaker `unknown`: it records that the plan was already refused
 * on ownership or target grounds, so the process table was never read. Only `unknown`
 * means an enumeration attempt failed.
 */
export type CodexCliUpdateSessionState = "none" | "active" | "unknown" | "not-evaluated";

export interface CodexCliUpdateSession {
  readonly state: CodexCliUpdateSessionState;
  /** Match count only. Command lines and paths never leave the process scanner. */
  readonly matches: number | null;
}

export type CodexCliUpdateTarget =
  | Readonly<{ kind: "resolved"; version: string; integrity: string }>
  | Readonly<{ kind: "unresolved"; reason: string }>;

export interface CodexCliUpdatePlan {
  readonly schemaVersion: typeof CODEX_CLI_UPDATE_SCHEMA_VERSION;
  readonly package: typeof CODEX_CLI_PACKAGE;
  readonly channel: CodexCliUpdateChannel;
  readonly applicable: boolean;
  readonly refusal: CodexCliUpdateRefusal | null;
  /** Present only for an applicable plan; there is nothing to quote for a refusal. */
  readonly planId: string | null;
  readonly provenance: CodexCliInstallKind;
  readonly managed: boolean;
  readonly installedVersion: string | null;
  readonly versionEvidence: CodexCliInstallReport["versionEvidence"]["kind"];
  readonly location: string | null;
  readonly targetVersion: string | null;
  readonly targetIntegrity: string | null;
  readonly session: CodexCliUpdateSession;
  /** Indicative install argv for the operator to read; the apply phase this plan precedes verifies a packed tarball against the bound sha512 rather than trusting a moving spec. */
  readonly command: readonly string[] | null;
}

export interface CodexCliUpdatePlanDeps {
  readonly inspect?: (deps: CodexCliInstallProvenanceDeps) => Promise<CodexCliInstallReport>;
  readonly inspectionDeps?: CodexCliInstallProvenanceDeps;
  readonly platform?: NodeJS.Platform;
  readonly channel?: CodexCliUpdateChannel;
  readonly scanProcesses?: (io?: CodexAppServerProcessIo) => CodexAppServerProcessScan;
  readonly processIo?: CodexAppServerProcessIo;
  readonly resolveTarget?: (channel: CodexCliUpdateChannel) => CodexCliUpdateTarget;
  readonly spawnProcess?: typeof spawnSync;
}


const PLAN_ID_LENGTH = 32;
const PLAN_ID_RE = /^[0-9a-f]{32}$/;
const REGISTRY_TIMEOUT_MS = 12_000;
const SHA512_INTEGRITY_RE = /^sha512-[A-Za-z0-9+/=]+$/;

/** The install argv this plan quotes for the operator to read, in argv form. */
export function codexCliUpdateCommand(version: string): readonly string[] {
  // The displayed command must reproduce the artifact the plan bound: without the
  // pinned registry the operator's npmrc could silently substitute another origin
  // for the same package@version string.
  return Object.freeze([
    "npm",
    "install",
    "-g",
    "--registry=" + CODEX_CLI_REGISTRY,
    `${CODEX_CLI_PACKAGE}@${version}`,
  ]);
}

/**
 * Digest over exactly the evidence the decision rests on.
 *
 * Session blockers are deliberately absent: a session that starts or ends between dry-run
 * and a later apply must not invalidate an otherwise identical plan; it is re-read where
 * it can only ever refuse. Everything else — ownership, installed version,
 * location, resolved target, integrity — is bound, so any drift produces a different id.
 */
export function codexCliUpdatePlanId(bound: {
  readonly platform: NodeJS.Platform;
  readonly provenance: CodexCliInstallKind;
  readonly installedVersion: string;
  readonly installDigest: string | null;
  readonly channel: CodexCliUpdateChannel;
  readonly targetVersion: string;
  readonly targetIntegrity: string;
}): string {
  // Ordered pairs, not object key order: the digest must not depend on how a caller
  // happened to build the record.
  const fields: readonly (readonly [string, string])[] = [
    ["schemaVersion", String(CODEX_CLI_UPDATE_SCHEMA_VERSION)],
    ["package", CODEX_CLI_PACKAGE],
    ["platform", bound.platform],
    ["provenance", bound.provenance],
    ["installedVersion", bound.installedVersion],
    ["installDigest", bound.installDigest ?? ""],
    ["channel", bound.channel],
    ["targetVersion", bound.targetVersion],
    ["targetIntegrity", bound.targetIntegrity],
  ];
  const hash = createHash("sha256");
  for (const [key, value] of fields) hash.update(`${key}=${value}\n`);
  return hash.digest("hex").slice(0, PLAN_ID_LENGTH);
}

interface NpmTarget {
  readonly bin: string;
  readonly args: string[];
  readonly options: {
    readonly windowsVerbatimArguments?: boolean;
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  };
}

function npmTarget(args: readonly string[], env?: NodeJS.ProcessEnv): NpmTarget | null {
  const invocation = npmInvocation(args, process.platform, env ?? process.env);
  if (!invocation) return null;
  return { bin: invocation.file, args: invocation.args, options: invocation.options };
}

/**
 * The npm environment with every registry-affecting config channel removed.
 *
 * npm maps any npm_config_* env var into its configuration, so NPM_CONFIG_REGISTRY or
 * npm_config_@openai:registry would defeat the pinned --registry flag (a scoped
 * registry beats the default for that scope). They are all stripped. The settings
 * this codebase intentionally supports survive untouched: the standard proxy
 * variables npm itself honors (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY, any case)
 * and NODE_EXTRA_CA_CERTS, which npm's own Node runtime reads for TLS.
 *
 * Node's own startup channels are stripped too. npm runs inside Node, so ambient
 * NODE_OPTIONS injects code before the first npm line, NODE_PATH redirects module
 * resolution, and NODE_TLS_REJECT_UNAUTHORIZED would make the pinned-registry TLS
 * check void - each one reaches the evidence-producing process unless removed.
 * NODE_V8_COVERAGE and NODE_REDIRECT_WARNINGS are dropped for the same reason in
 * reverse: they are output paths, so ambient values would write Node artifacts to
 * arbitrary external directories on exit. ELF/Darwin loader controls (LD_* and
 * DYLD_*) are also removed: they can load code or redirect loader output before
 * npm runs. This is a denylist for process-startup/output channels, not a claim
 * that every ambient variable is allowlisted. Ordinary OS environment, proxy
 * settings and the supported NODE_EXTRA_CA_CERTS extension remain available.
 */
const NPM_ENV_DROP_KEYS: ReadonlySet<string> = new Set([
  "node_options",
  "node_path",
  "node_tls_reject_unauthorized",
  "node_compile_cache",
  // Output-path channels: ambient values would make the Node process write
  // coverage JSON or warning output to an arbitrary external directory on exit,
  // escaping the owned temp root regardless of the isolated --cache.
  "node_v8_coverage",
  "node_redirect_warnings",
]);

function codexCliUpdateNpmEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("npm_config_") || lower.startsWith("ld_")
      || lower.startsWith("dyld_") || NPM_ENV_DROP_KEYS.has(lower)) delete env[key];
  }
  return env;
}

/**
 * Ambient environment with the executable-selection channels replaced by the proof-bound
 * launcher snapshot. HOME, proxy variables and NODE_EXTRA_CA_CERTS stay ambient because npm
 * itself needs them; PATH/PATHEXT are the channels a project dotenv could use to supply a
 * fake npm, so they come only from the captured snapshot. A snapshot without PATH means no
 * trusted PATH at all — an empty one fails the spawn closed rather than falling back.
 */
function codexCliUpdateBoundEnv(bound: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const merged = codexCliUpdateNpmEnv();
  if (bound === undefined) return merged;
  for (const key of Object.keys(merged)) {
    const k = key.toLowerCase();
    if (k === "path" || k === "pathext") delete merged[key];
  }
  let hasTrustedPath = false;
  for (const [key, value] of Object.entries(bound)) {
    const k = key.toLowerCase();
    if ((k === "path" || k === "pathext") && value !== undefined) {
      merged[key] = value;
      if (k === "path") hasTrustedPath = true;
    }
  }
  // A trusted snapshot without PATH means "no trusted PATH", not "keep the ambient
  // one". Install the empty value explicitly so executable resolution fails closed
  // instead of silently re-inheriting a PATH the proof never attested.
  if (!hasTrustedPath) merged.PATH = "";
  return merged;
}

interface NpmConfigIsolation {
  /** Controlled cwd: contains the sentinel package.json, so npm's project-config walk stops here. */
  readonly dir: string;
  /** Distinct empty files: npm refuses to load one path at two configuration levels. */
  readonly npmrc: string;
  readonly globalNpmrc: string;
  /** npm cache root under dir: keeps _cacache and _logs inside the owned root so a
   *  successful query cannot leave residue in the ambient ~/.npm. */
  readonly cache: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * A directory npm cannot read hostile configuration through.
 *
 * npm resolves project config from the nearest ancestor containing package.json (or
 * node_modules/.git), so a bare temp dir is NOT enough — the walk would continue into
 * the operator's real ancestors. The sentinel package.json anchors the walk here,
 * where no .npmrc exists. --userconfig/--globalconfig replace the two file configs,
 * and the env filter removes the env-var channel. What remains is exactly the pinned
 * --registry flag plus deliberately supported proxy/CA env.
 */
function createNpmConfigIsolation(dir?: string, boundEnv?: NodeJS.ProcessEnv): NpmConfigIsolation {
  const ownsRoot = dir === undefined;
  const root = dir ?? mkdtempSync(join(tmpdir(), "ocx-codex-cli-meta-"));
  try {
    writeFileSync(join(root, "package.json"), "{}\n");
    const npmrc = join(root, "ocx-update.npmrc");
    writeFileSync(npmrc, "");
    const globalNpmrc = join(root, "ocx-update-global.npmrc");
    writeFileSync(globalNpmrc, "");
    const cache = join(root, "npm-cache");
    return { dir: root, npmrc, globalNpmrc, cache, env: codexCliUpdateBoundEnv(boundEnv) };
  } catch (error) {
    // A mid-setup failure must not leak a directory this call created; a
    // caller-supplied directory stays the caller's responsibility.
    if (ownsRoot) rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Registry-pinned, config-isolated argv for one npm call. */
function isolatedNpmArgs(args: readonly string[], isolation: NpmConfigIsolation): readonly string[] {
  return [
    ...args,
    "--registry=" + CODEX_CLI_REGISTRY,
    "--userconfig=" + isolation.npmrc,
    "--globalconfig=" + isolation.globalNpmrc,
    "--cache=" + isolation.cache,
  ];
}

function isolatedNpmTarget(args: readonly string[], isolation: NpmConfigIsolation): NpmTarget | null {
  const target = npmTarget(isolatedNpmArgs(args, isolation), isolation.env);
  if (!target) return null;
  return {
    bin: target.bin,
    args: target.args,
    options: { ...target.options, cwd: isolation.dir, env: isolation.env },
  };
}

/**
 * Resolve the channel to one exact version plus its sha512 integrity token.
 *
 * OpenCodex's own updater treats a failed integrity query as `skipped` and proceeds
 * best-effort. That is a defensible trade for the package we publish ourselves; it is not
 * acceptable for a foreign package we are about to install on the operator's behalf, so
 * every failure lane here is a refusal.
 */
export function resolveCodexCliUpdateTarget(
  channel: CodexCliUpdateChannel,
  spawn: typeof spawnSync = spawnSync,
  /** Proof-bound launcher snapshot env; executable resolution reads only its PATH/PATHEXT. */
  boundEnv?: NodeJS.ProcessEnv,
): CodexCliUpdateTarget {
  // The pinned registry and the isolation directory together are the boundary: the
  // version, the integrity token and the tarball URL all come from npmjs or the
  // target is unresolved — a redirected answer can never be the evidence.
  let isolation: NpmConfigIsolation;
  try {
    isolation = createNpmConfigIsolation(undefined, boundEnv);
  } catch {
    // Setup failures are a refusal lane like every other resolve failure, not an
    // exception escaping the dry-run.
    return Object.freeze({ kind: "unresolved" as const, reason: "npm configuration isolation setup failed" });
  }
  try {
    const runView = (field: string, spec: string): SpawnSyncReturns<string> | null => {
      const target = isolatedNpmTarget(["view", spec, field], isolation);
      if (!target) return null;
      return spawn(target.bin, target.args, {
        encoding: "utf8",
        timeout: REGISTRY_TIMEOUT_MS,
        windowsHide: true,
        ...target.options,
      });
    };

    const versionRun = runView("version", `${CODEX_CLI_PACKAGE}@${channel}`);
    if (!versionRun) return Object.freeze({ kind: "unresolved" as const, reason: "npm executable was not found on a trusted PATH entry" });
    // status === null covers a timeout as well as a spawn failure.
    if (versionRun.status !== 0) {
      return Object.freeze({ kind: "unresolved" as const, reason: `registry version query failed (status ${versionRun.status ?? "timeout"})` });
    }
    const version = (versionRun.stdout ?? "").trim();
    if (!parseStrictSemver(version)) {
      return Object.freeze({ kind: "unresolved" as const, reason: "registry returned no exact version" });
    }

    const integrityRun = runView("dist.integrity", `${CODEX_CLI_PACKAGE}@${version}`);
    if (!integrityRun) return Object.freeze({ kind: "unresolved" as const, reason: "npm executable was not found on a trusted PATH entry" });
    if (integrityRun.status !== 0) {
      return Object.freeze({ kind: "unresolved" as const, reason: `registry integrity query failed (status ${integrityRun.status ?? "timeout"})` });
    }
    // `dist.integrity` may arrive quoted or as a space-separated multi-hash list.
    const tokens = (integrityRun.stdout ?? "").replace(/["']/g, "").trim().split(/\s+/).filter(Boolean);
    const integrity = tokens.find(token => SHA512_INTEGRITY_RE.test(token));
    if (!integrity) {
      return Object.freeze({ kind: "unresolved" as const, reason: "registry returned no sha512 integrity token" });
    }

    // The digest binds the tarball's CONTENT; this binds its ORIGIN. A registry
    // answer whose tarball lives outside the pinned registry is not the artifact
    // the plan approved, even if its sha512 matched.
    const tarballRun = runView("dist.tarball", `${CODEX_CLI_PACKAGE}@${version}`);
    if (!tarballRun) return Object.freeze({ kind: "unresolved" as const, reason: "npm executable was not found on a trusted PATH entry" });
    if (tarballRun.status !== 0) {
      return Object.freeze({ kind: "unresolved" as const, reason: `registry tarball query failed (status ${tarballRun.status ?? "timeout"})` });
    }
    const tarball = (tarballRun.stdout ?? "").replace(/["']/g, "").trim();
    let tarballOrigin: string | null = null;
    try {
      tarballOrigin = new URL(tarball).origin;
    } catch {
      tarballOrigin = null;
    }
    if (tarballOrigin !== CODEX_CLI_REGISTRY) {
      return Object.freeze({ kind: "unresolved" as const, reason: "registry returned a tarball outside the official registry origin" });
    }
    return Object.freeze({ kind: "resolved" as const, version, integrity });
  } finally {
    rmSync(isolation.dir, { recursive: true, force: true });
  }
}

function refusedPlan(
  refusal: CodexCliUpdateRefusal,
  report: CodexCliInstallReport,
  channel: CodexCliUpdateChannel,
  target: CodexCliUpdateTarget | null,
  session: CodexCliUpdateSession,
): CodexCliUpdatePlan {
  return Object.freeze({
    schemaVersion: CODEX_CLI_UPDATE_SCHEMA_VERSION,
    package: CODEX_CLI_PACKAGE,
    channel,
    applicable: false,
    refusal,
    planId: null,
    provenance: report.provenance,
    managed: report.managed,
    installedVersion: report.packageVersion,
    versionEvidence: report.versionEvidence.kind,
    location: report.location,
    targetVersion: target?.kind === "resolved" ? target.version : null,
    targetIntegrity: target?.kind === "resolved" ? target.integrity : null,
    session,
    command: null,
  });
}

const NOT_EVALUATED: CodexCliUpdateSession = Object.freeze({ state: "not-evaluated" as const, matches: null });

/**
 * Build the dry-run plan. Installs nothing and mutates no application state;
 * registry evidence is gathered under a temporary isolated npm root whose cache,
 * logs, npmrc and cwd are all inside it and removed best-effort afterwards.
 *
 * The refusal order is deliberate. Ownership and target questions are settled before the
 * process table is read, so a machine that can never be updated by this workflow does not
 * pay for an enumeration, and the reported refusal is the decisive one rather than
 * whichever check happened to run first.
 */
export async function createCodexCliUpdatePlan(deps: CodexCliUpdatePlanDeps = {}): Promise<CodexCliUpdatePlan> {
  const channel: CodexCliUpdateChannel = deps.channel ?? "latest";
  const platform = deps.platform ?? process.platform;
  const inspect = deps.inspect ?? inspectCodexCliInstall;
  const report = await inspect(deps.inspectionDeps ?? {});

  // Phase 1 performs no candidate filesystem I/O at all on Windows, so there is no
  // ownership evidence to build a plan on. This stays dormant until the handle-bound
  // provenance layer exists; pretending otherwise would require exactly the reads phase 1
  // refused to perform.
  if (platform === "win32" || report.reason === "windows_inspection_deferred") {
    return refusedPlan("windows_inspection_deferred", report, channel, null, NOT_EVALUATED);
  }
  if (!report.managed || report.provenance !== "npm-global") {
    return refusedPlan("not_managed", report, channel, null, NOT_EVALUATED);
  }
  // An advisory runtime string is what a candidate binary said about itself. Only
  // package-manifest evidence states what is installed on disk, and only that can be
  // compared with a registry version or read back after an install.
  const installedVersion = report.versionEvidence.kind === "package-manifest" ? report.packageVersion : null;
  const installedSemver = installedVersion ? parseStrictSemver(installedVersion) : null;
  if (!installedVersion || !installedSemver) {
    return refusedPlan("installed_version_unverified", report, channel, null, NOT_EVALUATED);
  }

  // The npm evidence channels are bound to the same environment snapshot the
  // ownership inspection ran against: PATH/PATHEXT from the proof-bound launcher
  // context, never the ambient ones a project dotenv could point at a fake npm.
  // When the caller had no trusted snapshot, inspectionDeps.env is the fail-closed
  // { PATH: "" } form, so this resolution cannot silently fall back to ambient.
  const resolveTarget = deps.resolveTarget
    ?? (ch => resolveCodexCliUpdateTarget(ch, deps.spawnProcess ?? spawnSync, deps.inspectionDeps?.env));
  const target = resolveTarget(channel);
  if (target.kind !== "resolved") {
    return refusedPlan("target_unresolved", report, channel, target, NOT_EVALUATED);
  }
  // Raw equality is not the gate: a resolved target must advance the installed
  // version by semver precedence. Equal versions are already current and lower
  // ones are refused rather than applied as a silent downgrade.
  const targetSemver = parseStrictSemver(target.version);
  if (!targetSemver) {
    return refusedPlan("target_unresolved", report, channel, target, NOT_EVALUATED);
  }
  const versionOrder = compareStrictSemver(targetSemver, installedSemver);
  if (versionOrder === 0) {
    return refusedPlan("already_current", report, channel, target, NOT_EVALUATED);
  }
  if (versionOrder < 0) {
    return refusedPlan("target_not_newer", report, channel, target, NOT_EVALUATED);
  }

  const scan = (deps.scanProcesses ?? scanCodexSessionProcesses)(deps.processIo ?? {});
  if (scan.kind !== "observed") {
    // An unreadable process table is not "no sessions". `listCodexAppServerProcesses`
    // maps that failure to an empty list because its kill contract must never signal a
    // process it could not verify; the update contract has to defer instead.
    return refusedPlan("blocked_process_state_unknown", report, channel, target, Object.freeze({ state: "unknown" as const, matches: null }));
  }
  const matches = scan.processes.length;
  if (matches > 0) {
    return refusedPlan("blocked_active_session", report, channel, target, Object.freeze({ state: "active" as const, matches }));
  }

  return Object.freeze({
    schemaVersion: CODEX_CLI_UPDATE_SCHEMA_VERSION,
    package: CODEX_CLI_PACKAGE,
    channel,
    applicable: true,
    refusal: null,
    planId: codexCliUpdatePlanId({
      platform,
      provenance: report.provenance,
      installedVersion,
      installDigest: report.installDigest,
      channel,
      targetVersion: target.version,
      targetIntegrity: target.integrity,
    }),
    provenance: report.provenance,
    managed: report.managed,
    installedVersion,
    versionEvidence: report.versionEvidence.kind,
    location: report.location,
    targetVersion: target.version,
    targetIntegrity: target.integrity,
    session: Object.freeze({ state: "none" as const, matches: 0 }),
    command: codexCliUpdateCommand(target.version),
  });
}
