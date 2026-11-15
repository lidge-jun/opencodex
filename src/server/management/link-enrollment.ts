import { seedRouteDeviceClients } from "../../routing/home-route-intent";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSshAlias, buildExecArgv, buildFingerprintArgv, buildProbeArgv, REMOTE_COMMAND_NOT_FOUND, remoteOcxArgv } from "../../link/ssh-argv";
import { plantUnavailableGuidance, resolveChildBinarySource } from "../../link/child-binary-source";
import { parseFingerprintLine } from "../../link/fingerprint";
import { confirmedLineTrust as confirmedLineTrustIn, type ConfirmedLineTrust } from "../../link/route-trust";
import { isDetachedEphemeralChildConfig } from "../../link/ephemeral-child";
import { classifyChildAttachConflict, classifyPlantFailure, inspectRemoteChildRuntime, parseFullInstallCensus, remoteFullInstallCensusArgv, remotePlantChildArgv, remotePurgePlantedChildArgv } from "../../link/remote-plant";
import { requireRemotePlatform } from "../../link/remote-platform";
import { LINK_CATALOG_MAX_BYTES, LINK_RELAY_VERIFY_MS, isChildHealth, linkCommandBudget, linkRestartBudget, parseChildHttp, remoteChildHttpArgv, REMOTE_CURL_PREFLIGHT } from "../../link/remote-probe";
import { newLinkId, type LinkStore } from "../../link/store";
import { residualRecovery } from "../../link/residual-recovery";
import { SshRunnerError, boundHint, sshFailureHint, sshRunnerErrorHint, type SshRunResult } from "../../link/ssh-runner";
import { withConfigMutationLockSync } from "../../config/mutation-lock";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import { fail, exactBody, port, isRecord, runnerFor, readStoreFor, writeStoreFor, knownHostsFile, putConfirmedKnownHost, issueKey, compensateNewLink, keyCleanupFailed, revokeKeyIdempotent, type LinkRouteState } from "./link-route-state";
import { identityFileRefusal, routeFields, routeMismatch, routeOf, sameRouteRequest, splitRouteRequest } from "./link-route-request";
import { enrollOperationDigest, journalInUse, journalOpenFailure, NO_ENROLL_JOURNAL, openEnrollJournal, openEnrollmentConflict, replayOperation, underAliasLock, type EnrollJournal } from "./link-operation";
import { tombstoneNamesAlias } from "../../link/tombstones";
import { isOperationId } from "../../link/operations-journal";
import { CHILD_CONFIG_TOO_LARGE_HINT, CHILD_CONFIG_TOO_LARGE_MESSAGE, CHILD_CONFIG_VALIDATE_MAX_OUTPUT_BYTES, CHILD_PREFLIGHT_MAX_OUTPUT_BYTES, childConfigFailureReason, childHealthRefusalHint, childRoleRefusalHint } from "./link-child-preflight";

const PROBE_TTL_MS = 5 * 60_000;
const MIN_REMOTE_OCX = [2, 66, 0] as const;
const REMOTE_OCX_VERSION = /^opencodex (\d{1,9})\.(\d{1,9})\.(\d{1,9})(-[0-9A-Za-z.-]{1,64})?(\+[0-9A-Za-z.-]{1,64})?(?=\s|$)/;

/**
 * What a refused apply that may have left the Child connected answers: the closed words a client maps to its own guidance
 * (residualKind: plant, only the managed binary's purge removes it, or enrollment; residualInstall for the latter, when the
 * apply knew it), the attempt's link id and the Child's platform when known, and a recovery line bound to that id
 * (src/link/residual-recovery.ts), which journalled replies share.
 */
export function liveResidual(kind: "plant" | "ephemeral" | "full", platform: "posix" | "windows" | undefined, linkId: string): { residualKind: "plant" | "enrollment"; residualInstall?: "ephemeral" | "full"; linkId: string; recovery: string; remotePlatform?: "posix" | "windows" } {
  return {
    residualKind: kind === "plant" ? "plant" : "enrollment",
    ...(kind === "plant" ? {} : { residualInstall: kind }),
    ...(platform ? { remotePlatform: platform } : {}),
    linkId,
    recovery: residualRecovery(kind, linkId, platform),
  };
}

/**
 * Same-alias operations refuse overlap rather than overwrite a confirmed generation. Keyed without case, as OpenSSH
 * matches known_hosts names and as the alias lock and the operation journal match aliases.
 */
export async function serialized(state: LinkRouteState, alias: string, action: () => Promise<Response>): Promise<Response> {
  const operations = state.operations ??= new Set();
  const key = alias.toLowerCase();
  if (operations.has(key)) return fail("link_operation_in_progress", "A link operation for this alias is already running.", 409);
  operations.add(key);
  try { return await action(); } finally { operations.delete(key); }
}

