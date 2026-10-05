/** Preview and explicitly bound mutations use the existing management authority. */
import type { IntegrationMutationPlan, IntegrationPlanOperation } from "../integrations/mutation-plan";
import { redactSecretString, redactUserPath } from "../lib/redact";
import {
  CliUsageError, RuntimeApiError, printData, runtimeRequest, terminalSafeText,
  type RuntimeApiDeps,
} from "./runtime-api";
import {
  clientIntegrationPath, validateAsideProfile, integrationOption, integrationFlag,
  integrationFingerprint, integrationDroidDefaults,
} from "./integration-input";
import { decodeIntegrationPlan, FILE_INTEGRATION_CLIENTS, INTEGRATION_STATES, INTEGRATION_REFUSAL_REASONS } from "./integration-plan-dto";

const USAGE = `Usage:
  ocx integration client preview --client ID --operation <apply|overwrite|disable> [--profile N] [--json]
  ocx integration client restore --op ID --preview [--client aside --profile N] [--confirm-drift] [--json]
  ocx integration client <enable|disable> --client ID [--profile N] [--overwrite-conflict] [--plan-fingerprint TOKEN] [--json]
  ocx integration client restore --op ID [--client aside --profile N] [--confirm-drift] [--plan-fingerprint TOKEN] [--json]
  Droid apply/overwrite: [--reasoning-default MODEL=EFFORT ... | --clear-reasoning-defaults]`;

type Intent = {
  preview: boolean; json: boolean; client?: string; profile?: string;
  operation: IntegrationPlanOperation; path: string; body: Record<string, unknown>;
};

