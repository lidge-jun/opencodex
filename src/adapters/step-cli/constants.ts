/** Adapter identity used in telemetry and in `providerConfig.adapter`. */
export const STEP_CLI_HOST = "step-cli";

/** Registry provider id. Kept separate from the adapter name so a future second adapter can coexist. */
export const STEP_CLI_PROVIDER_ID = "step-cli";

/** Namespace StepCode registers this proxy's declared tools under. */
export const STEP_CLI_TOOL_SERVER = "ocx";

/** `providerState` slot carrying the conversation handle between requests. */
export const STEP_CLI_CONTINUATION_KEY = "step";