function remoteFailure(result: SshRunResult, code: string, message: string): Response | null {
  if (result.code === REMOTE_COMMAND_NOT_FOUND) return fail("remote_ocx_missing", "ocx was not found on the remote host.", 502, sshFailureHint(result.stderr));
  return result.code === 0 ? null : fail(code, message, 502, sshFailureHint(result.stderr));
}

function parseVersion(stdout: string): { version: string; parts: number[] } | null {
  const match = REMOTE_OCX_VERSION.exec(stdout.trim().split(/\r?\n/)[0] ?? "");
  return match ? { version: match.slice(1, 4).join(".") + (match[4] ?? "") + (match[5] ?? ""), parts: match.slice(1, 4).map(Number) } : null;
}

function isOutdatedVersion(parts: readonly number[]): boolean {
  const cmp = parts.findIndex((part, i) => part !== MIN_REMOTE_OCX[i]);
  return cmp >= 0 && parts[cmp]! < MIN_REMOTE_OCX[cmp]!;
}

export async function probe(ctx: ManagementContext, state: LinkRouteState): Promise<Response> {
  const split = splitRouteRequest(await readManagementJsonBodyOr(ctx.req, null));
  if ("error" in split) return split.error;
  const keyRefusal = identityFileRefusal(split.route.explicitRoute);
  if (keyRefusal) return keyRefusal;
  const value = split.body, wanted = split.route, route = wanted.explicitRoute, bound = routeFields(wanted);
  const body = exactBody(value, ["alias"]) ?? exactBody(value, ["alias", "includeVersion"]) ?? exactBody(value, ["alias", "includeVersion", "allowMissing"]);
  if (!body || typeof body.alias !== "string"
    || (body.includeVersion !== undefined && body.includeVersion !== true)
    || (body.allowMissing !== undefined && (typeof body.allowMissing !== "boolean" || body.includeVersion !== true))) {
    return fail("invalid_body", "alias is required.", 400);
  }
  const alias = body.alias;
  try { assertSshAlias(alias); } catch { return fail("invalid_alias", "alias must be a valid SSH host alias.", 400); }
  const resolveBinary = ctx.deps.resolveChildBinarySource ?? resolveChildBinarySource;
  return serialized(state, alias, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-link-probe-"));
    const path = join(dir, "known_hosts");
    writeFileSync(path, "", { mode: 0o600 });
    const runner = runnerFor(ctx), now = ctx.deps.now ?? Date.now;
    try {
      const started = now();
      const result = await runner.run(buildProbeArgv({ alias, tempKnownHostsFile: path, route }), { timeoutMs: 30_000 });
      const latency = Math.max(0, now() - started);
      if (result.code !== 0 || result.stdout.trim() !== "ocx-link-probe") return fail("probe_failed", "SSH host probing failed.", 502, sshFailureHint(result.stderr));
      const fp = await runner.run(buildFingerprintArgv(path), { timeoutMs: 10_000 });
      if (fp.code !== 0) return fail("fingerprint_failed", "The SSH host fingerprint could not be read.", 502, sshFailureHint(fp.stderr));
      const parsed = parseFingerprintLine(fp.stdout.trim());
      const line = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) return fail("fingerprint_failed", "The SSH probe did not record a host key.", 502);
      const remotePlatform = await requireRemotePlatform(runner, alias, route, path);
      if (body.includeVersion === true && body.allowMissing === true) {
        const inspected = await inspectRemoteChildRuntime(runner, alias, route, path, remotePlatform);
        if (!inspected) return fail("version_probe_failed", "The remote OpenCodex runtime could not be inspected.", 502);
        if (inspected.runtimeKind === "missing") {
          const source = resolveBinary(inspected.targetTriple);
          state.pendingHosts.set(alias, { alias, fingerprint: parsed.fingerprint, keyType: parsed.keyType, knownHostLine: line, probedAt: now(), sshLatencyMs: latency, remotePlatform, runtimeKind: "missing", targetTriple: inspected.targetTriple, ...bound });
          state.confirmedHosts?.delete(alias);
          return Response.json({
            alias,
            fingerprint: parsed.fingerprint,
            keyType: parsed.keyType,
            ocxVersion: null,
            runtimeKind: "missing",
            targetTriple: inspected.targetTriple,
            plantable: source.ok,
            ...(source.ok ? { binarySizeBytes: source.artifact.sizeBytes } : { plantUnavailableReason: source.reason }),
          });
        }
        const parsedVersion = parseVersion(inspected.ocxVersionLine ?? "");
        if (!parsedVersion) return fail("remote_ocx_unrecognized", "The remote ocx did not report an OpenCodex version.", 502);
        state.pendingHosts.set(alias, { alias, fingerprint: parsed.fingerprint, keyType: parsed.keyType, knownHostLine: line, probedAt: now(), sshLatencyMs: latency, remotePlatform, runtimeKind: inspected.runtimeKind, targetTriple: inspected.targetTriple, ...bound });
        state.confirmedHosts?.delete(alias);
        return Response.json({
          alias,
          fingerprint: parsed.fingerprint,
          keyType: parsed.keyType,
          ocxVersion: parsedVersion.version,
          runtimeKind: inspected.runtimeKind,
          targetTriple: inspected.targetTriple,
          plantable: false,
        });
      }
      let ocxVersion: string | undefined;
      if (body.includeVersion === true) {
        const versionResult = await runner.run(buildExecArgv({ alias, argv: remoteOcxArgv(["--version"], remotePlatform), knownHostsFile: path, route }), { timeoutMs: 30_000 });
        const denied = remoteFailure(versionResult, "version_probe_failed", "The remote ocx version could not be read.");
        if (denied) return denied;
        const parsedVersion = parseVersion(versionResult.stdout);
        if (!parsedVersion) return fail("remote_ocx_unrecognized", "The remote ocx did not report an OpenCodex version.", 502);
        ocxVersion = parsedVersion.version;
      }
      state.pendingHosts.set(alias, { alias, fingerprint: parsed.fingerprint, keyType: parsed.keyType, knownHostLine: line, probedAt: now(), sshLatencyMs: latency, remotePlatform, ...bound });
      state.confirmedHosts?.delete(alias);
      return Response.json({ alias, fingerprint: parsed.fingerprint, keyType: parsed.keyType, ...(ocxVersion === undefined ? {} : { ocxVersion }) });
    } catch (error) { return fail("probe_failed", "SSH host probing failed.", 502, sshRunnerErrorHint(error)); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

export async function confirmHost(ctx: ManagementContext, state: LinkRouteState): Promise<Response> {
  const split = splitRouteRequest(await readManagementJsonBodyOr(ctx.req, null));
  if ("error" in split) return split.error;
  const keyRefusal = identityFileRefusal(split.route.explicitRoute);
  if (keyRefusal) return keyRefusal;
  const value = split.body, wanted = split.route;
  const body = exactBody(value, ["alias", "fingerprint"]) ?? exactBody(value, ["alias", "fingerprint", "allowMissing"]);
  if (!body || typeof body.alias !== "string" || typeof body.fingerprint !== "string" || (body.allowMissing !== undefined && typeof body.allowMissing !== "boolean")) {
    return fail("invalid_body", "alias and fingerprint are required.", 400);
  }
  const alias = body.alias;
  const resolveBinary = ctx.deps.resolveChildBinarySource ?? resolveChildBinarySource;
  return serialized(state, alias, async () => {
    const pending = state.pendingHosts.get(alias), now = ctx.deps.now ?? Date.now;
    if (!pending || now() - pending.probedAt > PROBE_TTL_MS) return fail("host_confirmation_expired", "The SSH host probe has expired.", 409);
    if (pending.fingerprint !== body.fingerprint) return fail("host_fingerprint_mismatch", "The confirmed fingerprint does not match the probe.", 409);
    if (!sameRouteRequest(routeOf(pending), wanted)) return routeMismatch();
    const route = pending.explicitRoute ?? null;
    const dir = mkdtempSync(join(tmpdir(), "ocx-link-confirm-")), path = join(dir, "known_hosts");
    writeFileSync(path, pending.knownHostLine + "\n", { mode: 0o600 });
    try {
      const started = now();
      const runner = runnerFor(ctx);
      const remotePlatform = pending.remotePlatform ?? await requireRemotePlatform(runner, alias, route, path);
      if (body.allowMissing === true) {
        const inspected = await inspectRemoteChildRuntime(runner, alias, route, path, remotePlatform);
        if (!inspected) return fail("version_probe_failed", "The remote ocx version could not be confirmed.", 502);
        if (inspected.runtimeKind === "missing") {
          const source = resolveBinary(inspected.targetTriple);
          if (state.pendingHosts.get(alias) !== pending || now() - pending.probedAt > PROBE_TTL_MS) return fail("host_confirmation_expired", "The SSH host probe changed or expired.", 409);
          if (!putConfirmedKnownHost(ctx, alias, pending.knownHostLine, pending.fingerprint)) return linkPinConflict();
          const confirmed = {
            ...pending,
            remotePlatform,
            sshLatencyMs: Math.max(pending.sshLatencyMs ?? 0, now() - started),
            ocxVersion: null,
            runtimeKind: "missing" as const,
            targetTriple: inspected.targetTriple,
            plantable: source.ok,
            ...(source.ok ? { binarySizeBytes: source.artifact.sizeBytes } : { plantUnavailableReason: source.reason }),
          };
          (state.confirmedHosts ??= new Map()).set(alias, confirmed);
          state.pendingHosts.delete(alias);
          return Response.json({
            alias,
            fingerprint: pending.fingerprint,
            ocxVersion: null,
            runtimeKind: "missing",
            targetTriple: inspected.targetTriple,
            plantable: source.ok,
            ...(source.ok ? { binarySizeBytes: source.artifact.sizeBytes } : { plantUnavailableReason: source.reason }),
          });
        }
        const version = parseVersion(inspected.ocxVersionLine ?? "");
        if (!version) return fail("remote_ocx_unrecognized", "The remote ocx did not report an OpenCodex version.", 502);
        if (isOutdatedVersion(version.parts)) return fail("remote_ocx_outdated", "The remote OpenCodex is older than 2.66.0.", 409, boundHint("opencodex " + version.version));
        if (state.pendingHosts.get(alias) !== pending || now() - pending.probedAt > PROBE_TTL_MS) return fail("host_confirmation_expired", "The SSH host probe changed or expired.", 409);
        if (!putConfirmedKnownHost(ctx, alias, pending.knownHostLine, pending.fingerprint)) return linkPinConflict();
        const confirmed = { ...pending, remotePlatform, sshLatencyMs: Math.max(pending.sshLatencyMs ?? 0, now() - started), ocxVersion: version.version, runtimeKind: inspected.runtimeKind, targetTriple: inspected.targetTriple, plantable: false };
        (state.confirmedHosts ??= new Map()).set(alias, confirmed);
        state.pendingHosts.delete(alias);
        return Response.json({
          alias,
          fingerprint: pending.fingerprint,
          ocxVersion: version.version,
          runtimeKind: inspected.runtimeKind,
          targetTriple: inspected.targetTriple,
          plantable: false,
        });
      }
      const result = await runner.run(buildExecArgv({ alias, argv: remoteOcxArgv(["--version"], remotePlatform), knownHostsFile: path, route }), { timeoutMs: 30_000 });
      const denied = remoteFailure(result, "version_probe_failed", "The remote ocx version could not be confirmed.");
      if (denied) return denied;
      const version = parseVersion(result.stdout);
      if (!version) return fail("remote_ocx_unrecognized", "The remote ocx did not report an OpenCodex version.", 502);
      if (isOutdatedVersion(version.parts)) return fail("remote_ocx_outdated", "The remote OpenCodex is older than 2.66.0.", 409, boundHint("opencodex " + version.version));
      if (state.pendingHosts.get(alias) !== pending || now() - pending.probedAt > PROBE_TTL_MS) return fail("host_confirmation_expired", "The SSH host probe changed or expired.", 409);
      if (!putConfirmedKnownHost(ctx, alias, pending.knownHostLine, pending.fingerprint)) return linkPinConflict();
      const confirmed = { ...pending, remotePlatform, sshLatencyMs: Math.max(pending.sshLatencyMs ?? 0, now() - started), ocxVersion: version.version };
      (state.confirmedHosts ??= new Map()).set(alias, confirmed);
      state.pendingHosts.delete(alias);
      return Response.json({ alias, fingerprint: pending.fingerprint, ocxVersion: version.version });
    } catch (error) { return fail("version_probe_failed", "The remote ocx version could not be confirmed.", 502, sshRunnerErrorHint(error)); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

function confirmedLineTrust(path: string, alias: string, line: string): ConfirmedLineTrust {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return "key_changed"; }
  return confirmedLineTrustIn(text, alias, line);
}

function linkPinConflict(): Response {
  return fail("link_pin_conflict", "A Home-initiated link already pins another key for this alias; remove that link before trusting another key.", 409);
}

const APPLY_KEYS = new Set(["alias", "fingerprint", "plant", "operationId", "requireEphemeral"]);

function parsePort(stdout: string): number | null {
  try { const value: unknown = JSON.parse(stdout.trim()); return isRecord(value) && Object.keys(value).length === 1 && port(value.port) ? value.port : null; }
  catch { return null; }
}

export async function apply(ctx: ManagementContext, state: LinkRouteState): Promise<Response> {
  const split = splitRouteRequest(await readManagementJsonBodyOr(ctx.req, null));
  if ("error" in split) return split.error;
  const value = split.body, wanted = split.route;
  const body = isRecord(value) && Object.keys(value).every(key => APPLY_KEYS.has(key)) ? value : null;
  if (!body || typeof body.alias !== "string" || (body.fingerprint !== undefined && typeof body.fingerprint !== "string") || (body.plant !== undefined && typeof body.plant !== "boolean")
    || (body.operationId !== undefined && !isOperationId(body.operationId)) || (body.requireEphemeral !== undefined && body.requireEphemeral !== true)) {
    return fail("invalid_body", "alias and optional fingerprint/plant are required.", 400);
  }
  const alias = body.alias;
  // A repeat replays without probing, so the fingerprint is what names the operation (the CLI requires it too).
  if (body.operationId !== undefined && typeof body.fingerprint !== "string") return fail("invalid_body", "operationId requires fingerprint.", 400);
  const resolveBinary = ctx.deps.resolveChildBinarySource ?? resolveChildBinarySource;
  // ocx link add --operation-id (structure/remote-link.md, "Operation journal"): replay, recovery and the reserved ids.
  const operation = typeof body.operationId === "string" ? { id: body.operationId, digest: enrollOperationDigest({ alias,
    ...(typeof body.fingerprint === "string" ? { fingerprint: body.fingerprint } : {}), route: wanted, requireEphemeral: body.requireEphemeral === true }) } : null;
  // A tombstone for this alias means recover can run against the machine; it holds the alias lock, so this does too.
  return underAliasLock(ctx, alias, operation !== null || journalInUse(ctx) || tombstoneNamesAlias(alias), async () => {
  if (operation) {
    const replay = await replayOperation(ctx, state, operation, "enroll");
    if (replay) return replay;
  }
  const open = openEnrollmentConflict(ctx, alias, operation?.id);
  if (open) return open;
  return serialized(state, alias, async () => {
    const confirmed = state.confirmedHosts?.get(alias), now = ctx.deps.now ?? Date.now;
    if (!confirmed) return fail("host_not_confirmed", "Confirm the SSH host before applying the link.", 409);
    if (now() - confirmed.probedAt > PROBE_TTL_MS) return fail("host_confirmation_expired", "The SSH host confirmation has expired.", 409);
    if (body.fingerprint !== undefined && body.fingerprint !== confirmed.fingerprint) return fail("host_fingerprint_mismatch", "The apply fingerprint does not match the confirmed host.", 409);
    if (!sameRouteRequest(routeOf(confirmed), wanted)) return routeMismatch();
    const route = confirmed.explicitRoute ?? null;
    // After the replay above, before the journal entry and any SSH: a new operation needs a key ssh can use.
    const keyRefusal = identityFileRefusal(route);
    if (keyRefusal) return keyRefusal;
    if (readStoreFor(ctx).links.some(link => link.alias === alias && link.direction === "hub-initiated")) return fail("link_exists", "A link for this alias already exists.", 409);
    if (confirmed.runtimeKind === "missing" && body.plant !== true) {
      return fail("remote_ocx_missing", "ocx was not found on the remote host; confirm planting ocx-child before applying.", 409);
    }
    let journal: EnrollJournal = NO_ENROLL_JOURNAL;
    if (operation) {
      try { journal = openEnrollJournal(ctx, operation, alias, routeFields(routeOf(confirmed))); } catch (error) {
        return journalOpenFailure(error);
      }
    }
    // The attempt's link id, fixed before anything changes on the Child: a residual answer binds the Child's step to it, even
    // for a plant whose rollback failed before the link was stored.
    const attemptLinkId = journal.reservedLinkId ?? newLinkId();
    return journal.finish(await (async (): Promise<Response> => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-link-apply-")), knownHosts = join(dir, "known_hosts");
    writeFileSync(knownHosts, confirmed.knownHostLine + "\n", { mode: 0o600 });
    const runner = runnerFor(ctx), budget = linkCommandBudget(confirmed.sshLatencyMs);
    const run = (argv: readonly string[], timeoutMs = budget, maxOutputBytes?: number) => runner.run(buildExecArgv({ alias, argv, knownHostsFile: knownHosts, route }), { timeoutMs, ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }) });
    let remotePlatform: "posix" | "windows" | undefined;
    const knownPlatform = (): "posix" | "windows" | undefined => remotePlatform;
    const ocx = (args: readonly string[]) => remoteOcxArgv(args, remotePlatform);
    let record: LinkStore["links"][number] | undefined, input: Uint8Array | undefined;
    // A key issued for a record that has not passed the locked alias and trust checks. Until then a
    // failure revokes only the key: compensation, which may store its record, is for a validated one.
    let unvalidatedKeyId: string | undefined;
    // The alias and trust checks a new record must pass under the mutation lock, both when it is
    // first written and when compensation would store it again: no other Home-initiated link owns
    // the alias in any case, and the live known_hosts still trusts exactly the confirmed key.
    const linkCheck = (current: LinkStore, self?: string): "exists" | ConfirmedLineTrust => {
      const wanted = alias.toLowerCase();
      if (current.links.some(link => link.id !== self && link.alias.toLowerCase() === wanted && link.direction === "hub-initiated")) return "exists";
      return confirmedLineTrust(knownHostsFile(ctx), alias, confirmed.knownHostLine);
    };
    let ephemeralChild = confirmed.runtimeKind === "ephemeral", plantedFreshBinary = false, purgeRollbackFailed = false, remoteMayBeConnected = false, phase = "remote_port";
    const failed = async (response: Response): Promise<Response> => {
      const own = record;
      let compensation = own ? await compensateNewLink(ctx, state, own, current => linkCheck(current, own.id) === "trusted") : null;
      if (!record && unvalidatedKeyId !== undefined) {
        const keyId = unvalidatedKeyId;
        unvalidatedKeyId = undefined;
        if (!revokeKeyIdempotent(ctx, keyId)) {
          console.warn("[link] apply failed before storing the link; its issued key could not be revoked");
          compensation = keyCleanupFailed();
        }
      }
      if (plantedFreshBinary) {
        plantedFreshBinary = false;
        try {
          const purged = await run(remotePurgePlantedChildArgv(remotePlatform));
          if (purged.code === 0) remoteMayBeConnected = false;
          else { remoteMayBeConnected = true; purgeRollbackFailed = true; }
        } catch {
          remoteMayBeConnected = true;
          purgeRollbackFailed = true;
        }
      }
      const outcome = compensation ?? response;
      if (!remoteMayBeConnected) return outcome;
      const payload = await outcome.json() as Record<string, unknown>;
      const residual = liveResidual(purgeRollbackFailed ? "plant" : ephemeralChild ? "ephemeral" : "full", knownPlatform(), attemptLinkId);
      return Response.json({ ...payload, residual: true, ...residual }, { status: outcome.status });
    };
    try {
      remotePlatform = confirmed.remotePlatform ?? await requireRemotePlatform(runner, alias, route, knownHosts);
      if (body.requireEphemeral === true) {
        // Before any plant, key or Child change: a runnable full ocx anywhere the gated argv looks refuses.
        phase = "full_install_census";
        if (remotePlatform === "windows") return fail("require_ephemeral_unsupported", "--require-ephemeral is not supported for a Windows Child.", 409);
        const census = await run(remoteFullInstallCensusArgv());
        const verdict = census.code === 0 ? parseFullInstallCensus(census.stdout) : null;
        if (verdict === null) return fail("full_install_census_failed", "The Child could not be checked for a full OpenCodex install.", 502, sshFailureHint(census.stderr));
        if (verdict === "present") return fail("full_install_present", "A full OpenCodex install is on the Child; --require-ephemeral refuses it before any change.", 409);
      }
      if (body.plant === true && confirmed.runtimeKind === "missing") {
        phase = "remote_plant";
        const source = resolveBinary(confirmed.targetTriple ?? null);
        if (!source.ok) return fail("remote_plant_unavailable", plantUnavailableGuidance(source.reason, confirmed.targetTriple ?? null), 409, source.reason);
        let planted: SshRunResult;
        journal.intent("plant");
        try {
          planted = await runner.run(
            buildExecArgv({ alias, argv: remotePlantChildArgv(remotePlatform, source.artifact.sizeBytes, source.artifact.sha256), knownHostsFile: knownHosts, route }),
            { stdin: source.artifact.bytes, timeoutMs: Math.max(budget, 60_000) },
          );
        } catch (plantErr) {
          if (plantErr instanceof SshRunnerError && plantErr.code === "timeout") {
            return fail("remote_plant_timeout", "Planting ocx-child on the remote host timed out.", 502, sshRunnerErrorHint(plantErr));
          }
          return fail("remote_plant_failed", "Could not plant ocx-child on the remote host.", 502, sshRunnerErrorHint(plantErr));
        }
        if (planted.code !== 0) {
          const reason = classifyPlantFailure(planted.stderr);
          if (reason) return fail("remote_plant_failed", "The Child has no sha256sum, shasum, or openssl to verify the ocx-child binary, so it was not installed.", 502, reason);
          return fail("remote_plant_failed", "Could not plant ocx-child on the remote host.", 502, sshFailureHint(planted.stderr));
        }
        plantedFreshBinary = true;
        journal.done("plant");
        ephemeralChild = true;
      }
      phase = "remote_port";
      const chosen = await run(ocx(["link", "port"]));
      const denied = remoteFailure(chosen, "remote_port_failed", "The remote link port could not be determined.");
      if (denied) return await failed(denied);
      const remotePort = parsePort(chosen.stdout);
      if (!remotePort) return await failed(fail("remote_port_failed", "The remote link port could not be determined.", 502));
      journal.port(remotePort);
      phase = "child_preflight";
      const configured = await run(ocx(["config", "show", "--json"]), budget, CHILD_PREFLIGHT_MAX_OUTPUT_BYTES);
      let childConfig: unknown = null;
      try { if (configured.code === 0) childConfig = JSON.parse(configured.stdout); } catch { /* fail closed */ }
      if (!isRecord(childConfig) || !port(childConfig.port)) {
        const hint = await childConfigFailureReason(configured, () => run(ocx(["config", "validate", "--json"]), budget, CHILD_CONFIG_VALIDATE_MAX_OUTPUT_BYTES));
        return await failed(fail("child_preflight_failed", "The Child effective configuration could not be read.", 502, hint));
      }
      if ((childConfig.runtimeRole ?? "standalone") !== "standalone") return await failed(fail("child_restart_unsupported", "The Child must run standalone OpenCodex; an existing Hub or Child cannot be converted by Add Child.", 409, childRoleRefusalHint(childConfig.runtimeRole)));
      const childPort = childConfig.port;
      if (remotePlatform === "posix" && (await run(REMOTE_CURL_PREFLIGHT)).code !== 0) return await failed(fail("child_curl_missing", "Install curl on the Child before connecting a Remote Link.", 409));
      const before = await run(remoteChildHttpArgv(childPort, "healthz", LINK_RELAY_VERIFY_MS, remotePlatform));
      ephemeralChild = isDetachedEphemeralChildConfig(childConfig);
      if (ephemeralChild) {
        if (before.code === 255) return await failed(fail("child_preflight_failed", "The Child loopback port could not be inspected.", 502, sshFailureHint(before.stderr)));
        if (before.code === 0) return await failed(fail("child_port_busy", "The Child's target port is already in use; no Child files were modified.", 409));
      } else {
        let beforeHealth: unknown = null;
        try { if (before.code === 0) beforeHealth = parseChildHttp(before.stdout); } catch { /* reported as nothing answering */ }
        if (!isChildHealth(beforeHealth, "standalone", childPort)) return await failed(fail("child_restart_unsupported", "The Child must run a standalone OpenCodex with bound restart support; update or disconnect it before linking.", 409, childHealthRefusalHint(beforeHealth, childPort)));
      }
      state.confirmedHosts?.delete(alias);
      phase = "home_setup";
      const id = attemptLinkId;
      journal.intent("key_issued");
      let issued: ReturnType<typeof issueKey>;
      if (journal.reservedKeyId === undefined) issued = issueKey(ctx, "link:" + alias);
      else {
        // The config may be saved before issuing throws (a reconcile that fails afterwards), leaving the reserved key
        // durable while memory says it is absent: never settle that as clean.
        // failed() still rolls back a binary this apply planted; the key's own outcome stays unknown.
        try { issued = issueKey(ctx, "link:" + alias, journal.reservedKeyId); } catch {
          return await failed(fail("key_issue_uncertain", "Issuing the link key failed after it may have been saved; whether the reserved key exists is unknown.", 500));
        }
      }
      unvalidatedKeyId = issued.id;
      if (journal.reservedKeyId !== undefined && issued.id !== journal.reservedKeyId) return await failed(fail("key_reservation_failed", "The link key was not issued under its reserved id.", 500));
      journal.done("key_issued");
      const candidate: LinkStore["links"][number] = { id, alias, direction: "hub-initiated", hostKeyFingerprint: confirmed.fingerprint, tunnelPort: remotePort, apiKeyId: issued.id, createdAt: new Date(now()).toISOString(), remotePlatform, childKind: ephemeralChild ? "ephemeral" : "full", ...routeFields(routeOf(confirmed)) };
      // Under the same lock as the store write: no Home-initiated link may own this alias in any
      // case, and the live known_hosts must still trust exactly the confirmed key for it (another
      // confirmation, under any spelling, may have replaced it since this one). Only a record that
      // passed both becomes `record`, the one compensation handles; any earlier failure, an
      // exception included, leaves it unset and revokes the key alone. A write that throws leaves
      // its outcome unknown: compensation re-runs the same checks before it would store the record.
      journal.intent("link_recorded");
      const created = withConfigMutationLockSync((): "written" | "exists" | ConfirmedLineTrust => {
        const current = readStoreFor(ctx);
        const check = linkCheck(current);
        if (check !== "trusted") return check;
        record = candidate;
        unvalidatedKeyId = undefined;
        writeStoreFor(ctx, { ...current, links: [...current.links, candidate] });
        return "written";
      });
      if (created !== "written") {
        // The record failed validation and was never stored; failed() revokes its key alone.
        return await failed(created === "exists"
          ? fail("link_exists", "A link for this alias already exists.", 409)
          : created === "trust_file_unexpected"
            ? fail("trust_file_unexpected", "The link known_hosts file has a pattern, host-list, marker or malformed line; remove that line, then probe and confirm the host again.", 409)
            : fail("host_key_changed", "The confirmed host key is no longer the one trusted for this alias; probe and confirm the host again.", 409));
      }
      // An ephemeral ocx-child never reads route intent, so its enrollment saves none: seeding would
      // also start ocx sync applying route intent to every Home client.
      if (!ephemeralChild) withConfigMutationLockSync(() => seedRouteDeviceClients(ctx.config, ctx.version, id, undefined, readStoreFor(ctx).links.map(link => link.id)));
      journal.done("link_recorded");
      await state.listener.ensureStarted();
      if (state.listener.status().state !== "listening") return await failed(fail("listener_unavailable", "The link listener is unavailable.", 503));
      await state.supervisor.ensureStarted();
      await state.supervisor.reload();
      phase = "remote_connect";
      input = new TextEncoder().encode(JSON.stringify({ apiKeyId: issued.id, key: issued.key }));
      journal.intent("child_enrolled");
      remoteMayBeConnected = true;
      const connected = await runner.run(buildExecArgv({ alias, argv: ocx(["connect", "--link", "--key-stdin", "--tunnel-port", String(remotePort), "--link-id", id]), knownHostsFile: knownHosts, route }), { stdin: input, timeoutMs: budget });
      if (connected.code !== 0) {
        const conflict = classifyChildAttachConflict(connected.stderr);
        if (conflict === "child_port_busy") {
          remoteMayBeConnected = false;
          return await failed(fail("child_port_busy", "The Child's target port is already in use; no Child files were modified.", 409, sshFailureHint(connected.stderr)));
        }
        if (conflict === "child_external_provider_conflict") {
          remoteMayBeConnected = false;
          return await failed(fail("child_external_provider_conflict", "The Child's ~/.codex/config.toml is already managed by another model provider or custom base URL; no Child files were modified.", 409, sshFailureHint(connected.stderr)));
        }
      }
      const connectDenied = remoteFailure(connected, "remote_connect_failed", "The Child enrollment command failed.");
      if (connectDenied) return await failed(connectDenied);
      input.fill(0);
      journal.done("child_enrolled");
      journal.intent("relay_verified");
      phase = "child_restart";
      const restarted = await run(ocx(["restart"]), linkRestartBudget(confirmed.sshLatencyMs));
      if (restarted.code !== 0) return await failed(fail("child_restart_failed", "The Child restart could not be verified.", 502, sshFailureHint(restarted.stderr)));
      phase = "child_relay";
      const deadline = now() + LINK_RELAY_VERIFY_MS, remaining = () => Math.max(1, deadline - now());
      const health = await run(remoteChildHttpArgv(childPort, "healthz", remaining(), remotePlatform), remaining());
      if (!isChildHealth(health.code === 0 ? parseChildHttp(health.stdout) : null, "client", childPort)) return await failed(fail("child_runtime_not_client", "The Child is not serving the client runtime after restart.", 502));
      let admitted = false;
      const unsubscribe = state.listener.onAuthenticatedCatalog(keyId => { if (keyId === issued.id) admitted = true; });
      try {
        if (now() >= deadline) return await failed(fail("child_relay_timeout", "The Child relay verification deadline expired.", 502));
        const catalog = await run(remoteChildHttpArgv(childPort, "v1/catalog", remaining(), remotePlatform), remaining(), LINK_CATALOG_MAX_BYTES);
        let data: unknown = null;
        try { if (catalog.code === 0) data = parseChildHttp(catalog.stdout); } catch { /* malformed is not a completed catalog */ }
        if (!isRecord(data) || !Array.isArray(data.models) || !admitted || now() > deadline) return await failed(fail("child_relay_failed", "The Child did not relay a complete authenticated catalog through this Home.", 502));
        journal.done("relay_verified");
        return Response.json({ linkId: id }, { status: 202 });
      } finally { unsubscribe(); }
    } catch (error) {
      if (phase === "child_preflight" && error instanceof SshRunnerError && error.code === "output_limit") {
        return await failed(fail("child_preflight_output_limit", CHILD_CONFIG_TOO_LARGE_MESSAGE, 502, CHILD_CONFIG_TOO_LARGE_HINT));
      }
      return await failed(fail(phase + (error instanceof SshRunnerError && error.code === "timeout" ? "_timeout" : "_failed"), "Remote Link failed during " + phase.replaceAll("_", " ") + ".", 502, sshRunnerErrorHint(error)));
    } finally { input?.fill(0); rmSync(dir, { recursive: true, force: true }); }
    })());
  });
  });
}
