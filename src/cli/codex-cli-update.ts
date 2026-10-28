import {
  inspectCodexCliInstall,
  type CodexCliInstallProvenanceDeps,
  type CodexCliInstallReport,
} from "../codex/cli-install-provenance";
import type {
  CodexCliInstallationIdentityInput,
  CodexCliInstallationIdentityReport,
} from "../codex/cli-installation-identity";
import type {
  CodexCliInstallationSnapshot,
  CodexCliInstallationTargetDerivation,
} from "../codex/cli-installation-targets";
import {
  type CodexCliUpdateChannel,
  type CodexCliUpdatePlan,
  type CodexCliUpdatePlanDeps,
} from "../codex/cli-update-plan";
import { runCodexCliUpdateApplyInWorker, runCodexCliUpdatePlanInWorker } from "../codex/cli-update-job-worker";
import {
  type ResolveCodexRuntimeDeps,
  type ResolveCodexRuntimeResult,
} from "../codex/runtime";
import { CliUsageError, isJsonOption, printData, runCliAction } from "./runtime-api";
import { codexCliUpdateInspectionDeps } from "../codex/cli-update-inspection-context";
export { codexCliUpdateInspectionDeps } from "../codex/cli-update-inspection-context";
import { trustedNodeLauncherContext } from "./launcher-context";
import type { CodexCliApplyDeps, CodexCliApplyResult } from "../codex/cli-update-apply";
import { randomUUID } from "node:crypto";
import { admitCodexCliUpdateJob, readCodexCliUpdateJob, runCodexCliUpdateJob } from "../codex/cli-update-job";
import { CodexCliJobResultPersistenceError, normalizeCodexCliJobResult } from "../codex/cli-update-job-execution";

export const CODEX_CLI_UPDATE_USAGE = `Usage:
  ocx system codex-cli-update check [--json]
  ocx system codex-cli-update attest [--json]
  ocx system codex-cli-update attest --candidate <absolute-path> --npm-prefix <absolute-path> --npm-cli <absolute-path> --node <absolute-path> [--json]
  ocx system codex-cli-update plan [--channel latest] [--json]
  ocx system codex-cli-update apply --plan-id <32-hex> --yes [--request-id <key>] [--json]
  ocx system codex-cli-update status <job-id> [--json]`;

export type ParsedCodexCliUpdateArgs =
  | Readonly<{ action: "check"; json: boolean }>
  | Readonly<{ action: "plan"; json: boolean; channel: CodexCliUpdateChannel }>
  | Readonly<{ action: "apply"; json: boolean; planId: string; requestId: string }>
  | Readonly<{ action: "status"; json: boolean; jobId: string }>
  | Readonly<{ json: boolean; attest: CodexCliInstallationIdentityInput | "selected" }>;

export interface CodexCliUpdateCommandDeps {
  readonly readJob?: typeof readCodexCliUpdateJob;
  readonly inspectInstall?: (deps: CodexCliInstallProvenanceDeps) => Promise<CodexCliInstallReport>;
  readonly inspectIdentity?: (input: CodexCliInstallationIdentityInput) => Promise<CodexCliInstallationIdentityReport>;
  readonly deriveInstallationInput?: (
    snapshot: CodexCliInstallationSnapshot,
  ) => Promise<CodexCliInstallationTargetDerivation>;
  readonly createPlan?: (deps: CodexCliUpdatePlanDeps) => Promise<CodexCliUpdatePlan>;
  readonly resolveSelectedRuntime?: (deps: ResolveCodexRuntimeDeps) => ResolveCodexRuntimeResult;
  readonly applyUpdate?: (planId: string, deps: CodexCliApplyDeps) => Promise<CodexCliApplyResult>;
}

function identitySummary(report: CodexCliInstallationIdentityReport): string[] {
  return [
    `status: ${report.status}`,
    `reason: ${report.reason}`,
    `candidate-source: ${report.candidateSource}`,
    `installation-identity-observed: ${report.installationIdentityObserved ? "yes" : "no"}`,
    `selection-attested: ${report.selectionAttested ? "yes" : "no"}`,
    `managed: ${report.managed ? "yes" : "no"}`,
    `apply-allowed: ${report.applyAllowed ? "yes" : "no"}`,
    `package-version: ${report.packageVersion ?? "unavailable"}`,
    `npm-version: ${report.npmVersion ?? "unavailable"}`,
    `identity-digest: ${report.identityDigest ?? "unavailable"}`,
    `proof: ${report.proof ?? "unavailable"}`,
    `toolchain: ${report.toolchain}`,
    "scope: installation identity only; runtime selection and update ownership are not attested",
  ];
}