function parseIntent(argv: string[]): Intent {
  const args = [...argv];
  const action = args.shift();
  if (!["preview", "enable", "disable", "restore"].includes(action ?? "")) throw new CliUsageError("Expected preview, enable, disable or restore", USAGE);
  const json = integrationFlag(args, "--json");
  const client = integrationOption(args, "--client");
  const profile = integrationOption(args, "--profile");
  validateAsideProfile(profile, client, USAGE);
  if (client !== undefined && !FILE_INTEGRATION_CLIENTS.some(id => id === client)) throw new CliUsageError("Unknown integration client", USAGE);
  const previewFlag = integrationFlag(args, "--preview");
  const token = integrationFingerprint(args);
  const defaults = integrationDroidDefaults(args);
  const overwrite = integrationFlag(args, "--overwrite-conflict");
  const confirmDrift = integrationFlag(args, "--confirm-drift");
  const op = integrationOption(args, "--op");
  const opAlias = integrationOption(args, "--op-id");
  const selectedOperation = integrationOption(args, "--operation");
  if (args.length) throw new CliUsageError("Unexpected integration argument(s)", USAGE);
  if (op !== undefined && opAlias !== undefined) throw new CliUsageError("Use only one of --op and --op-id", USAGE);
  const opId = op ?? opAlias;
  if (previewFlag && action !== "restore") throw new CliUsageError("--preview applies only to restore; use the preview command", USAGE);
  const preview = action === "preview" || previewFlag;
  if (preview && token !== undefined) throw new CliUsageError("Preview cannot be combined with --plan-fingerprint", USAGE);
  if (selectedOperation !== undefined && action !== "preview") throw new CliUsageError("--operation applies only to preview", USAGE);
  if (overwrite && action !== "enable") throw new CliUsageError("--overwrite-conflict applies only to enable", USAGE);
  if ((opId !== undefined || confirmDrift) && action !== "restore") throw new CliUsageError("--op and --confirm-drift apply only to restore", USAGE);
  let operation: IntegrationPlanOperation;
  if (action === "preview") {
    if (selectedOperation !== "apply" && selectedOperation !== "overwrite" && selectedOperation !== "disable") throw new CliUsageError("--operation must be apply, overwrite or disable", USAGE);
    operation = selectedOperation;
  } else operation = action === "restore" ? "restore" : action === "disable" ? "disable" : overwrite ? "overwrite" : "apply";
  if (action !== "restore" && !client) throw new CliUsageError("--client is required", USAGE);
  if (action === "restore" && (!opId?.trim() || (client !== undefined && (client !== "aside" || profile === undefined)))) {
    throw new CliUsageError("restore requires --op; its optional target is --client aside --profile N", USAGE);
  }
  if (client === "aside" && profile === undefined) throw new CliUsageError("A preview or bound operation requires one Aside --profile", USAGE);
  if (defaults !== undefined && (client !== "droid" || !["apply", "overwrite"].includes(operation))) throw new CliUsageError("Reasoning defaults apply only to Droid apply or overwrite", USAGE);
  let path: string;
  let body: Record<string, unknown>;
  if (action === "restore") {
    path = profile === undefined ? `/api/client-integrations/restore${preview ? "/preview" : ""}`
      : `${clientIntegrationPath("aside", profile)}/${preview ? "preview" : "restore"}`;
    body = { opId, confirmDrift, ...(preview && profile !== undefined ? { operation } : {}) };
  } else if (preview) {
    path = client === "aside" ? `${clientIntegrationPath(client, profile)}/preview` : "/api/client-integrations/preview";
    body = { ...(client === "aside" ? {} : { clientId: client }), operation };
  } else {
    path = clientIntegrationPath(client!, profile);
    body = { enabled: action === "enable", ...(overwrite ? { overwriteConflict: true } : {}) };
  }
  if (defaults !== undefined) body.droidReasoningDefaults = defaults;
  if (token !== undefined) { body.operation = operation; body.planFingerprint = token; }
  return { preview, json, client, profile, operation, path, body };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkIdentity(value: { clientId: string; profileId?: number }, intent: Intent): void {
  if ((intent.client !== undefined && value.clientId !== intent.client)
    || (intent.client === undefined && value.clientId === "aside")
    || (intent.profile === undefined ? value.profileId !== undefined : value.profileId !== Number(intent.profile))) {
    throw new Error("Invalid integration target response");
  }
}

interface Receipt {
  ok: boolean; clientId: string; state: string; operation: IntegrationPlanOperation;
  profileId?: number; changed?: boolean; opId?: string; reason?: string; residual?: boolean; snapshotPath?: string;
}

function recoveryFields(value: Record<string, unknown>): { residual?: boolean; snapshotPath?: string } {
  if ((value.residual !== undefined && typeof value.residual !== "boolean")
    || (value.snapshotPath !== undefined && (typeof value.snapshotPath !== "string" || value.snapshotPath.length > 32768))) {
    throw new Error("Invalid integration recovery response");
  }
  return {
    ...(typeof value.residual === "boolean" ? { residual: value.residual } : {}),
    ...(typeof value.snapshotPath === "string" ? { snapshotPath: redactSecretString(redactUserPath(value.snapshotPath)) } : {}),
  };
}

function mutationReceipt(value: unknown, intent: Intent): Receipt {
  if (!record(value) || typeof value.ok !== "boolean" || !FILE_INTEGRATION_CLIENTS.some(id => id === value.clientId)
    || typeof value.state !== "string" || !INTEGRATION_STATES.has(value.state)
    || (value.ok ? typeof value.changed !== "boolean" : typeof value.reason !== "string" || !INTEGRATION_REFUSAL_REASONS.has(value.reason))
    || (value.profileId !== undefined && (typeof value.profileId !== "number" || !Number.isSafeInteger(value.profileId) || value.profileId < 0))
    || (value.opId !== undefined && (typeof value.opId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value.opId)))) {
    throw new Error("Invalid integration mutation response");
  }
  const result: Receipt = {
    ok: value.ok, clientId: value.clientId as string, state: value.state, operation: intent.operation,
    ...(typeof value.profileId === "number" ? { profileId: value.profileId } : {}),
    ...(typeof value.changed === "boolean" ? { changed: value.changed } : {}),
    ...(typeof value.opId === "string" ? { opId: value.opId } : {}),
    ...(typeof value.reason === "string" && INTEGRATION_REFUSAL_REASONS.has(value.reason) ? { reason: value.reason } : {}),
    ...recoveryFields(value),
  };
  checkIdentity(result, intent);
  return result;
}

function recoveryLines(value: { residual?: boolean; snapshotPath?: string }): string[] {
  return [
    ...(value.residual === true ? ["Automatic recovery did not finish; inspect the client configuration before retrying."] : []),
    ...(value.snapshotPath ? [`Backup (redacted path): ${value.snapshotPath}`] : []),
  ];
}

