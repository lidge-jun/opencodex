import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  scanCodexAppServerProcesses,
  type CodexAppServerProcessIo,
  type CodexAppServerProcessScan,
} from "./app-server-processes";

/**
 * Phase 2 of the Codex CLI update manager: a deterministic dry-run plan and an explicit
 * apply engine.
 *
 * Phase 1 ({@link inspectCodexCliInstall}) answers who owns the installation. It never
 * queries a registry, never enumerates processes and never writes. This module adds the
 * three inputs it deliberately left out — an exact resolved target with registry
 * integrity, live session blockers, and a decision — and nothing else.
 *
 * Two invariants shape the whole module:
 *
 *  - No persisted state. The plan is not stored anywhere; {@link CodexCliUpdatePlan.planId}
 *    is a digest over the evidence the decision rests on, and apply recomputes it from
 *    live evidence. A stale plan is refused, never silently regenerated.
 *  - Nothing is terminated or restarted. A live Codex session refuses the plan; it is
 *    never signalled, killed or waited on.
 */

export const CODEX_CLI_PACKAGE = "@openai/codex";
export const CODEX_CLI_UPDATE_SCHEMA_VERSION = 1 as const;

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
  /** Indicative install argv for the operator to read before approving; apply actually runs `npm pack`, verifies the bound sha512, and installs the verified tarball. */
  readonly command: readonly string[] | null;
}

export type CodexCliUpdateApplyStatus =
  | "applied"
  | "not_applied"
  | "ambiguous"
  | "refused";

export type CodexCliUpdateApplyRefusal = CodexCliUpdateRefusal | "plan_stale" | "plan_unknown" | "integrity_mismatch";

export interface CodexCliUpdateApplyResult {
  readonly schemaVersion: typeof CODEX_CLI_UPDATE_SCHEMA_VERSION;
  readonly status: CodexCliUpdateApplyStatus;
  readonly refusal: CodexCliUpdateApplyRefusal | null;
  readonly planId: string | null;
  readonly targetVersion: string | null;
  readonly installedVersionBefore: string | null;
  readonly installedVersionAfter: string | null;
  /** Evidence only. The readback classifies the outcome; the exit code never does. */
  readonly installerExitCode: number | null;
}

export interface CodexCliUpdateInstallerResult {
  /** `null` for a spawn failure or timeout, mirroring `spawnSync` status. */
  readonly exitCode: number | null;
  /** True when the fetched artifact's sha512 did not match the plan-bound integrity. */
  readonly integrityMismatch?: boolean;
}

export interface CodexCliUpdatePlanDeps {
  readonly inspect?: (deps: CodexCliInstallProvenanceDeps) => Promise<CodexCliInstallReport>;
  readonly inspectionDeps?: CodexCliInstallProvenanceDeps;
  readonly platform?: NodeJS.Platform;
  readonly channel?: CodexCliUpdateChannel;
  readonly scanProcesses?: (io?: CodexAppServerProcessIo) => CodexAppServerProcessScan;
  readonly processIo?: CodexAppServerProcessIo;
  readonly resolveTarget?: (channel: CodexCliUpdateChannel) => CodexCliUpdateTarget;
}

export interface CodexCliUpdateApplyDeps extends CodexCliUpdatePlanDeps {
  readonly runInstaller?: (version: string, expectedIntegrity: string | null) => CodexCliUpdateInstallerResult;
}

const PLAN_ID_LENGTH = 32;
const PLAN_ID_RE = /^[0-9a-f]{32}$/;
const REGISTRY_TIMEOUT_MS = 12_000;
const INSTALL_TIMEOUT_MS = 300_000;
const SHA512_INTEGRITY_RE = /^sha512-[A-Za-z0-9+/=]+$/;

/** The one command apply is allowed to run, in argv form. */
export function codexCliUpdateCommand(version: string): readonly string[] {
  return Object.freeze(["npm", "install", "-g", `${CODEX_CLI_PACKAGE}@${version}`]);
}

/**
 * Digest over exactly the evidence the decision rests on.
 *
 * Session blockers are deliberately absent: a session that starts or ends between dry-run
 * and apply must not invalidate an otherwise identical plan, and it is re-read at apply
 * time where it can only ever refuse. Everything else — ownership, installed version,
 * location, resolved target, integrity — is bound, so any drift produces
 * a different id and `apply` refuses instead of installing something the operator did not
 * read.
 */
