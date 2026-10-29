import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSshAlias, buildExecArgv, buildFingerprintArgv, buildProbeArgv, REMOTE_COMMAND_NOT_FOUND, remoteOcxArgv } from "../../link/ssh-argv";
import { parseFingerprintLine } from "../../link/fingerprint";
import { requireRemotePlatform } from "../../link/remote-platform";
import type { SshRunner } from "../../link/ssh-runner";
import { LINK_CATALOG_MAX_BYTES, LINK_RELAY_VERIFY_MS, isChildHealth, linkCommandBudget, linkRestartBudget, parseChildHttp, remoteChildHttpArgv, REMOTE_CURL_PREFLIGHT } from "../../link/remote-probe";
import { newLinkId, type LinkStore } from "../../link/store";
import { SshRunnerError, boundHint, sshFailureHint, sshRunnerErrorHint, type SshRunResult } from "../../link/ssh-runner";
import { withConfigMutationLockSync } from "../../config/mutation-lock";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import { fail, exactBody, port, isRecord, runnerFor, readStoreFor, writeStoreFor, knownHostsFile, putKnownHost, issueKey, compensateNewLink, type LinkRouteState } from "./link-route-state";

const PROBE_TTL_MS = 5 * 60_000;
const MIN_REMOTE_OCX = [2, 66, 0] as const;
const REMOTE_OCX_VERSION = /^opencodex (\d{1,9})\.(\d{1,9})\.(\d{1,9})(-[0-9A-Za-z.-]{1,64})?(\+[0-9A-Za-z.-]{1,64})?(?=\s|$)/;

/** Same-alias operations refuse overlap rather than overwrite a confirmed generation. */
async function serialized(state: LinkRouteState, alias: string, action: () => Promise<Response>): Promise<Response> {
  const operations = state.operations ??= new Set();
  if (operations.has(alias)) return fail("link_operation_in_progress", "A link operation for this alias is already running.", 409);
  operations.add(alias);
  try { return await action(); } finally { operations.delete(alias); }
}

function remoteFailure(result: SshRunResult, code: string, message: string): Response | null {
  if (result.code === REMOTE_COMMAND_NOT_FOUND) return fail("remote_ocx_missing", "ocx was not found on the remote host.", 502, sshFailureHint(result.stderr));
  return result.code === 0 ? null : fail(code, message, 502, sshFailureHint(result.stderr));
}

