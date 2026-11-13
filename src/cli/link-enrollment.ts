import { createInterface } from "node:readline/promises";
import { plantUnavailableGuidance } from "../link/child-binary-source";
import { assertSshAlias } from "../link/ssh-argv";
import { checkExplicitRoute, type ExplicitRoute } from "../link/explicit-route";
import { CliUsageError, RuntimeApiError, runtimeBaseUrl, rejectArgs, takeFlag, takeJsonFlag, takeOption, printData } from "./runtime-api";
import type { LinkCliDeps } from "./link";

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{16,88}={0,2}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,128})?$/;
const ENROLLMENT_DEADLINE_MS = 360_000;
const PHASES: Record<string, string> = {
  remote_port_failed: "remote port selection", remote_port_timeout: "remote port selection",
  remote_plant_failed: "remote ocx-child planting", remote_plant_timeout: "remote ocx-child planting",
  remote_plant_unavailable: "local ocx-child binary resolution",
  child_preflight_failed: "Child preflight", child_preflight_timeout: "Child preflight",
  child_port_busy: "Child port availability preflight",
  child_external_provider_conflict: "Child Codex config ownership check",
  child_restart_unsupported: "Child restart preflight", child_curl_missing: "Child curl preflight",
  home_setup_failed: "Home setup", home_setup_timeout: "Home setup",
  remote_connect_failed: "Child enrollment", remote_connect_timeout: "Child enrollment",
  child_restart_failed: "Child restart", child_restart_timeout: "Child restart",
  child_relay_failed: "Child relay verification", child_relay_timeout: "Child relay verification",
  child_runtime_not_client: "Child runtime role verification",
  remote_platform_unsupported: "remote platform verification", remote_ocx_missing: "remote OpenCodex discovery",
};
const RECOVERY_FULL = "Run ocx disconnect and ocx restart on the Child before retrying.";
const RECOVERY_EPHEMERAL = "Run ~/.cache/opencodex/bin/ocx-child detach on the Child before retrying.";
const HOME_CLEANUP: Record<string, string> = {
  key_cleanup_failed: "Enrollment did not complete, and the Home could not revoke the link key it issued; revoke the leftover link key under API keys before retrying.",
  link_cleanup_uncertain: "Enrollment did not complete, and the Home could not undo the attempt: whether the link is stored is unknown and its issued key could not be revoked. Run ocx link status, remove the link if it is listed (ocx link revoke), and revoke the leftover link key under API keys if it remains.",
};
const CHILD_MAY_BE_CONNECTED = "The Child may still be connected.";
// A journalled answer names the Child's residual as a closed word; a replay never probed, so it cannot infer one.
const RECOVERY_BY_KIND: Record<string, string> = {
  plant: "Run the planted ocx-child's managed copy with detach --purge on the Child before retrying: ~/.cache/opencodex/bin/ocx-child detach --purge on macOS or Linux; "
    + "on Windows, in Command Prompt, \"%LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe\" detach --purge, or \"%USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe\" detach --purge where LOCALAPPDATA is not set.",
  enrollment: "Run ocx disconnect and ocx restart on the Child (~/.cache/opencodex/bin/ocx-child detach for an ocx-child) before retrying.",
};
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Refusals of ocx link add --operation-id and --require-ephemeral (structure/remote-link.md, "Operation journal").
const OPERATION_REFUSALS: Record<string, string> = {
  operation_mismatch: "This operation id was already used with other parameters; use a new operation id.",
  link_operation_open: "An unfinished enrollment holds this alias; repeat it with its own operation id to settle it first.",
  link_operation_in_progress: "Another enrollment or revoke of this alias is running; retry when it ends.",
  full_install_present: "A full OpenCodex install is on the Child; --require-ephemeral refused it before any change.",
  full_install_census_failed: "The Child could not be checked for a full OpenCodex install; nothing was changed.",
  require_ephemeral_unsupported: "--require-ephemeral is not supported for a Windows Child.",
};

/** " (operation <id>: <outcome>)" when the answer carries this operation's recorded outcome. */
function operationNote(error: unknown, operationId: string | undefined): string {
  if (operationId === undefined || !(error instanceof RuntimeApiError) || !record(error.body)) return "";
  return error.body.operationId === operationId && typeof error.body.outcome === "string" ? " (operation " + operationId + ": " + error.body.outcome + ")" : "";
}
type LinkRequest = <T>(path: string, init: RequestInit, deps: LinkCliDeps) => Promise<T>;

