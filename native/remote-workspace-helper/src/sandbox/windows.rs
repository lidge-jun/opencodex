use crate::protocol::{CommandOutcome, HelperRequest};

const WINDOWS_CONFINEMENT_UNAVAILABLE: &str =
    "Windows Remote Workspace command confinement is unavailable; command execution is disabled";

// A command-capable implementation must retain cleanup ownership through helper cancellation
// and establish Job membership atomically. Until that owner is implemented and verified,
// direct helper requests and capability probes refuse before allocating OS resources.
pub fn probe() -> Result<(), String> {
    Err(WINDOWS_CONFINEMENT_UNAVAILABLE.to_owned())
}

pub fn run(_request: &HelperRequest) -> Result<CommandOutcome, String> {
    Err(WINDOWS_CONFINEMENT_UNAVAILABLE.to_owned())
}