function installSummary(report: CodexCliInstallReport): string[] {
  return [
    `candidate: ${report.candidateAvailable ? "yes" : "no"}`,
    `candidate-source: ${report.candidateSource ?? "unavailable"}`,
    `selection-attested: ${report.selectionAttested ? "yes" : "no"}`,
    `provenance: ${report.provenance}`,
    `managed: ${report.managed ? "yes" : "no"}`,
    `reason: ${report.reason}`,
    `candidate-version: ${report.candidateVersion ?? "unavailable"}`,
    `package-version: ${report.packageVersion ?? "unavailable"}`,
    `version-evidence: ${report.versionEvidence.kind}`,
    `location: ${report.location ?? "unavailable"}`,
    `shim: ${report.shim.status}${report.shim.backingKind ? `/${report.shim.backingKind}` : ""}`,
  ];
}

function planSummary(plan: CodexCliUpdatePlan): string[] {
  const lines = [
    `applicable: ${plan.applicable ? "yes" : "no"}`,
    `reason: ${plan.refusal ?? "none"}`,
    `provenance: ${plan.provenance}`,
    `installed-version: ${plan.installedVersion ?? "unavailable"}`,
    `version-evidence: ${plan.versionEvidence}`,
    `channel: ${plan.channel}`,
    `target-version: ${plan.targetVersion ?? "unresolved"}`,
    `target-integrity: ${plan.targetIntegrity ?? "unresolved"}`,
    `session: ${plan.session.state}${plan.session.matches === null ? "" : ` (${plan.session.matches})`}`,
  ];
  if (plan.planId) lines.push(`plan: ${plan.planId}`);
  if (plan.command) lines.push(`command: ${plan.command.join(" ")} (indicative — apply verifies both packed archives and installs their local files)`);
  return lines;
}

/**
 * Read ``--name value`` and ``--name=value`` alike; both spellings reach this CLI. */
function optionValue(tokens: readonly string[], index: number, name: string): { value: string; next: number } {
  const token = tokens[index]!;
  const inline = `--${name}=`;
  if (token.startsWith(inline)) {
    const value = token.slice(inline.length);
    if (!value) throw new CliUsageError(`--${name} requires a value`, CODEX_CLI_UPDATE_USAGE);
    return { value, next: index + 1 };
  }
  const value = tokens[index + 1];
  if (value === undefined) throw new CliUsageError(`--${name} requires a value`, CODEX_CLI_UPDATE_USAGE);
  return { value, next: index + 2 };
}

function isOption(token: string, name: string): boolean {
  return token === `--${name}` || token.startsWith(`--${name}=`);
}