interface ParsedProbeOffer {
  alias: string;
  fingerprint: string;
  keyType: string;
  ocxVersion: string | null;
  runtimeKind?: "full" | "ephemeral" | "missing";
  targetTriple?: string | null;
  plantable?: boolean;
  binarySizeBytes?: number;
  plantUnavailableReason?: string;
  legacyExact: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PROBE_ALLOWED_KEYS = new Set([
  "alias", "fingerprint", "keyType", "ocxVersion",
  "runtimeKind", "targetTriple", "plantable", "binarySizeBytes", "plantUnavailableReason",
]);
const CONFIRM_ALLOWED_KEYS = new Set([
  "alias", "fingerprint", "ocxVersion",
  "runtimeKind", "targetTriple", "plantable", "binarySizeBytes", "plantUnavailableReason",
]);

function parseOffered(value: unknown, allowMissing: boolean): ParsedProbeOffer {
  if (!record(value)) throw new Error("Invalid host probe response");
  const keys = Object.keys(value);
  if (keys.some(k => !PROBE_ALLOWED_KEYS.has(k))) throw new Error("Invalid host probe response");
  if (typeof value.alias !== "string" || typeof value.fingerprint !== "string" || !FINGERPRINT.test(value.fingerprint)
    || typeof value.keyType !== "string" || !/^[A-Za-z0-9@._+-]{1,64}$/.test(value.keyType)) {
    throw new Error("Invalid host probe response");
  }
  const legacyExact = keys.slice().sort().join(",") === "alias,fingerprint,keyType,ocxVersion";
  if (!allowMissing && !legacyExact) throw new Error("Invalid host probe response");
  if (value.ocxVersion === null) {
    if (!allowMissing || value.runtimeKind !== "missing") throw new Error("Invalid host version response");
  } else if (typeof value.ocxVersion !== "string" || !SEMVER.test(value.ocxVersion)) {
    throw new Error("Invalid host version response");
  }
  if (value.runtimeKind !== undefined && value.runtimeKind !== "full" && value.runtimeKind !== "ephemeral" && value.runtimeKind !== "missing") {
    throw new Error("Invalid host probe response");
  }
  if (value.targetTriple !== undefined && value.targetTriple !== null && (typeof value.targetTriple !== "string" || value.targetTriple.length > 64)) {
    throw new Error("Invalid host probe response");
  }
  if (value.plantable !== undefined && typeof value.plantable !== "boolean") throw new Error("Invalid host probe response");
  if (value.binarySizeBytes !== undefined && (typeof value.binarySizeBytes !== "number" || !Number.isSafeInteger(value.binarySizeBytes) || value.binarySizeBytes <= 0)) {
    throw new Error("Invalid host probe response");
  }
  if (value.plantUnavailableReason !== undefined && typeof value.plantUnavailableReason !== "string") {
    throw new Error("Invalid host probe response");
  }
  return {
    alias: value.alias,
    fingerprint: value.fingerprint,
    keyType: value.keyType,
    ocxVersion: value.ocxVersion,
    ...(value.runtimeKind !== undefined ? { runtimeKind: value.runtimeKind } : {}),
    ...(value.targetTriple !== undefined ? { targetTriple: value.targetTriple } : {}),
    ...(value.plantable !== undefined ? { plantable: value.plantable } : {}),
    ...(value.binarySizeBytes !== undefined ? { binarySizeBytes: value.binarySizeBytes } : {}),
    ...(value.plantUnavailableReason !== undefined ? { plantUnavailableReason: value.plantUnavailableReason } : {}),
    legacyExact,
  };
}

function validateConfirmed(value: unknown, alias: string, fingerprint: string, allowMissing: boolean): void {
  if (!record(value)) throw new Error("Invalid host confirmation response");
  const keys = Object.keys(value);
  if (keys.some(k => !CONFIRM_ALLOWED_KEYS.has(k))) throw new Error("Invalid host confirmation response");
  if (value.alias !== alias || value.fingerprint !== fingerprint) throw new Error("Invalid host confirmation response");
  const legacyExact = keys.slice().sort().join(",") === "alias,fingerprint,ocxVersion";
  if (!allowMissing && !legacyExact) throw new Error("Invalid host confirmation response");
  if (value.ocxVersion === null) {
    if (!allowMissing || value.runtimeKind !== "missing") throw new Error("Invalid host confirmation response");
  } else if (typeof value.ocxVersion !== "string" || !SEMVER.test(value.ocxVersion)) {
    throw new Error("Invalid host confirmation response");
  }
}

/**
 * --proxy-command, --ssh-user and --ssh-port name one explicit route and go together; they need
 * --exclusive (structure/remote-link.md, "Explicit route"). The values are checked here and again on
 * the Home, which refuses any form explicit-route.ts does not accept.
 */
const ROUTE_FORM = {
  proxy_command_form: "--proxy-command must be an absolute path followed by words of letters, digits and . _ / : @ + , = - separated by single spaces (no %, quotes or other shell characters)",
  user_form: "--ssh-user must be a letter or _ followed by up to 31 letters, digits, ., _ or -",
  port_form: "--ssh-port must be an integer from 1 to 65535",
} as const;

function takeRouteFlags(args: string[], usage: string): { explicitRoute?: ExplicitRoute; exclusive?: true } {
  const proxyCommand = takeOption(args, "--proxy-command");
  const user = takeOption(args, "--ssh-user");
  const portText = takeOption(args, "--ssh-port");
  const exclusive = takeFlag(args, "--exclusive");
  const given = [proxyCommand, user, portText].filter(value => value !== undefined).length;
  if (given === 0) return exclusive ? { exclusive: true } : {};
  if (given !== 3) throw new CliUsageError("--proxy-command, --ssh-user and --ssh-port go together", usage);
  if (!exclusive) throw new CliUsageError("An explicit route requires --exclusive", usage);
  const port = /^[0-9]{1,5}$/.test(portText!) ? Number(portText) : Number.NaN;
  const checked = checkExplicitRoute({ proxyCommand, user, port });
  if (!checked.ok) {
    throw new CliUsageError(ROUTE_FORM[checked.reason === "user_form" || checked.reason === "port_form" ? checked.reason : "proxy_command_form"], usage);
  }
  return { explicitRoute: checked.route, exclusive: true };
}

function formatSizeMb(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "~0.9 MB";
  return `~${Math.max(0.1, bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function runLinkEnrollment(command: "probe" | "add", args: string[], deps: LinkCliDeps, request: LinkRequest, usage: string): Promise<void> {
  const wantsJson = takeJsonFlag(args);
  const plantFlag = takeFlag(args, "--plant");
  const expected = takeOption(args, "--expect-fingerprint");
  const routeBody = takeRouteFlags(args, usage);
  const operationId = takeOption(args, "--operation-id");
  const requireEphemeral = takeFlag(args, "--require-ephemeral");
  const alias = args.shift();
  if (!alias) throw new CliUsageError(command + " requires an SSH alias", usage);
  try { assertSshAlias(alias); } catch { throw new CliUsageError("Invalid SSH alias", usage); }
  rejectArgs(args, usage);
  if (command === "probe" && expected !== undefined) throw new CliUsageError("--expect-fingerprint is only for link add", usage);
  if (command === "probe" && plantFlag) throw new CliUsageError("--plant is only for link add", usage);
  if (expected !== undefined && !FINGERPRINT.test(expected)) throw new CliUsageError("Expected a SHA256 SSH fingerprint", usage);
  if (command === "probe" && (operationId !== undefined || requireEphemeral)) throw new CliUsageError("--operation-id and --require-ephemeral are only for link add", usage);
  if (operationId !== undefined && !OPERATION_ID.test(operationId)) throw new CliUsageError("--operation-id must be 1-128 letters, digits, '.', '_', ':' or '-', not starting with a punctuation mark", usage);
  // A repeat replays without probing, so the fingerprint that names the operation must be given, not offered.
  if (operationId !== undefined && expected === undefined) throw new CliUsageError("--operation-id requires --expect-fingerprint", usage);
  const operationBody = { ...(operationId !== undefined ? { operationId } : {}), ...(requireEphemeral ? { requireEphemeral: true } : {}) };
  const isTTY = Boolean((deps.stdinImpl ?? process.stdin).isTTY);
  if (command === "add" && !expected && !isTTY) {
    throw new CliUsageError("Non-interactive link add requires --expect-fingerprint", usage);
  }
  const timeout = deps.enrollmentTimeoutMs ?? ENROLLMENT_DEADLINE_MS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > ENROLLMENT_DEADLINE_MS) throw new Error("Invalid link enrollment deadline");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Link enrollment timed out; its outcome is uncertain. Run ocx link status on the Home and ocx connect status on the Child before retrying.")); }, timeout);
  });
  let boundDeps = deps;
  let ephemeralFlow = false;
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    controller.signal.throwIfAborted();
    const result = await request<T>(path, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, boundDeps);
    controller.signal.throwIfAborted();
    return result;
  };
  let rl: ReturnType<typeof createInterface> | undefined;
  const askYes = async (promptText: string): Promise<boolean> => {
    rl ??= createInterface({ input: deps.stdinImpl ?? process.stdin, output: process.stderr });
    return (await rl.question(promptText, { signal: controller.signal })).trim() === "yes";
  };
  const get = async <T>(path: string): Promise<T> => {
    controller.signal.throwIfAborted();
    const result = await request<T>(path, { method: "GET", redirect: "error", signal: controller.signal }, boundDeps);
    controller.signal.throwIfAborted();
    return result;
  };
  const applied = (result: unknown, planted: boolean): void => {
    const keys = record(result) ? Object.keys(result).sort().join(",") : "";
    const shaped = operationId === undefined ? keys === "linkId"
      : keys === "linkId,operationId,outcome" && record(result) && result.operationId === operationId && result.outcome === "committed";
    if (!shaped || !record(result) || typeof result.linkId !== "string" || !/^lnk_[0-9a-f]{16}$/.test(result.linkId)) throw new Error("Invalid link apply response");
    printData({ linkId: result.linkId, alias, state: "connected", childRole: "client", ...(planted ? { planted: true } : {}), ...(routeBody.exclusive ? { exclusive: true } : {}),
      ...(operationId !== undefined ? { operationId, outcome: "committed" } : {}) }, wantsJson, ["Connected " + alias + " as a Child (" + result.linkId + ")."]);
  };
  const work = async () => {
    boundDeps = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    controller.signal.throwIfAborted();
    if (command === "add" && operationId !== undefined) {
      // A recorded operation replays its outcome: no new probe or confirmation, which a gone host could not answer.
      let recorded = false;
      try { await get<unknown>("/api/link/operations/" + encodeURIComponent(operationId)); recorded = true; } catch (error) {
        const code = error instanceof RuntimeApiError && record(error.body) && record(error.body.error) ? error.body.error.code : undefined;
        if (!(error instanceof RuntimeApiError && error.status === 404 && code === "operation_not_found")) throw error;
      }
      if (recorded) {
        applied(await post<unknown>("/api/link/apply", { alias, fingerprint: expected, ...routeBody, ...operationBody }), false);
        return;
      }
    }
    const probeReq = command === "add" ? { alias, includeVersion: true, allowMissing: true, ...routeBody } : { alias, includeVersion: true, ...routeBody };
    const probe = parseOffered(await post<unknown>("/api/link/probe", probeReq), command === "add");
    if (probe.alias !== alias) throw new Error("Host probe alias did not match");
    if (command === "probe") {
      const payload = { alias: probe.alias, fingerprint: probe.fingerprint, keyType: probe.keyType, ocxVersion: probe.ocxVersion! };
      printData(payload, wantsJson, [probe.alias + " " + probe.keyType + " " + probe.fingerprint + " opencodex " + probe.ocxVersion]);
      return;
    }
    if (expected && expected !== probe.fingerprint) throw new CliUsageError("The offered host fingerprint does not match --expect-fingerprint");
    let shouldPlant = false;
    ephemeralFlow = probe.runtimeKind === "ephemeral" || probe.runtimeKind === "missing";
    if (probe.runtimeKind === "missing") {
      if (probe.plantable !== true) {
        throw new Error("ocx was not found on " + alias + ". " + plantUnavailableGuidance(probe.plantUnavailableReason, probe.targetTriple ?? null));
      }
      if (!isTTY && !plantFlag) {
        throw new CliUsageError("Remote host has no OpenCodex runtime; pass --plant alongside --expect-fingerprint to plant lightweight ocx-child.", usage);
      }
      const sizeLabel = formatSizeMb(probe.binarySizeBytes);
      if (!expected) {
        const approved = deps.confirmFingerprint
          ? await deps.confirmFingerprint({ alias: probe.alias, fingerprint: probe.fingerprint, keyType: probe.keyType, ocxVersion: null, runtimeKind: "missing", binarySizeBytes: probe.binarySizeBytes })
          : await askYes(`Confirm ${alias} ${probe.keyType} ${probe.fingerprint} — plant lightweight ocx-child (${sizeLabel}) and connect? (type yes): `);
        controller.signal.throwIfAborted();
        if (!approved) throw new CliUsageError("Host fingerprint and ocx-child plant were not confirmed");
      } else if (!plantFlag) {
        const approved = deps.confirmFingerprint
          ? await deps.confirmFingerprint({ alias: probe.alias, fingerprint: probe.fingerprint, keyType: probe.keyType, ocxVersion: null, runtimeKind: "missing", binarySizeBytes: probe.binarySizeBytes })
          : await askYes(`Plant lightweight ocx-child (${sizeLabel}) on ${alias} and connect? (type yes): `);
        controller.signal.throwIfAborted();
        if (!approved) throw new CliUsageError("Planting ocx-child was not confirmed");
      }
      shouldPlant = true;
    } else if (!expected) {
      const approved = deps.confirmFingerprint
        ? await deps.confirmFingerprint({ alias: probe.alias, fingerprint: probe.fingerprint, keyType: probe.keyType, ...(probe.ocxVersion !== null ? { ocxVersion: probe.ocxVersion } : {}) })
        : await askYes("Confirm " + alias + " " + probe.keyType + " " + probe.fingerprint + " opencodex " + probe.ocxVersion + " (type yes): ");
      controller.signal.throwIfAborted();
      if (!approved) throw new CliUsageError("Host fingerprint was not confirmed");
    }
    const sendAllowMissing = shouldPlant || probe.runtimeKind === "missing";
    const confirm = await post<unknown>("/api/link/confirm-host", { alias, fingerprint: probe.fingerprint, ...(sendAllowMissing ? { allowMissing: true } : {}), ...routeBody });
    validateConfirmed(confirm, alias, probe.fingerprint, sendAllowMissing);
    applied(await post<unknown>("/api/link/apply", { alias, fingerprint: probe.fingerprint, ...(shouldPlant ? { plant: true } : {}), ...routeBody, ...operationBody }), shouldPlant);
  };
  try { await Promise.race([work(), expiry]); }
  catch (error) {
    const note = operationNote(error, operationId);
    try {
    if (error instanceof RuntimeApiError && record(error.body)) {
      const code = record(error.body.error) ? error.body.error.code : undefined;
      if (code === "remote_platform_unsupported" && error.body.residual !== true) throw new Error("The remote shell cannot run this Remote Link workflow. Update OpenCodex on Home and check PowerShell on the Child.");
      // Both conflicts say no Child file changed, which holds only when nothing is left behind (a plant whose rollback failed is).
      if (code === "child_port_busy" && error.body.residual !== true) throw new Error("The target port on the Child is already in use by another process; no Child files were modified.");
      if (code === "child_preflight_output_limit") throw new Error("The Child's ocx config show --json output exceeded the Remote Link preflight limit; trim the Child's saved configuration and retry.");
      if (code === "child_external_provider_conflict" && error.body.residual !== true) throw new Error("The Child's ~/.codex/config.toml is already managed by another model provider or custom base URL; no Child files were modified.");
      // Home-side cleanup that left a link key behind: fixed, locally written guidance (the server's
      // prose is never echoed), plus the Child's own recovery step when it may still be connected.
      const homeCleanup = typeof code === "string" && Object.hasOwn(HOME_CLEANUP, code) ? HOME_CLEANUP[code] : undefined;
      if (homeCleanup) {
        const kindRecovery = typeof error.body.residualKind === "string" ? RECOVERY_BY_KIND[error.body.residualKind] : undefined;
        const childStep = error.body.residual === true ? " " + CHILD_MAY_BE_CONNECTED + " " + (kindRecovery ?? (ephemeralFlow ? RECOVERY_EPHEMERAL : RECOVERY_FULL)) : "";
        throw new Error(homeCleanup + childStep + " (code " + code + ")");
      }
      const phase = typeof code === "string" && Object.hasOwn(PHASES, code) ? PHASES[code] : undefined;
      // The server's hint is the Child's own bounded, redacted reason (#8357); a phase name
      // alone left every failure to SSH reproduction and source reading.
      const hint = record(error.body.error) && typeof error.body.error.hint === "string" ? error.body.error.hint : "";
      const message = phase ? "Remote Link failed during " + phase + (hint ? ": " + hint : "") : error.message;
      const kindRecovery = typeof error.body.residualKind === "string" ? RECOVERY_BY_KIND[error.body.residualKind] : undefined;
      const recovery = kindRecovery ?? (ephemeralFlow ? RECOVERY_EPHEMERAL : RECOVERY_FULL);
      // The machine-readable code rides along so a script can branch without parsing prose.
      const codeSuffix = (phase || note) && typeof code === "string" ? " (code " + code + ")" : "";
      if (phase || error.body.residual === true) throw new Error(message + (error.body.residual === true ? ". " + recovery : "") + codeSuffix);
      if (typeof code === "string" && Object.hasOwn(OPERATION_REFUSALS, code)) throw new Error(OPERATION_REFUSALS[code] + " (code " + code + ")");
      if (note && typeof code === "string") throw new Error(error.message + " (code " + code + ")");
    }
    throw error;
    } catch (explained) {
      if (note && explained instanceof Error) explained.message += note;
      throw explained;
    }
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    rl?.close();
  }
}

