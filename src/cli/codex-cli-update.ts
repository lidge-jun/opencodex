import {
  inspectCodexCliInstall,
  type CodexCliInstallProvenanceDeps,
  type CodexCliInstallReport,
} from "../codex/cli-install-provenance";
import { CliUsageError, isJsonOption, printData, runCliAction } from "./runtime-api";
import { trustedNodeLauncherContext } from "./launcher-context";

export const CODEX_CLI_UPDATE_USAGE = `Usage:
  ocx system codex-cli-update check [--json]`;

export type ParsedCodexCliUpdateArgs = Readonly<{
  json: boolean;
}>;

export interface CodexCliUpdateCommandDeps {
  readonly inspectInstall?: (deps: CodexCliInstallProvenanceDeps) => Promise<CodexCliInstallReport>;
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

export function parseCodexCliUpdateArgs(argv: readonly string[]): ParsedCodexCliUpdateArgs {
  // `--json` is accepted in any argv position CLI-wide, so remove it before positional
  // validation. Requiring `check` at index 0 first would reject `--json check`, which
  // automation that puts output flags ahead of the subcommand legitimately produces.
  let json = false;
  const positional: string[] = [];
  for (const token of argv) {
    if (isJsonOption(token)) {
      if (json) throw new CliUsageError("--json may be specified only once", CODEX_CLI_UPDATE_USAGE);
      json = true;
      continue;
    }
    positional.push(token);
  }
  if (positional[0] !== "check") {
    throw new CliUsageError("codex-cli-update action must be check", CODEX_CLI_UPDATE_USAGE);
  }
  if (positional.length > 1) {
    throw new CliUsageError("unsupported codex-cli-update argument", CODEX_CLI_UPDATE_USAGE);
  }
  return Object.freeze({ json });
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
  return runCliAction(async () => {
    const trustedInspectionEnv = trustedNodeLauncherContext()?.codexCliInspectionEnv;
    const inspectionDeps: CodexCliInstallProvenanceDeps = trustedInspectionEnv
      && trustedInspectionEnv.managerRoots !== null ? {
      env: {
        ...trustedInspectionEnv.managerRoots,
        CODEX_CLI_PATH: trustedInspectionEnv.codexCliPath ?? undefined,
        PATH: trustedInspectionEnv.path ?? undefined,
        PATHEXT: trustedInspectionEnv.pathExt ?? undefined,
      },
      configDir: trustedInspectionEnv.configDir,
      // This is a fresh one-shot CLI process. Its proof-bound launcher snapshot
      // supplies configured candidate evidence, not selected-runtime admission.
    } : {
      // Direct Bun/source launches have no pre-dotenv proof. Do not inspect
      // ambient or persisted candidate state at all.
      env: { PATH: "" },
      configDir: ".",
    };
    const report = await (deps.inspectInstall ?? inspectCodexCliInstall)(inspectionDeps);
    printData(report, parsed.json, installSummary(report));
  });
}