export async function probe(ctx: ManagementContext, state: LinkRouteState): Promise<Response> {
  const value = await readManagementJsonBodyOr(ctx.req, null);
  const body = exactBody(value, ["alias"]) ?? exactBody(value, ["alias", "includeVersion"]);
  if (!body || typeof body.alias !== "string" || (body.includeVersion !== undefined && body.includeVersion !== true)) return fail("invalid_body", "alias is required.", 400);
  const alias = body.alias;
  try { assertSshAlias(alias); } catch { return fail("invalid_alias", "alias must be a valid SSH host alias.", 400); }
  return serialized(state, alias, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-link-probe-"));
    const path = join(dir, "known_hosts");
    writeFileSync(path, "", { mode: 0o600 });
    const runner = runnerFor(ctx), now = ctx.deps.now ?? Date.now;
    try {
      const started = now();
      const result = await runner.run(buildProbeArgv({ alias, tempKnownHostsFile: path }), { timeoutMs: 30_000 });
      const latency = Math.max(0, now() - started);
      if (result.code !== 0 || result.stdout.trim() !== "ocx-link-probe") return fail("probe_failed", "SSH host probing failed.", 502, sshFailureHint(result.stderr));
      const fp = await runner.run(buildFingerprintArgv(path), { timeoutMs: 10_000 });
      if (fp.code !== 0) return fail("fingerprint_failed", "The SSH host fingerprint could not be read.", 502, sshFailureHint(fp.stderr));
      const parsed = parseFingerprintLine(fp.stdout.trim());
      const line = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) return fail("fingerprint_failed", "The SSH probe did not record a host key.", 502);
      const remotePlatform = await requireRemotePlatform(runner, alias, path);
      let ocxVersion: string | undefined;
      if (body.includeVersion === true) {
        const versionResult = await runner.run(buildExecArgv({ alias, argv: remoteOcxArgv(["--version"], remotePlatform), knownHostsFile: path }), { timeoutMs: 30_000 });
        const denied = remoteFailure(versionResult, "version_probe_failed", "The remote ocx version could not be read.");
        if (denied) return denied;
        const parsedVersion = parseVersion(versionResult.stdout);
        if (!parsedVersion) return fail("remote_ocx_unrecognized", "The remote ocx did not report an OpenCodex version.", 502);
        ocxVersion = parsedVersion.version;
      }
      state.pendingHosts.set(alias, { alias, fingerprint: parsed.fingerprint, keyType: parsed.keyType, knownHostLine: line, probedAt: now(), sshLatencyMs: latency, remotePlatform });
      state.confirmedHosts?.delete(alias);
      return Response.json({ alias, fingerprint: parsed.fingerprint, keyType: parsed.keyType, ...(ocxVersion === undefined ? {} : { ocxVersion }) });
    } catch (error) { return fail("probe_failed", "SSH host probing failed.", 502, sshRunnerErrorHint(error)); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

function parseVersion(stdout: string): { version: string; parts: number[] } | null {
  const match = REMOTE_OCX_VERSION.exec(stdout.trim().split(/\r?\n/)[0] ?? "");
  return match ? { version: match.slice(1, 4).join(".") + (match[4] ?? "") + (match[5] ?? ""), parts: match.slice(1, 4).map(Number) } : null;
}

export async function confirmHost(ctx: ManagementContext, state: LinkRouteState): Promise<Response> {
  const body = exactBody(await readManagementJsonBodyOr(ctx.req, null), ["alias", "fingerprint"]);
  if (!body || typeof body.alias !== "string" || typeof body.fingerprint !== "string") return fail("invalid_body", "alias and fingerprint are required.", 400);
  const alias = body.alias;
  return serialized(state, alias, async () => {
    const pending = state.pendingHosts.get(alias), now = ctx.deps.now ?? Date.now;
    if (!pending || now() - pending.probedAt > PROBE_TTL_MS) return fail("host_confirmation_expired", "The SSH host probe has expired.", 409);
    if (pending.fingerprint !== body.fingerprint) return fail("host_fingerprint_mismatch", "The confirmed fingerprint does not match the probe.", 409);
    const dir = mkdtempSync(join(tmpdir(), "ocx-link-confirm-")), path = join(dir, "known_hosts");
    writeFileSync(path, pending.knownHostLine + "\n", { mode: 0o600 });
    try {
      const started = now();
      const runner = runnerFor(ctx);
      const remotePlatform = pending.remotePlatform ?? await requireRemotePlatform(runner, alias, path);
      const result = await runner.run(buildExecArgv({ alias, argv: remoteOcxArgv(["--version"], remotePlatform), knownHostsFile: path }), { timeoutMs: 30_000 });
      const denied = remoteFailure(result, "version_probe_failed", "The remote ocx version could not be confirmed.");
      if (denied) return denied;
      const version = parseVersion(result.stdout);
      if (!version) return fail("remote_ocx_unrecognized", "The remote ocx did not report an OpenCodex version.", 502);
      const cmp = version.parts.findIndex((part, i) => part !== MIN_REMOTE_OCX[i]);
      if (cmp >= 0 && version.parts[cmp]! < MIN_REMOTE_OCX[cmp]!) return fail("remote_ocx_outdated", "The remote OpenCodex is older than 2.66.0.", 409, boundHint("opencodex " + version.version));
      if (state.pendingHosts.get(alias) !== pending || now() - pending.probedAt > PROBE_TTL_MS) return fail("host_confirmation_expired", "The SSH host probe changed or expired.", 409);
      withConfigMutationLockSync(() => putKnownHost(knownHostsFile(ctx), alias, pending.knownHostLine));
      const confirmed = { ...pending, remotePlatform, sshLatencyMs: Math.max(pending.sshLatencyMs ?? 0, now() - started), ocxVersion: version.version };
      (state.confirmedHosts ??= new Map()).set(alias, confirmed);
      state.pendingHosts.delete(alias);
      return Response.json({ alias, fingerprint: pending.fingerprint, ocxVersion: version.version });
    } catch (error) { return fail("version_probe_failed", "The remote ocx version could not be confirmed.", 502, sshRunnerErrorHint(error)); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

function parsePort(stdout: string): number | null {
  try { const value: unknown = JSON.parse(stdout.trim()); return isRecord(value) && Object.keys(value).length === 1 && port(value.port) ? value.port : null; }
  catch { return null; }
}

export async function apply(ctx: ManagementContext, state: LinkRouteState): Promise<Response> {
  const value = await readManagementJsonBodyOr(ctx.req, null);
  const body = exactBody(value, ["alias"]) ?? exactBody(value, ["alias", "fingerprint"]);
  if (!body || typeof body.alias !== "string" || (body.fingerprint !== undefined && typeof body.fingerprint !== "string")) return fail("invalid_body", "alias and optional fingerprint are required.", 400);
  const alias = body.alias;
  return serialized(state, alias, async () => {
    const confirmed = state.confirmedHosts?.get(alias), now = ctx.deps.now ?? Date.now;
    if (!confirmed) return fail("host_not_confirmed", "Confirm the SSH host before applying the link.", 409);
    if (now() - confirmed.probedAt > PROBE_TTL_MS) return fail("host_confirmation_expired", "The SSH host confirmation has expired.", 409);
    if (body.fingerprint !== undefined && body.fingerprint !== confirmed.fingerprint) return fail("host_fingerprint_mismatch", "The apply fingerprint does not match the confirmed host.", 409);
    if (readStoreFor(ctx).links.some(link => link.alias === alias && link.direction === "hub-initiated")) return fail("link_exists", "A link for this alias already exists.", 409);
    const dir = mkdtempSync(join(tmpdir(), "ocx-link-apply-")), knownHosts = join(dir, "known_hosts");
    writeFileSync(knownHosts, confirmed.knownHostLine + "\n", { mode: 0o600 });
    const runner = runnerFor(ctx), budget = linkCommandBudget(confirmed.sshLatencyMs);
    const run = (argv: readonly string[], timeoutMs = budget, maxOutputBytes?: number) => runner.run(buildExecArgv({ alias, argv, knownHostsFile: knownHosts }), { timeoutMs, ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }) });
    let remotePlatform: "posix" | "windows";
    const ocx = (args: readonly string[]) => remoteOcxArgv(args, remotePlatform);
    let record: LinkStore["links"][number] | undefined, input: Uint8Array | undefined;
    let remoteMayBeConnected = false, phase = "remote_port";
    const failed = async (response: Response): Promise<Response> => {
      const compensation = record ? await compensateNewLink(ctx, state, record) : null;
      const outcome = compensation ?? response;
      if (!remoteMayBeConnected) return outcome;
      const payload = await outcome.json() as Record<string, unknown>;
      return Response.json({ ...payload, residual: true, recovery: "Run ocx disconnect and ocx restart on the Child before retrying." }, { status: outcome.status });
    };
    try {
      remotePlatform = confirmed.remotePlatform ?? await requireRemotePlatform(runner, alias, knownHosts);
      const chosen = await run(ocx(["link", "port"]));
      const denied = remoteFailure(chosen, "remote_port_failed", "The remote link port could not be determined.");
      if (denied) return denied;
      const remotePort = parsePort(chosen.stdout);
      if (!remotePort) return fail("remote_port_failed", "The remote link port could not be determined.", 502);
      phase = "child_preflight";
      const configured = await run(ocx(["config", "show", "--json"]));
      let childConfig: unknown = null;
      try { if (configured.code === 0) childConfig = JSON.parse(configured.stdout); } catch { /* fail closed */ }
      if (!isRecord(childConfig) || !port(childConfig.port)) return fail("child_preflight_failed", "The Child effective configuration could not be read.", 502);
      if ((childConfig.runtimeRole ?? "standalone") !== "standalone") return fail("child_restart_unsupported", "The Child must run standalone OpenCodex; an existing Hub or Child cannot be converted by Add Child.", 409);
      const childPort = childConfig.port;
      if (remotePlatform === "posix" && (await run(REMOTE_CURL_PREFLIGHT)).code !== 0) return fail("child_curl_missing", "Install curl on the Child before connecting a Remote Link.", 409);
      const before = await run(remoteChildHttpArgv(childPort, "healthz", LINK_RELAY_VERIFY_MS, remotePlatform));
      const beforeHealth = before.code === 0 ? parseChildHttp(before.stdout) : null;
      if (!isChildHealth(beforeHealth, "standalone", childPort)) return fail("child_restart_unsupported", "The Child must run a standalone OpenCodex with bound restart support; update or disconnect it before linking.", 409);
      state.confirmedHosts?.delete(alias);
      phase = "home_setup";
      const id = newLinkId(), issued = issueKey(ctx, "link:" + alias);
      record = { id, alias, direction: "hub-initiated", hostKeyFingerprint: confirmed.fingerprint, tunnelPort: remotePort, apiKeyId: issued.id, createdAt: new Date(now()).toISOString(), remotePlatform };
      withConfigMutationLockSync(() => {
        const current = readStoreFor(ctx);
        if (current.links.some(link => link.alias === alias && link.direction === "hub-initiated")) throw new Error("link exists");
        writeStoreFor(ctx, { ...current, links: [...current.links, record!] });
      });
      await state.listener.ensureStarted();
      if (state.listener.status().state !== "listening") return await failed(fail("listener_unavailable", "The link listener is unavailable.", 503));
      await state.supervisor.ensureStarted();
      await state.supervisor.reload();
      phase = "remote_connect";
      input = new TextEncoder().encode(JSON.stringify({ apiKeyId: issued.id, key: issued.key }));
      remoteMayBeConnected = true;
      const connected = await runner.run(buildExecArgv({ alias, argv: ocx(["connect", "--link", "--key-stdin", "--tunnel-port", String(remotePort), "--link-id", id]), knownHostsFile: knownHosts }), { stdin: input, timeoutMs: budget });
      const connectDenied = remoteFailure(connected, "remote_connect_failed", "The Child enrollment command failed.");
      if (connectDenied) return await failed(connectDenied);
      input.fill(0);
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
        return Response.json({ linkId: id }, { status: 202 });
      } finally { unsubscribe(); }
    } catch (error) {
      return await failed(fail(phase + (error instanceof SshRunnerError && error.code === "timeout" ? "_timeout" : "_failed"), "Remote Link failed during " + phase.replaceAll("_", " ") + ".", 502, sshRunnerErrorHint(error)));
    } finally { input?.fill(0); rmSync(dir, { recursive: true, force: true }); }
  });
}