const REFUSAL_GUIDANCE: Readonly<Record<string, string>> = {
  not_installed: "Install or locate the client before applying its integration.",
  conflict: "Inspect the conflicting client configuration; review an overwrite preview before choosing --overwrite-conflict.",
  unsafe: "Inspect the client configuration and resolve its unsafe path or contents before retrying.",
  non_loopback: "This integration requires a loopback proxy listener.",
  superseded_store: "Inspect integration status for the configuration store the client now reads.",
  drift_requires_confirm: "The client file changed. Review restore --preview --confirm-drift before explicitly confirming drift.",
  snapshot_expired: "The operation backup is no longer available; inspect integration history for another recovery point.",
  write_failed: "Inspect the client configuration and any recovery backup before retrying.",
};

/** A missing store is fixed by hand, so its refusal says with what; the path is on the status row. */
function refusalGuidance(plan: IntegrationMutationPlan): string {
  if (plan.supersededReason === "missing-store" && plan.missingStoreDocument !== undefined) {
    return `The provider store this client reads is missing. Create it containing \`${plan.missingStoreDocument}\` `
      + `(its path is supersededBy in \`ocx integration client status --client ${plan.clientId}\`), then apply again.`;
  }
  return REFUSAL_GUIDANCE[plan.refusalReason!]!;
}

function reportError(error: unknown): number {
  if (error instanceof CliUsageError) {
    console.error(`Error: ${error.message}`);
    console.error(USAGE);
    return 2;
  }
  if (error instanceof RuntimeApiError) {
    const body = record(error.body) ? error.body : {};
    const stale = body.code === "integration_preview_stale";
    const unavailable = body.code === "integration_preview_unavailable";
    console.error(stale ? "Error: Integration preview is stale. Run the explicit preview again and review its changes before retrying."
      : unavailable ? "Error: Integration preview is unavailable. Load the model catalog, then run the preview again."
      : error.status === 404 ? "Error: Integration operation or profile was not found. Inspect integration history and the selected profile."
      : error.status === 409 ? "Error: Integration change was refused. Inspect integration status and preview before retrying."
      : error.status === 503 ? "Error: Management API is unavailable. Check the proxy and run this command on its management host."
      : "Error: Integration request failed. Inspect integration status before retrying.");
    if (!stale) {
      if (typeof body.reason === "string" && INTEGRATION_REFUSAL_REASONS.has(body.reason)) {
        console.error(`Refused (${body.reason}): ${REFUSAL_GUIDANCE[body.reason]}`);
      }
      // Recovery is separate from arbitrary server messages and nested replacement plans.
      try { for (const line of recoveryLines(recoveryFields(body))) console.error(terminalSafeText(line)); } catch { /* Invalid recovery data is not printable. */ }
    }
    return error.status === 404 ? 4 : error.status === 409 ? 5 : 1;
  }
  console.error("Error: Invalid integration response. Check the proxy version and inspect integration status.");
  return 1;
}

export async function handleIntegrationPreviewCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  try {
    const intent = parseIntent(argv);
    const result = await runtimeRequest(intent.path, {
      method: intent.preview || intent.operation === "restore" ? "POST" : "PUT",
      redirect: "error", body: JSON.stringify(intent.body),
    }, deps);
    if (intent.preview) {
      const plan = decodeIntegrationPlan(result);
      checkIdentity(plan, intent);
      if (plan.operation !== intent.operation) throw new Error("Invalid integration operation response");
      printData(plan, intent.json, [
        `${plan.clientId}${plan.profileId === undefined ? "" : `:${plan.profileId}`} ${plan.operation}: ${!plan.canApply ? `refused (${plan.refusalReason})` : !plan.willChange ? "no changes needed" : "ready for review"}`,
        ...plan.changes.map(change => `  ${change.kind} ${change.path}`),
        ...(plan.canApply ? [`Fingerprint: ${plan.fingerprint}`] : [refusalGuidance(plan)]),
      ]);
      return 0;
    }
    const receipt = mutationReceipt(result, intent);
    printData(receipt, intent.json, [
      `${receipt.clientId}${receipt.profileId === undefined ? "" : `:${receipt.profileId}`} ${receipt.operation}: ${!receipt.ok ? `refused (${receipt.reason})` : receipt.changed ? "updated" : "no changes needed"}.`,
      ...(receipt.opId ? [`Operation: ${receipt.opId}`] : []),
      ...(receipt.reason ? [REFUSAL_GUIDANCE[receipt.reason]!] : []), ...recoveryLines(receipt),
    ]);
    return receipt.ok ? 0 : 1;
  } catch (error) { return reportError(error); }
}
