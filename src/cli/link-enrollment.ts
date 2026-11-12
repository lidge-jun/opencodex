import { createInterface } from "node:readline/promises";
import { plantUnavailableGuidance } from "../link/child-binary-source";
import { assertSshAlias } from "../link/ssh-argv";
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

function formatSizeMb(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "~0.9 MB";
  return `~${Math.max(0.1, bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function runLinkEnrollment(command: "probe" | "add", args: string[], deps: LinkCliDeps, request: LinkRequest, usage: string): Promise<void> {
  const wantsJson = takeJsonFlag(args);
  const plantFlag = takeFlag(args, "--plant");
  const expected = takeOption(args, "--expect-fingerprint");
  const alias = args.shift();
  if (!alias) throw new CliUsageError(command + " requires an SSH alias", usage);
  try { assertSshAlias(alias); } catch { throw new CliUsageError("Invalid SSH alias", usage); }
  rejectArgs(args, usage);
  if (command === "probe" && expected !== undefined) throw new CliUsageError("--expect-fingerprint is only for link add", usage);
  if (command === "probe" && plantFlag) throw new CliUsageError("--plant is only for link add", usage);
  if (expected !== undefined && !FINGERPRINT.test(expected)) throw new CliUsageError("Expected a SHA256 SSH fingerprint", usage);
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
  const work = async () => {
    boundDeps = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    controller.signal.throwIfAborted();
    const probeReq = command === "add" ? { alias, includeVersion: true, allowMissing: true } : { alias, includeVersion: true };
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
    const confirm = await post<unknown>("/api/link/confirm-host", { alias, fingerprint: probe.fingerprint, ...(sendAllowMissing ? { allowMissing: true } : {}) });
    validateConfirmed(confirm, alias, probe.fingerprint, sendAllowMissing);
    const result = await post<unknown>("/api/link/apply", { alias, fingerprint: probe.fingerprint, ...(shouldPlant ? { plant: true } : {}) });
    if (!record(result) || Object.keys(result).join(",") !== "linkId" || typeof result.linkId !== "string" || !/^lnk_[0-9a-f]{16}$/.test(result.linkId)) throw new Error("Invalid link apply response");
    printData({ linkId: result.linkId, alias, state: "connected", childRole: "client", ...(shouldPlant ? { planted: true } : {}) }, wantsJson, ["Connected " + alias + " as a Child (" + result.linkId + ")."]);
  };
  try { await Promise.race([work(), expiry]); }
  catch (error) {
    if (error instanceof RuntimeApiError && record(error.body)) {
      const code = record(error.body.error) ? error.body.error.code : undefined;
      if (code === "remote_platform_unsupported" && error.body.residual !== true) throw new Error("The remote shell cannot run this Remote Link workflow. Update OpenCodex on Home and check PowerShell on the Child.");
      if (code === "child_port_busy") throw new Error("The target port on the Child is already in use by another process; no Child files were modified.");
      if (code === "child_preflight_output_limit") throw new Error("The Child's ocx config show --json output exceeded the Remote Link preflight limit; trim the Child's saved configuration and retry.");
      if (code === "child_external_provider_conflict") throw new Error("The Child's ~/.codex/config.toml is already managed by another model provider or custom base URL; no Child files were modified.");
      const phase = typeof code === "string" && Object.hasOwn(PHASES, code) ? PHASES[code] : undefined;
      // The server's hint is the Child's own bounded, redacted reason (#8357); a phase name
      // alone left every failure to SSH reproduction and source reading.
      const hint = record(error.body.error) && typeof error.body.error.hint === "string" ? error.body.error.hint : "";
      const message = phase ? "Remote Link failed during " + phase + (hint ? ": " + hint : "") : error.message;
      const recovery = ephemeralFlow ? RECOVERY_EPHEMERAL : RECOVERY_FULL;
      // The machine-readable code rides along so a script can branch without parsing prose.
      const codeSuffix = phase && typeof code === "string" ? " (code " + code + ")" : "";
      if (phase || error.body.residual === true) throw new Error(message + (error.body.residual === true ? ". " + recovery : "") + codeSuffix);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    rl?.close();
  }
}

