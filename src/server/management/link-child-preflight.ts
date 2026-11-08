import { SSH_MAX_OUTPUT_BYTES } from "../../link/ssh-runner";

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
