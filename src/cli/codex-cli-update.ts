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
  applyCodexCliUpdatePlan,
  createCodexCliUpdatePlan,
  type CodexCliUpdateApplyDeps,
  type CodexCliUpdateApplyResult,
  type CodexCliUpdateChannel,
  type CodexCliUpdatePlan,
  type CodexCliUpdatePlanDeps,
} from "../codex/cli-update-plan";
import { CliUsageError, isJsonOption, printData, runCliAction } from "./runtime-api";
import { trustedNodeLauncherContext } from "./launcher-context";

export const CODEX_CLI_UPDATE_USAGE = `Usage:
  ocx system codex-cli-update check [--json]
  ocx system codex-cli-update attest [--json]
  ocx system codex-cli-update attest --candidate <absolute-path> --npm-prefix <absolute-path> --npm-cli <absolute-path> --node <absolute-path> [--json]
  ocx system codex-cli-update plan [--channel latest] [--json]
  ocx system codex-cli-update apply --plan <id> [--json]`;

const PLAN_ID_RE = /^[0-9a-f]{32}$/;

export type ParsedCodexCliUpdateArgs =
  | Readonly<{ action: "check"; json: boolean }>
  | Readonly<{ action: "plan"; json: boolean; channel: CodexCliUpdateChannel }>
  | Readonly<{ action: "apply"; json: boolean; planId: string }>
  | Readonly<{ json: boolean; attest: CodexCliInstallationIdentityInput | "selected" }>;

export interface CodexCliUpdateCommandDeps {
  readonly inspectInstall?: (deps: CodexCliInstallProvenanceDeps) => Promise<CodexCliInstallReport>;
  readonly inspectIdentity?: (input: CodexCliInstallationIdentityInput) => Promise<CodexCliInstallationIdentityReport>;
  readonly deriveInstallationInput?: (
    snapshot: CodexCliInstallationSnapshot,
  ) => CodexCliInstallationTargetDerivation;
  readonly createPlan?: (deps: CodexCliUpdatePlanDeps) => Promise<CodexCliUpdatePlan>;
  readonly applyPlan?: (planId: string, deps: CodexCliUpdateApplyDeps) => Promise<CodexCliUpdateApplyResult>;
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
    `shim-eligible: ${plan.shimEligible ? "yes" : "no"}`,
    `session: ${plan.session.state}${plan.session.matches === null ? "" : ` (${plan.session.matches})`}`,
  ];
  if (plan.planId) lines.push(`plan: ${plan.planId}`);
  if (plan.command) lines.push(`command: ${plan.command.join(" ")} (indicative — apply verifies the packed tarball and installs the verified file)`);
  return lines;
}

function applySummary(result: CodexCliUpdateApplyResult): string[] {
  const shim = result.shim.attempted
    ? (result.shim.restored ? "restored" : `repair-required (${result.shim.status ?? "unknown"})`)
    : "untouched";
  return [
    `status: ${result.status}`,
    `reason: ${result.refusal ?? "none"}`,
    `plan: ${result.planId ?? "unavailable"}`,
    `target-version: ${result.targetVersion ?? "unavailable"}`,
    `installed-before: ${result.installedVersionBefore ?? "unavailable"}`,
    `installed-after: ${result.installedVersionAfter ?? "unavailable"}`,
    `installer-exit: ${result.installerExitCode ?? "unavailable"}`,
    `shim: ${shim}`,
  ];
}

/** Read `--name value` and `--name=value` alike; both spellings reach this CLI. */
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
  if (action !== "check" && action !== "plan" && action !== "apply") {
    throw new CliUsageError("codex-cli-update action must be check, attest, plan or apply", CODEX_CLI_UPDATE_USAGE);
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

  let planId: string | null = null;
  let index = 1;
  while (index < rest.length) {
    const token = rest[index]!;
    if (!isOption(token, "plan")) {
      throw new CliUsageError("unsupported codex-cli-update argument", CODEX_CLI_UPDATE_USAGE);
    }
    if (planId !== null) throw new CliUsageError("--plan may be specified only once", CODEX_CLI_UPDATE_USAGE);
    const read = optionValue(rest, index, "plan");
    if (!PLAN_ID_RE.test(read.value)) {
      throw new CliUsageError("--plan must be a plan id from a dry-run", CODEX_CLI_UPDATE_USAGE);
    }
    planId = read.value;
    index = read.next;
  }
  // Apply is never implicit: the operator quotes a plan id they read in a dry-run.
  if (planId === null) throw new CliUsageError("apply requires --plan <id>", CODEX_CLI_UPDATE_USAGE);
  return Object.freeze({ action, json, planId });
}

/**
 * Inspection inputs for this one-shot CLI process.
 *
 * The published Node launcher supplies a proof-bound snapshot of configured candidate
 * evidence, not selected-runtime admission. A direct Bun or source launch has no such
 * proof, so nothing ambient or persisted is inspected at all.
 */
function inspectionDeps(): CodexCliInstallProvenanceDeps {
  const trusted = trustedNodeLauncherContext()?.codexCliInspectionEnv;
  if (!trusted || trusted.managerRoots === null) return { env: { PATH: "" }, configDir: "." };
  return {
    env: {
      ...trusted.managerRoots,
      CODEX_CLI_PATH: trusted.codexCliPath ?? undefined,
      PATH: trusted.path ?? undefined,
      PATHEXT: trusted.pathExt ?? undefined,
    },
    configDir: trusted.configDir,
  };
}

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
  let outcome = 0;
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
          const derived = derive({
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
      const report = await (deps.inspectInstall ?? inspectCodexCliInstall)(inspectionDeps());
      printData(report, parsed.json, installSummary(report));
      return;
    }
    if (parsed.action === "plan") {
      const plan = await (deps.createPlan ?? createCodexCliUpdatePlan)({
        channel: parsed.channel,
        inspectionDeps: inspectionDeps(),
        inspect: deps.inspectInstall,
      });
      printData(plan, parsed.json, planSummary(plan));
      return;
    }
    const result = await (deps.applyPlan ?? applyCodexCliUpdatePlan)(parsed.planId, {
      inspectionDeps: inspectionDeps(),
      inspect: deps.inspectInstall,
    });
    printData(result, parsed.json, applySummary(result));
    outcome = result.status === "applied" ? 0 : 1;
  });
  return code === 0 ? outcome : code;
}
