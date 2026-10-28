import { parseUpdateHomeProbe, UPDATE_PACKAGE_ONLY_PROTOCOL_VERSION } from "./service-home-policy.mjs";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const UPDATE_HOME_PROBE_ARGS = ["__update-home-probe"];

/** A trusted installed-file compatibility claim, not a tamper attestation.
 * Never execute an old launcher merely to ask whether it supports this protocol.
 * @param {string} launcher @param {(path: string) => string} [read] */
export function supportsUpdateHomeProbe(launcher, read = path => {
  if (statSync(path).size > 4096) throw new Error("oversized declaration");
  return readFileSync(path, "utf8");
}) {
  try {
    const value = JSON.parse(read(join(dirname(launcher), "..", "src", "update", "service-home-protocol.json")));
    return value?.schemaVersion === 1 && value?.launcherProtocolVersion === 1
      && value?.entry === "__update-home-probe" && Object.keys(value).length === 3;
  } catch { return false; }
}

/** Preserve user/home/auth inputs; remove only internal launch/service/delegation tokens.
 * @param {Record<string, string | undefined>} env
 * @param {{ codexHome: string, opencodexHome: string }} homes */
export function updateHomeProbeEnvironment(env, homes) {
  const clean = { ...env, CODEX_HOME: homes.codexHome, OPENCODEX_HOME: homes.opencodexHome };
  for (const key of ["OCX_NODE_LAUNCH_CONTEXT", "OCX_PRE_BUN_ANTHROPIC_ENV", "OCX_SERVICE", "OCX_SERVICE_MANAGED",
    "OCX_UPDATE_RESTART_CHILD", "OCX_OWNERSHIP_MUTATION_LEASE_TOKEN", "OCX_SIBLING_OF_PORT", "OCX_SIBLING_HANDOFF_NONCE",
    "OCX_BUN_RUNTIME_SOURCE", "OCX_BUN_RUNTIME_PATH"]) delete clean[key];
  return clean;
}

/** @param {string} launcher @param {Parameters<typeof probeUpdateServiceHome>[0]} run
 * @param {string} node @param {Record<string, string | undefined>} env
 * @param {(path: string) => string} [read] */
export function probeUpdateLauncherHome(launcher, run, node, env, read) {
  if (!supportsUpdateHomeProbe(launcher, read)) return { kind: "unknown" };
  return probeUpdateServiceHome(run, node, [launcher], { requireLauncher: true, env });
}

/** A narrow local subprocess protocol. It never falls back to ordinary status.
 * @param {(bin: string, args: string[], options: object) => { status: number | null, stdout?: unknown, error?: unknown, signal?: unknown }} run
 * @param {string} bin @param {string[]} prefix
 * @param {{ requireLauncher?: boolean, env?: Record<string, string | undefined> }} [options]
 * @returns {import('./service-home-policy.mjs').UpdateServiceHomeAuthority} */
export function probeUpdateServiceHome(run, bin, prefix, { requireLauncher = false, env } = {}) {
  try {
    const result = run(bin, [...prefix, ...UPDATE_HOME_PROBE_ARGS], {
      encoding: "utf8", timeout: 8_000, maxBuffer: 4096, windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"], ...(env ? { env } : {}),
    });
    if (result.status !== 0 || result.error || result.signal || typeof result.stdout !== "string"
      || Buffer.byteLength(result.stdout, "utf8") > 4096) return { kind: "unknown" };
    return parseUpdateHomeProbe(JSON.parse(result.stdout), { requireLauncher });
  } catch { return { kind: "unknown" }; }
}

/** Separate capability: keep the original home-probe declaration readable by running v1 updaters.
 * @param {string} launcher @param {Parameters<typeof probeUpdateServiceHome>[0]} run
 * @param {string} node @param {Record<string, string | undefined>} env
 * @param {(path: string) => string} [read] */
export function probeUpdatePackageOnlyLauncher(launcher, run, node, env, read = path => {
  if (statSync(path).size > 4096) throw new Error("oversized declaration");
  return readFileSync(path, "utf8");
}) {
  if (!supportsUpdateHomeProbe(launcher, read)) return false;
  try {
    const declaration = JSON.parse(read(join(dirname(launcher), "..", "src", "update", "service-home-package-only-protocol.json")));
    if (declaration?.schemaVersion !== 1 || declaration?.packageOnlyProtocolVersion !== UPDATE_PACKAGE_ONLY_PROTOCOL_VERSION
      || declaration?.entry !== "__update-package-only-probe" || Object.keys(declaration).length !== 3) return false;
    const result = run(node, [launcher, "__update-package-only-probe"], {
      encoding: "utf8", timeout: 8_000, maxBuffer: 4096, windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"], env,
    });
    if (result.status !== 0 || result.error || result.signal || typeof result.stdout !== "string"
      || Buffer.byteLength(result.stdout, "utf8") > 4096) return false;
    const response = JSON.parse(result.stdout);
    return response?.schemaVersion === 1 && response?.packageOnlyProtocolVersion === UPDATE_PACKAGE_ONLY_PROTOCOL_VERSION && Object.keys(response).length === 2;
  } catch { return false; }
}