export function codexCliUpdatePlanId(bound: {
  readonly platform: NodeJS.Platform;
  readonly provenance: CodexCliInstallKind;
  readonly installedVersion: string;
  readonly location: string | null;
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
    ["location", bound.location ?? ""],
    ["channel", bound.channel],
    ["targetVersion", bound.targetVersion],
    ["targetIntegrity", bound.targetIntegrity],
  ];
  const hash = createHash("sha256");
  for (const [key, value] of fields) hash.update(`${key}=${value}\n`);
  return hash.digest("hex").slice(0, PLAN_ID_LENGTH);
}

function npmTarget(args: readonly string[]): { bin: string; args: string[]; options: { windowsVerbatimArguments?: boolean } } | null {
  const invocation = npmInvocation(args);
  if (!invocation) return null;
  return { bin: invocation.file, args: invocation.args, options: invocation.options };
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
): CodexCliUpdateTarget {
  const versionTarget = npmTarget(["view", `${CODEX_CLI_PACKAGE}@${channel}`, "version"]);
  if (!versionTarget) return Object.freeze({ kind: "unresolved" as const, reason: "npm executable was not found on a trusted PATH entry" });
  const versionRun = spawn(versionTarget.bin, versionTarget.args, {
    encoding: "utf8",
    timeout: REGISTRY_TIMEOUT_MS,
    windowsHide: true,
    ...versionTarget.options,
  });
  // status === null covers a timeout as well as a spawn failure.
  if (versionRun.status !== 0) {
    return Object.freeze({ kind: "unresolved" as const, reason: `registry version query failed (status ${versionRun.status ?? "timeout"})` });
  }
  const version = (versionRun.stdout ?? "").trim();
  if (!parseStrictSemver(version)) {
    return Object.freeze({ kind: "unresolved" as const, reason: "registry returned no exact version" });
  }

  const integrityTarget = npmTarget(["view", `${CODEX_CLI_PACKAGE}@${version}`, "dist.integrity"]);
  if (!integrityTarget) return Object.freeze({ kind: "unresolved" as const, reason: "npm executable was not found on a trusted PATH entry" });
  const integrityRun = spawn(integrityTarget.bin, integrityTarget.args, {
    encoding: "utf8",
    timeout: REGISTRY_TIMEOUT_MS,
    windowsHide: true,
    ...integrityTarget.options,
  });
  if (integrityRun.status !== 0) {
    return Object.freeze({ kind: "unresolved" as const, reason: `registry integrity query failed (status ${integrityRun.status ?? "timeout"})` });
  }
  // `dist.integrity` may arrive quoted or as a space-separated multi-hash list.
  const tokens = (integrityRun.stdout ?? "").replace(/["']/g, "").trim().split(/\s+/).filter(Boolean);
  const integrity = tokens.find(token => SHA512_INTEGRITY_RE.test(token));
  if (!integrity) {
    return Object.freeze({ kind: "unresolved" as const, reason: "registry returned no sha512 integrity token" });
  }
  return Object.freeze({ kind: "resolved" as const, version, integrity });
}

/**
 * Install exactly `version`, verifying the fetched tarball against the plan-bound
 * sha512 SRI first. `npm install <pkg>@<version>` re-resolves registry metadata at
 * install time, so a registry or proxy answering differently after the plan check
 * would go unnoticed. `npm pack` fetches the same tarball the install would use, the
 * digest is compared with the planned integrity, and only the verified local file is
 * installed. A mismatch fails closed before anything is written.
 */
function defaultRunInstaller(version: string, expectedIntegrity: string | null): CodexCliUpdateInstallerResult {
  if (!expectedIntegrity) {
    // Fail closed: a caller that cannot state the expected digest gets no
    // unverified install, even though production plans always carry one.
    return Object.freeze({ exitCode: null, integrityMismatch: true });
  }
  const stage = mkdtempSync(join(tmpdir(), "ocx-codex-cli-update-"));
  try {
    const pack = npmTarget(["pack", `${CODEX_CLI_PACKAGE}@${version}`, "--pack-destination", stage]);
    if (!pack) return Object.freeze({ exitCode: null });
    const packRun = spawnSync(pack.bin, pack.args, {
      encoding: "utf8",
      timeout: INSTALL_TIMEOUT_MS,
      windowsHide: true,
      stdio: "inherit",
      ...pack.options,
    });
    if (packRun.status !== 0) return Object.freeze({ exitCode: packRun.status });
    const tarballs = readdirSync(stage).filter(name => name.endsWith(".tgz"));
    if (tarballs.length !== 1) return Object.freeze({ exitCode: null });
    const tarball = join(stage, tarballs[0]!);
    const actual = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    if (actual !== expectedIntegrity) return Object.freeze({ exitCode: null, integrityMismatch: true });
    const install = npmTarget(["install", "-g", tarball]);
    if (!install) return Object.freeze({ exitCode: null });
    const run = spawnSync(install.bin, install.args, {
      encoding: "utf8",
      timeout: INSTALL_TIMEOUT_MS,
      windowsHide: true,
      stdio: "inherit",
      ...install.options,
    });
    return Object.freeze({ exitCode: run.status });
  } finally {
    rmSync(stage, { recursive: true, force: true });
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
 * Build the dry-run plan. Reads only; nothing here writes, signals or installs.
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

  const resolveTarget = deps.resolveTarget ?? (ch => resolveCodexCliUpdateTarget(ch));
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

  const scan = (deps.scanProcesses ?? scanCodexAppServerProcesses)(deps.processIo ?? {});
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
      location: report.location,
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

function refusedApply(
  refusal: CodexCliUpdateApplyRefusal,
  plan: CodexCliUpdatePlan | null,
): CodexCliUpdateApplyResult {
  return Object.freeze({
    schemaVersion: CODEX_CLI_UPDATE_SCHEMA_VERSION,
    status: "refused" as const,
    refusal,
    planId: plan?.planId ?? null,
    targetVersion: plan?.targetVersion ?? null,
    installedVersionBefore: plan?.installedVersion ?? null,
    installedVersionAfter: null,
    installerExitCode: null,
  });
}

/**
 * Apply a plan the operator has read.
 *
 * The plan is recomputed from live evidence and the id must match, so the operator
 * approves the exact target that is about to be installed. The install itself is one
 * command against an exact version; the outcome is classified from a fresh inspection,
 * never from the installer exit code, and nothing is retried or rolled back automatically.
 */
export async function applyCodexCliUpdatePlan(
  planId: string,
  deps: CodexCliUpdateApplyDeps = {},
): Promise<CodexCliUpdateApplyResult> {
  if (!PLAN_ID_RE.test(planId)) return refusedApply("plan_unknown", null);

  const plan = await createCodexCliUpdatePlan(deps);
  if (!plan.applicable || !plan.planId || !plan.targetVersion || !plan.installedVersion) {
    return refusedApply(plan.refusal ?? "plan_unknown", plan);
  }
  // Any drift in ownership, installed version, location or target changes the id.
  // Refuse rather than regenerate: the operator would otherwise approve
  // one plan and install another.
  if (plan.planId !== planId) return refusedApply("plan_stale", plan);

  const targetVersion = plan.targetVersion;
  const before = plan.installedVersion;
  const installer = (deps.runInstaller ?? defaultRunInstaller)(targetVersion, plan.targetIntegrity);
  // The fetched artifact failed the plan-bound digest; nothing was installed.
  if (installer.integrityMismatch) return refusedApply("integrity_mismatch", plan);

  const inspect = deps.inspect ?? inspectCodexCliInstall;
  let readback: CodexCliInstallReport | null = null;
  try {
    readback = await inspect(deps.inspectionDeps ?? {});
  } catch {
    readback = null;
  }

  const after = readback
    && readback.provenance === "npm-global"
    && readback.versionEvidence.kind === "package-manifest"
    ? readback.packageVersion
    : null;

  const result = (status: CodexCliUpdateApplyStatus): CodexCliUpdateApplyResult => Object.freeze({
    schemaVersion: CODEX_CLI_UPDATE_SCHEMA_VERSION,
    status,
    refusal: null,
    planId: plan.planId,
    targetVersion,
    installedVersionBefore: before,
    installedVersionAfter: after,
    installerExitCode: installer.exitCode,
  });

  if (after !== targetVersion) {
    // A failed readback, an unchanged version and a third version are all reported
    // as-is. None of them is retried, and none of them is rolled back.
    if (after !== null && after === before) return result("not_applied");
    return result("ambiguous");
  }

  // A matched shim never reaches this point: the inspector reports a shim-owned
  // candidate as standalone-unverified and the plan refuses `not_managed`, so an
  // applied update never owned a shim npm could have replaced.
  return result("applied");
}
