import { createInterface } from "node:readline/promises";
import { assertSshAlias } from "../link/ssh-argv";
import { windowsChildRefusal } from "../link/remote-platform";
import { CliUsageError, RuntimeApiError, runtimeBaseUrl, rejectArgs, takeJsonFlag, takeOption, printData } from "./runtime-api";
import type { LinkCliDeps } from "./link";

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{16,88}={0,2}$/;
const ENROLLMENT_DEADLINE_MS = 360_000;
const PHASES: Record<string, string> = {
  remote_port_failed: "remote port selection", remote_port_timeout: "remote port selection",
  child_preflight_failed: "Child preflight", child_preflight_timeout: "Child preflight",
  child_restart_unsupported: "Child restart preflight", child_curl_missing: "Child curl preflight",
  home_setup_failed: "Home setup", home_setup_timeout: "Home setup",
  remote_connect_failed: "Child enrollment", remote_connect_timeout: "Child enrollment",
  child_restart_failed: "Child restart", child_restart_timeout: "Child restart",
  child_relay_failed: "Child relay verification", child_relay_timeout: "Child relay verification",
  child_runtime_not_client: "Child runtime role verification",
  remote_platform_unsupported: "remote platform verification", remote_ocx_missing: "remote OpenCodex discovery",
};
const RECOVERY = "Run ocx disconnect and ocx restart on the Child before retrying.";
type LinkRequest = <T>(path: string, init: RequestInit, deps: LinkCliDeps) => Promise<T>;

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function offered(value: unknown): { alias: string; fingerprint: string; keyType: string; ocxVersion: string } {
  if (!record(value) || Object.keys(value).sort().join(",") !== "alias,fingerprint,keyType,ocxVersion"
    || typeof value.alias !== "string" || typeof value.fingerprint !== "string" || !FINGERPRINT.test(value.fingerprint)
    || typeof value.keyType !== "string" || !/^[A-Za-z0-9@._+-]{1,64}$/.test(value.keyType)) throw new Error("Invalid host probe response");
  if (typeof value.ocxVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,128})?$/.test(value.ocxVersion)) throw new Error("Invalid host version response");
  return { alias: value.alias, fingerprint: value.fingerprint, keyType: value.keyType, ocxVersion: value.ocxVersion };
}

export async function runLinkEnrollment(command: "probe" | "add", args: string[], deps: LinkCliDeps, request: LinkRequest, usage: string): Promise<void> {
  const wantsJson = takeJsonFlag(args);
  const expected = takeOption(args, "--expect-fingerprint");
  const alias = args.shift();
  if (!alias) throw new CliUsageError(command + " requires an SSH alias", usage);
  try { assertSshAlias(alias); } catch { throw new CliUsageError("Invalid SSH alias", usage); }
  rejectArgs(args, usage);
  if (command === "probe" && expected !== undefined) throw new CliUsageError("--expect-fingerprint is only for link add", usage);
  if (expected !== undefined && !FINGERPRINT.test(expected)) throw new CliUsageError("Expected a SHA256 SSH fingerprint", usage);
  if (command === "add" && !expected && !(deps.stdinImpl ?? process.stdin).isTTY) {
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
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    controller.signal.throwIfAborted();
    const result = await request<T>(path, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, boundDeps);
    controller.signal.throwIfAborted();
    return result;
  };
  let rl: ReturnType<typeof createInterface> | undefined;
  const work = async () => {
    boundDeps = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    controller.signal.throwIfAborted();
    const probe = offered(await post<unknown>("/api/link/probe", { alias, includeVersion: true }));
    if (probe.alias !== alias) throw new Error("Host probe alias did not match");
    if (command === "probe") { printData(probe, wantsJson, [probe.alias + " " + probe.keyType + " " + probe.fingerprint + " opencodex " + probe.ocxVersion]); return; }
    if (expected && expected !== probe.fingerprint) throw new CliUsageError("The offered host fingerprint does not match --expect-fingerprint");
    if (!expected) {
      let approved: boolean;
      if (deps.confirmFingerprint) approved = await deps.confirmFingerprint(probe);
      else {
        rl = createInterface({ input: deps.stdinImpl ?? process.stdin, output: process.stderr });
        approved = (await rl.question("Confirm " + alias + " " + probe.keyType + " " + probe.fingerprint + " opencodex " + probe.ocxVersion + " (type yes): ", { signal: controller.signal })).trim() === "yes";
      }
      controller.signal.throwIfAborted();
      if (!approved) throw new CliUsageError("Host fingerprint was not confirmed");
    }
    const confirm = await post<unknown>("/api/link/confirm-host", { alias, fingerprint: probe.fingerprint });
    if (!record(confirm) || Object.keys(confirm).sort().join(",") !== "alias,fingerprint,ocxVersion" || confirm.alias !== alias || confirm.fingerprint !== probe.fingerprint
      || typeof confirm.ocxVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,128})?$/.test(confirm.ocxVersion)) throw new Error("Invalid host confirmation response");
    const result = await post<unknown>("/api/link/apply", { alias, fingerprint: probe.fingerprint });
    if (!record(result) || Object.keys(result).join(",") !== "linkId" || typeof result.linkId !== "string" || !/^lnk_[0-9a-f]{16}$/.test(result.linkId)) throw new Error("Invalid link apply response");
    printData({ linkId: result.linkId, alias, state: "connected", childRole: "client" }, wantsJson, ["Connected " + alias + " as a Child (" + result.linkId + ")."]);
  };
  try { await Promise.race([work(), expiry]); }
  catch (error) {
    if (error instanceof RuntimeApiError && record(error.body)) {
      const code = record(error.body.error) ? error.body.error.code : undefined;
      // Refused at probe or confirm, before any key or tunnel: point at Hub mode, not at a phase.
      // A residual response comes after key issuance; it keeps its Child recovery below.
      if (code === "remote_platform_unsupported" && error.body.residual !== true) throw new Error(windowsChildRefusal(alias));
      const phase = typeof code === "string" && Object.hasOwn(PHASES, code) ? PHASES[code] : undefined;
      const message = phase ? "Remote Link failed during " + phase : error.message;
      if (phase || error.body.residual === true) throw new Error(message + (error.body.residual === true ? ". " + RECOVERY : ""));
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    rl?.close();
  }
}
