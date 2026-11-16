import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { linkDir } from "./paths";

/**
 * How this Home keeps its Children current (050), in <configDir>/link/child-policy.json, never in config.json. Strict,
 * unlike the observation cache: an operator's opt-out lives here, so a damaged file must not read as the defaults.
 */
export const CHILD_POLICY_SCHEMA = "ocx.link.child-policy/1" as const;
export const CATALOG_FANOUT = ["auto", "manual"] as const;
export const CHILD_CODEX_RESTART = ["never", "app-server-when-idle"] as const;
export const CHILD_UPDATES = ["off", "notify", "auto-when-idle"] as const;
export const IDLE_AFTER_MIN_MS = 60_000;
export const IDLE_AFTER_MAX_MS = 3_600_000;

export interface ChildPolicy {
  catalogFanout: typeof CATALOG_FANOUT[number];
  childCodexRestart: typeof CHILD_CODEX_RESTART[number];
  updates: typeof CHILD_UPDATES[number];
  idleAfterMs: number;
}
export const DEFAULT_CHILD_POLICY: Readonly<ChildPolicy> = Object.freeze({
  catalogFanout: "auto", childCodexRestart: "never", updates: "auto-when-idle", idleAfterMs: 600_000,
});
/** Revision 4 (4529522051): what a damaged or unreadable file means. Nothing automatic runs until the operator saves. */
export const FAIL_CLOSED_CHILD_POLICY: Readonly<ChildPolicy> = Object.freeze({
  catalogFanout: "manual", childCodexRestart: "never", updates: "off", idleAfterMs: 600_000,
});
export type ChildPolicyWarning = "policy-file-invalid";
export interface ChildPolicyRead { policy: ChildPolicy; warning: ChildPolicyWarning | null }
const KEYS = ["schema", "catalogFanout", "childCodexRestart", "updates", "idleAfterMs"] as const;

export function childPolicyPath(configDir?: string): string {
  return join(linkDir(configDir), "child-policy.json");
}

/** Field-wise check shared by the file reader and PUT; returns null on any unknown key or invalid value. */
export function validPolicyPatch(value: Record<string, unknown>): Partial<ChildPolicy> | null {
  const out: Partial<ChildPolicy> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "catalogFanout" && (CATALOG_FANOUT as readonly unknown[]).includes(v)) out.catalogFanout = v as ChildPolicy["catalogFanout"];
    else if (key === "childCodexRestart" && (CHILD_CODEX_RESTART as readonly unknown[]).includes(v)) out.childCodexRestart = v as ChildPolicy["childCodexRestart"];
    else if (key === "updates" && (CHILD_UPDATES as readonly unknown[]).includes(v)) out.updates = v as ChildPolicy["updates"];
    else if (key === "idleAfterMs" && typeof v === "number" && Number.isSafeInteger(v) && v >= IDLE_AFTER_MIN_MS && v <= IDLE_AFTER_MAX_MS) out.idleAfterMs = v;
    else return null;
  }
  return out;
}

const failClosed = (): ChildPolicyRead => ({ policy: { ...FAIL_CLOSED_CHILD_POLICY }, warning: "policy-file-invalid" });

/**
 * Absent file ⇒ defaults, no warning. Unreadable, unknown key or bad value ⇒ FAIL_CLOSED_CHILD_POLICY plus a warning.
 * A damaged file is never rewritten here: the warning stays visible until the operator saves a policy.
 */
export function readChildPolicy(path = childPolicyPath()): ChildPolicyRead {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { policy: { ...DEFAULT_CHILD_POLICY }, warning: null } : failClosed();
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failClosed();
    const record = parsed as Record<string, unknown>;
    if (record.schema !== CHILD_POLICY_SCHEMA || Object.keys(record).some(key => !(KEYS as readonly string[]).includes(key))) return failClosed();
    const { schema: _schema, ...fields } = record;
    const patch = validPolicyPatch(fields);
    return patch ? { policy: { ...DEFAULT_CHILD_POLICY, ...patch }, warning: null } : failClosed();
  } catch { return failClosed(); }
}

/**
 * Read-merge-write under the config mutation lock; the file always holds every key. Same guard, directory mode and
 * Windows ACL hardening as updateChildObservations (child-observations.ts). Over an invalid file the patch merges onto
 * the fail-closed policy, so the operator chooses every automatic mode again.
 */
export function updateChildPolicy(patch: Partial<ChildPolicy>, path = childPolicyPath()): ChildPolicy {
  const dir = dirname(path), configDir = dirname(dir);
  assertNotRealHomeUnderTest(configDir);
  return withConfigMutationLockSync(() => {
    const next: ChildPolicy = { ...readChildPolicy(path).policy, ...patch };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") hardenSecretDir(dir, { required: true });
    else chmodSync(dir, 0o700);
    atomicWriteFile(path, `${JSON.stringify({ schema: CHILD_POLICY_SCHEMA, ...next }, null, 2)}\n`);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    return next;
  }, configDir);
}