export function parseCodexCliUpdateArgs(argv: readonly string[]): ParsedCodexCliUpdateArgs {
  // `--json` is accepted in any argv position CLI-wide, so remove it before positional
  // validation. Requiring the action at index 0 first would reject `--json check`, which
  // automation that puts output flags ahead of the subcommand legitimately produces.
  let json = false;
  const rest: string[] = [];
  for (const token of argv) {
    if (isJsonOption(token)) {
      if (json) throw new CliUsageError("--json may be specified only once", CODEX_CLI_UPDATE_USAGE);
      json = true;
      continue;
    }
    rest.push(token);
  }
  if (rest[0] === "attest") {
    // No options: attest the selected candidate identified from the proof-bound
    // launcher snapshot. The four explicit paths remain all-or-none.
    if (rest.length === 1) {
      return Object.freeze({ json, attest: "selected" as const });
    }
    const options = new Map<string, keyof CodexCliInstallationIdentityInput>([
      ["--candidate", "candidate"], ["--npm-prefix", "npmPrefix"],
      ["--npm-cli", "npmCli"], ["--node", "node"],
    ]);
    const input: Partial<Record<keyof CodexCliInstallationIdentityInput, string>> = {};
    for (let index = 1; index < rest.length; index += 2) {
      const key = options.get(rest[index]!);
      if (!key || input[key] !== undefined) {
        throw new CliUsageError("unsupported or duplicate attest option", CODEX_CLI_UPDATE_USAGE);
      }
      const value = rest[index + 1];
      if (!value || !value.trim() || /[\0\r\n]/.test(value)
        || !(value.startsWith("/") || /^[a-z]:[\\/]/i.test(value))) {
        throw new CliUsageError("attest options require explicit absolute paths", CODEX_CLI_UPDATE_USAGE);
      }
      input[key] = value;
    }
    if (!input.candidate || !input.npmPrefix || !input.npmCli || !input.node) {
      throw new CliUsageError("attest requires --candidate, --npm-prefix, --npm-cli and --node", CODEX_CLI_UPDATE_USAGE);
    }
    return Object.freeze({ json, attest: Object.freeze({
      candidate: input.candidate, npmPrefix: input.npmPrefix, npmCli: input.npmCli, node: input.node,
    }) });
  }
  const action = rest[0];
  if (action !== "check" && action !== "plan" && action !== "apply" && action !== "status") {
    throw new CliUsageError("codex-cli-update action must be check, attest, plan, apply or status", CODEX_CLI_UPDATE_USAGE);
  }

  if (action === "apply") {
    let planId: string | undefined;
    let requestId: string = randomUUID();
    let seenRequestId = false;
    let yes = false;
    for (let index = 1; index < rest.length;) {
      const token = rest[index]!;
      if (token === "--yes" && !yes) { yes = true; index++; continue; }
      if (isOption(token, "plan-id") && planId === undefined) {
        const value = optionValue(rest, index, "plan-id");
        planId = value.value;
        index = value.next;
        continue;
      }
      if (isOption(token, "request-id") && !seenRequestId) {
        const value = optionValue(rest, index, "request-id");
        requestId = value.value; seenRequestId = true; index = value.next; continue;
      }
      throw new CliUsageError("unsupported or duplicate apply option", CODEX_CLI_UPDATE_USAGE);
    }
    if (!yes || !planId || !/^[0-9a-f]{32}$/.test(planId)) {
      throw new CliUsageError("apply requires --plan-id <32 lowercase hex> and --yes", CODEX_CLI_UPDATE_USAGE);
    }
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
      throw new CliUsageError("--request-id must be 8-128 safe characters", CODEX_CLI_UPDATE_USAGE);
    }
    return Object.freeze({ action, json, planId, requestId });
  }

  if (action === "status") {
    if (rest.length !== 2 || !/^[0-9a-f-]{36}$/.test(rest[1]!)) {
      throw new CliUsageError("status requires one job id", CODEX_CLI_UPDATE_USAGE);
    }
    return Object.freeze({ action, json, jobId: rest[1]! });
  }

  if (action === "check") {
    if (rest.length > 1) throw new CliUsageError("unsupported codex-cli-update argument", CODEX_CLI_UPDATE_USAGE);
    return Object.freeze({ action, json });
  }

  if (action === "plan") {
    let channel: CodexCliUpdateChannel = "latest";
    let seen = false;
    let index = 1;
    while (index < rest.length) {
      const token = rest[index]!;
      if (!isOption(token, "channel")) {
        throw new CliUsageError("unsupported codex-cli-update argument", CODEX_CLI_UPDATE_USAGE);
      }
      if (seen) throw new CliUsageError("--channel may be specified only once", CODEX_CLI_UPDATE_USAGE);
      const read = optionValue(rest, index, "channel");
      // Only the stable channel is offered. A preview channel would need its own
      // provenance story before it may install anything on the operator's behalf.
      if (read.value !== "latest") throw new CliUsageError("--channel must be latest", CODEX_CLI_UPDATE_USAGE);
      channel = read.value;
      seen = true;
      index = read.next;
    }
    return Object.freeze({ action, json, channel });
  }

  // Unreachable: the action check above already rejected every other verb, but the
  // fallthrough keeps the parser total for the type checker.
  throw new CliUsageError("unsupported codex-cli-update action", CODEX_CLI_UPDATE_USAGE);
}

/**
 * Inspection inputs for this one-shot CLI process.
 *
 * The published Node launcher supplies a proof-bound snapshot of configured candidate
 * evidence, not selected-runtime admission. A direct Bun or source launch has no such
 * proof, so nothing ambient or persisted is inspected at all.
 */

