import { SSH_MAX_OUTPUT_BYTES, boundHint, sshFailureHint } from "../../link/ssh-runner";

/**
 * Home enrollment reads one Child command before it may restart that Child: `ocx config show
 * --json`, for the effective `port`, `runtimeRole` and (ephemeral) `ephemeralChild` fields.
 *
 * There is no smaller command that answers on every Child this Home supports. Full `ocx` has
 * `config get <dot.path>` since 2.66.0, but resolving only fields that happen to be persisted
 * cannot tell an absent `runtimeRole` (standalone by default) from an unreadable one, and it
 * fails outright for an absent key. The lightweight `ocx-child` binary answers only `config show
 * --json`. A Child is therefore allowed the runner's maximum capture here: a saved configuration
 * of ordinary size stays well under it, and the 64 KiB default rejected a large-but-valid one
 * before preflight could read the two fields it needs (#8356).
 */
export const CHILD_PREFLIGHT_MAX_OUTPUT_BYTES = SSH_MAX_OUTPUT_BYTES;

export const CHILD_CONFIG_TOO_LARGE_MESSAGE = "The Child configuration is too large for the Remote Link preflight.";

/** The operator-facing hint for a Child whose config output exceeded even the raised cap. */
export const CHILD_CONFIG_TOO_LARGE_HINT =
  `ocx config show --json on the Child exceeded ${CHILD_PREFLIGHT_MAX_OUTPUT_BYTES} bytes; trim the Child's saved configuration and retry`;

/**
 * Why the Child's effective configuration could not be read (#8357): a failed `config show`
 * names its own last stderr line (bounded and redacted by `sshFailureHint`, e.g. an invalid
 * saved configuration), and a successful one that printed no usable JSON says so.
 */
export function childConfigFailureHint(result: { code: number; stderr: string }): string {
  if (result.code !== 0) return sshFailureHint(result.stderr) ?? `ocx config show --json exited ${result.code} on the Child`;
  return "ocx config show --json on the Child did not print a configuration with a valid port";
}

/** `ocx config validate --json` prints one small object; this bounds a misbehaving Child. */
export const CHILD_CONFIG_VALIDATE_MAX_OUTPUT_BYTES = 16 * 1024;

/**
 * The validation reason a full `ocx` Child gives for its own saved configuration, or undefined.
 *
 * `config show` on an invalid configuration prints only a generic warning whose path can push
 * the pointer past the 160-code-point hint cap, so it never names the defect (#8357). `config
 * validate --json` answers `{ "ok": false, "error": "schema_invalid: <field>: <rule>" }`, naming
 * fields and expected types, never configured values. Only that `error` string is read from
 * stdout, and `boundHint` still redacts and caps it. A Child without the command (`ocx-child`,
 * an older `ocx`) prints nothing usable and the caller keeps the `config show` reason.
 */
export function childConfigValidationHint(result: { code: number; stdout: string }): string | undefined {
  if (result.code === 0) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { return undefined; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { ok, error } = parsed as { ok?: unknown; error?: unknown };
  if (ok !== false || typeof error !== "string") return undefined;
  return boundHint(`Child config is invalid: ${error}`);
}

/**
 * The hint for an unreadable Child configuration: the Child's own validation reason when `config
 * show` failed and `config validate` can name it, otherwise `childConfigFailureHint`. The
 * extra command runs only on this failure path and is read-only on the Child.
 */
export async function childConfigFailureReason(
  configured: { code: number; stderr: string },
  validate: () => Promise<{ code: number; stdout: string }>,
): Promise<string> {
  if (configured.code !== 0) {
    try {
      const reason = childConfigValidationHint(await validate());
      if (reason) return reason;
    } catch {
      // A timeout or transport failure here must not mask the config show reason.
    }
  }
  return childConfigFailureHint(configured);
}
