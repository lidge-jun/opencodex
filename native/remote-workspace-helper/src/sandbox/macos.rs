use crate::protocol::{CommandOutcome, HelperRequest};

const MACOS_CONFINEMENT_UNAVAILABLE: &str =
    "macOS Remote Workspace command confinement is unavailable; file tools remain enabled";

/// macOS has no unprivileged Job Object or cgroup equivalent that can revoke every descendant's
/// workspace access. A Seatbelt profile can constrain a process, but allowing subprocesses lets a
/// descendant call `setsid()` and outlive cancellation. Importing broad system profiles merely to
/// make a single-process probe start would also widen unrelated host-service authority. Until a
/// native containment owner closes both boundaries, command execution must stay unavailable.
pub fn probe() -> Result<(), String> {
    Err(MACOS_CONFINEMENT_UNAVAILABLE.to_owned())
}

/// Keep the helper itself fail-closed even if a caller bypasses OCX capability negotiation and
/// submits a `run` request directly.
pub fn run(_request: &HelperRequest) -> Result<CommandOutcome, String> {
    Err(MACOS_CONFINEMENT_UNAVAILABLE.to_owned())
}