export async function handleCodexCliUpdateCommand(
  argv: readonly string[],
  deps: CodexCliUpdateCommandDeps = {},
): Promise<number> {
  let parsed: ParsedCodexCliUpdateArgs;
  try {
    parsed = parseCodexCliUpdateArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`Error: ${error.message}`);
      console.error(error.usage ?? CODEX_CLI_UPDATE_USAGE);
      return 2;
    }
    throw error;
  }
  // A refusal or an unapplied update is a legitimate answer rather than a crash, so the
  // outcome exit code is decided here and only a thrown error is left to runCliAction.
  let resultCode = 0;
  const unavailableJob = () => {
    printData({ error: "job_unavailable" }, parsed.json, ["Codex CLI update job was not found or is unavailable."]);
    resultCode = 1;
  };
  const code = await runCliAction(async () => {
    if ("attest" in parsed) {
      let report: CodexCliInstallationIdentityReport;
      try {
        const identityModule = await import("../codex/cli-installation-identity");
        const inspectIdentity = deps.inspectIdentity ?? identityModule.inspectCodexCliInstallationIdentity;
        if (parsed.attest === "selected") {
          // The proof-bound launcher snapshot is the only trusted source for the
          // selected candidate; a direct Bun/source launch has none and refuses.
          const snapshot = trustedNodeLauncherContext()?.codexCliInspectionEnv;
          const derive = deps.deriveInstallationInput
            ?? (await import("../codex/cli-installation-targets")).deriveCodexCliInstallationInput;
          const derived = await derive({
            codexCliPath: snapshot?.codexCliPath ?? null,
            path: snapshot?.path ?? null,
            pathExt: snapshot?.pathExt ?? null,
          });
          report = derived.kind === "derived"
            ? await inspectIdentity(derived.input)
            : identityModule.codexCliInstallationRefusal(derived.reason, "selected");
        } else {
          report = await inspectIdentity(parsed.attest);
        }
      } catch {
        // Filesystem/native errors can contain the explicit private paths. The
        // read-only inspector normally returns a refusal; unexpected errors stay redacted.
        throw new Error("Installation identity inspection failed");
      }
      printData(report, parsed.json, identitySummary(report));
      return;
    }
    if (parsed.action === "check") {
      const report = await (deps.inspectInstall ?? inspectCodexCliInstall)(codexCliUpdateInspectionDeps(deps));
      printData(report, parsed.json, installSummary(report));
      return;
    }
    if (parsed.action === "status") {
      let job: Awaited<ReturnType<typeof readCodexCliUpdateJob>>;
      try { job = await (deps.readJob ?? readCodexCliUpdateJob)(parsed.jobId); }
      catch { unavailableJob(); return; }
      if (!job) { unavailableJob(); return; }
      printData(job, parsed.json, [`job: ${job.jobId}`, `status: ${job.status}`, `outcome: ${job.outcome ?? "pending"}`,
        `reason: ${job.reason ?? "none"}`, `owner-state: ${job.ownerState}`]);
      return;
    }
    if (parsed.action === "plan") {
      const plan = await (deps.createPlan ?? ((planDeps: CodexCliUpdatePlanDeps) =>
        runCodexCliUpdatePlanInWorker({ channel: planDeps.channel })))({
        channel: parsed.channel,
        inspectionDeps: codexCliUpdateInspectionDeps(deps),
        inspect: deps.inspectInstall,
      });
      printData(plan, parsed.json, planSummary(plan));
      return;
    }
    if (parsed.action === "apply") {
      const admitted = await admitCodexCliUpdateJob({ requestId: parsed.requestId, planId: parsed.planId, confirmed: true });
      const apply = deps.applyUpdate
        ?? ((planId: string) => runCodexCliUpdateApplyInWorker(planId, { jobId: admitted.job.jobId }));
      let job: Awaited<ReturnType<typeof runCodexCliUpdateJob>>;
      try {
        job = admitted.kind === "accepted"
          ? await runCodexCliUpdateJob(admitted.job.jobId, admitted.generation,
            () => apply(parsed.planId, { inspectionDeps: codexCliUpdateInspectionDeps(deps) }))
          : admitted.job;
      } catch (error) {
        if (!(error instanceof CodexCliJobResultPersistenceError)) throw error;
        // Preserve the computed outcome without claiming durable completion or
        // retrying work. Project fixed fields, never the raw result/error object.
        const safe = normalizeCodexCliJobResult(error.result);
        const receipt = { error: "job_result_persistence_failed", jobId: admitted.job.jobId,
          outcome: safe.outcome, reason: safe.reason, leaseRetained: safe.leaseRetained,
          cleanupErrors: safe.cleanupErrors };
        printData(receipt, parsed.json, [`job: ${receipt.jobId}`,
          "persistence: unverified (job_result_persistence_failed)", `outcome: ${receipt.outcome}`,
          `reason: ${receipt.reason}`, `lease-retained: ${receipt.leaseRetained}`,
          `cleanup-errors: ${receipt.cleanupErrors.join(", ") || "none"}`]);
        resultCode = 1;
        return;
      }
      if (!job) { unavailableJob(); return; }
      printData(job, parsed.json, [`job: ${job.jobId}`, `status: ${job.status}`, `outcome: ${job.outcome ?? "pending"}`,
        `reason: ${job.reason ?? "none"}`, `owner-state: ${job.ownerState}`]);
      resultCode = job.status === "applied" ? 0 : 1;
    }
  });
  return code || resultCode;
}
