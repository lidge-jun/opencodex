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
import { CliUsageError, isJsonOption, printData, runCliAction } from "./runtime-api";
import { trustedNodeLauncherContext } from "./launcher-context";

export const CODEX_CLI_UPDATE_USAGE = `Usage:
  ocx system codex-cli-update check [--json]
  ocx system codex-cli-update attest [--json]
  ocx system codex-cli-update attest --candidate <absolute-path> --npm-prefix <absolute-path> --npm-cli <absolute-path> --node <absolute-path> [--json]`;

export type ParsedCodexCliUpdateArgs = Readonly<{
  json: boolean;
}> | Readonly<{
  json: boolean;
  attest: CodexCliInstallationIdentityInput | "selected";
}>;

export interface CodexCliUpdateCommandDeps {
  readonly inspectInstall?: (deps: CodexCliInstallProvenanceDeps) => Promise<CodexCliInstallReport>;
  readonly inspectIdentity?: (input: CodexCliInstallationIdentityInput) => Promise<CodexCliInstallationIdentityReport>;
  readonly deriveInstallationInput?: (
    snapshot: CodexCliInstallationSnapshot,
  ) => CodexCliInstallationTargetDerivation;
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
  if (positional[0] === "attest") {
    // No options: attest the selected candidate identified from the proof-bound
    // launcher snapshot. The four explicit paths remain all-or-none.
    if (positional.length === 1) {
      return Object.freeze({ json, attest: "selected" as const });
    }
    const options = new Map<string, keyof CodexCliInstallationIdentityInput>([
      ["--candidate", "candidate"], ["--npm-prefix", "npmPrefix"],
      ["--npm-cli", "npmCli"], ["--node", "node"],
    ]);
    const input: Partial<Record<keyof CodexCliInstallationIdentityInput, string>> = {};
    for (let index = 1; index < positional.length; index += 2) {
      const key = options.get(positional[index]!);
      if (!key || input[key] !== undefined) {
        throw new CliUsageError("unsupported or duplicate attest option", CODEX_CLI_UPDATE_USAGE);
      }
      const value = positional[index + 1];
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
  if (positional[0] !== "check") {
    throw new CliUsageError("codex-cli-update action must be check or attest", CODEX_CLI_UPDATE_USAGE);
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
