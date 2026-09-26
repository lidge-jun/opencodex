/**
 * What `ocx` can do, as data an agent can read without parsing help text.
 *
 * This is the machine-readable index behind `ocx capabilities`. It relates each CLI
 * capability to the management route(s) it drives, which nothing in this repository did
 * before: help lived in twenty per-module `USAGE` constants and a hand-written banner
 * that a test explicitly licensed to drift from the command registry.
 *
 * LEAF MODULE. It imports nothing from `src/cli/`, and nothing here may import a command
 * module. That is not tidiness. Each command module declares its usage text as a
 * top-level `const USAGE`, evaluated at import time, so a cycle back into this table
 * would resolve to `undefined` under ESM rather than throwing -- silently emptying the
 * usage text that `rejectArgs` hands to `CliUsageError`, in the exact error-reporting
 * surface the CLI-operability issues are about. `tests/cli/cli-capabilities.test.ts` asserts
 * the absence of those imports and that every rendered usage string is non-empty, so the
 * failure mode is loud instead of degraded.
 *
 * Head-handled surfaces (`--version`, `help`) are declared separately in
 * `HEAD_CAPABILITIES`. They exit in the CLI head (`root.ts`) before dispatch and have no
 * runner key, so listing them as ordinary capabilities would break the registry parity
 * assertion that every canonical entry is a direct runner. `help` is excluded from
 * `CLI_COMMANDS` deliberately -- `tests/cli/cli-registry.test.ts` documents it as a
 * head-handled pseudo-case -- and that decision is preserved here rather than reversed.
 */

/** A management route a capability drives. Path text only; never a handler reference. */
export interface CapabilityRoute {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
}

export interface CapabilityFlag {
  readonly name: string;
  readonly value?: "string" | "number" | "boolean";
  readonly required?: boolean;
  readonly summary: string;
}

/**
 * How a capability emits JSON.
 *
 * - `payload`: the API payload, largely unwrapped.
 * - `envelope`: a CLI-shaped object with its own schema.
 * - `none`: no `--json` mode.
 */
export type CapabilityJsonMode = "payload" | "envelope" | "none";

export interface Capability {
  /** Command path, e.g. `["account", "pause"]`. */
  readonly command: readonly string[];
  readonly summary: string;
  readonly routes: readonly CapabilityRoute[];
  readonly flags: readonly CapabilityFlag[];
  readonly mutates: boolean;
  readonly json: CapabilityJsonMode;
  readonly details?: readonly string[];
  /**
   * Extra banner rows this capability owns, for surfaces the banner shows separately
   * from the bare command (`ocx restore back`, `ocx doctor --reclaim-response-temps`).
   * Without this the banner cannot equal the capability set: it legitimately carries more
   * rows than there are commands.
   */
  readonly bannerLines?: readonly string[];
}

/**
 * Surfaces resolved in the CLI head, before dispatch.
 *
 * They belong in `ocx capabilities` output and in the banner, but not in `CLI_COMMANDS`:
 * `--version`, `-v`, and `version` are answered at `root.ts` and exit, so none of them is
 * a runner key to parity-check against.
 */
export interface HeadCapability {
  readonly invocations: readonly string[];
  readonly summary: string;
  readonly bannerLine: string;
}

export const HEAD_CAPABILITIES: readonly HeadCapability[] = [
  {
    invocations: ["--version", "-v", "version"],
    summary: "Print the CLI version and exit.",
    bannerLine: "ocx --version | -v          Print version",
  },
  {
    invocations: ["help", "--help", "-h"],
    summary: "Print the command list, or one command's usage with `ocx help <command>`.",
    bannerLine: "ocx help [command]          Show help for a command",
  },
];

/**
 * Capabilities declared so far. Incomplete by design: later phases add verbs.
 * `ocx capabilities` is the index of what is listed here, not of every CLI command.
 * A capability must not name a route the command does not actually fetch.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    command: ["link", "port"],
    summary: "Allocate a free loopback port for a remote home link.",
    routes: [],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the selected port as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["link", "issue"],
    summary: "Issue one link credential and record its tunnel metadata.",
    routes: [{ method: "POST", path: "/api/link/issue" }],
    flags: [
      { name: "--alias", value: "string", required: true, summary: "SSH host alias for the linked machine." },
      { name: "--tunnel-port", value: "number", required: true, summary: "Remote loopback port for the reverse tunnel." },
      { name: "--json", value: "boolean", summary: "Emit the issue result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: ["Requires the running proxy's admin token on loopback; the one-time data key is printed only on stdout."],
  },
  {
    command: ["link", "status"],
    summary: "Read link listener and tunnel status.",
    routes: [{ method: "GET", path: "/api/link/status" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the K16 status payload as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["link", "revoke"],
    summary: "Revoke a link credential and remove its link record.",
    routes: [{ method: "DELETE", path: "/api/link/{id}" }],
    flags: [
      { name: "--link-id", value: "string", required: true, summary: "Link id to revoke." },
      { name: "--json", value: "boolean", summary: "Emit the revoked link id as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: ["Requires the running proxy's admin token on loopback."],
  },
  {
    "command": [
      "remote-workspace",
      "pair"
    ],
    "summary": "Enroll this executor with one Hub using a one-time code from stdin and locally approved roots.",
    "routes": [],
    "flags": [
      {
        "name": "--json",
        "value": "boolean",
        "summary": "Emit the public local executor status."
      },
      {
        "name": "--pairing-code-stdin",
        "value": "boolean",
        "summary": "Read the one-time pairing code from stdin."
      },
      {
        "name": "--root",
        "value": "string",
        "summary": "Approve an absolute workspace directory; repeatable."
      },
      {
        "name": "--toolchain-root",
        "value": "string",
        "summary": "Approve a read-only toolchain directory; repeatable."
      },
      {
        "name": "--executor-helper",
        "value": "string",
        "summary": "Select a reviewed native helper file."
      },
      {
        "name": "--name",
        "value": "string",
        "summary": "Name this executor."
      }
    ],
    "mutates": true,
    "json": "payload",
    "details": [
      "Executor-local operation; Hub consent and session control stay in the dashboard."
    ]
  },
  {
    "command": [
      "remote-workspace",
      "agent"
    ],
    "summary": "Keep the paired executor connected to its Hub.",
    "routes": [],
    "flags": [],
    "mutates": true,
    "json": "none",
    "details": [
      "Executor-local operation; Hub consent and session control stay in the dashboard."
    ]
  },
  {
    "command": [
      "remote-workspace",
      "status"
    ],
    "summary": "Read local executor enrollment and available capabilities without printing credentials.",
    "routes": [],
    "flags": [
      {
        "name": "--json",
        "value": "boolean",
        "summary": "Emit the public local executor status."
      }
    ],
    "mutates": false,
    "json": "payload",
    "details": [
      "Executor-local operation; Hub consent and session control stay in the dashboard."
    ]
  },
  {
    command: ["models", "price"],
    summary: "Read the saved manual price for an exact provider/model selector.",
    routes: [{ method: "GET", path: "/api/providers/{provider}/model-costs" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit provider, modelId, and cost (null for automatic pricing)." }],
    mutates: false,
    json: "envelope",
    details: ["The provider must be configured; everything after the first slash is the exact upstream model ID."],
  },
  {
    command: ["models", "set-price"],
    summary: "Save four manual USD-per-1M-token rates, or restore automatic pricing for one model.",
    routes: [{ method: "PUT", path: "/api/providers/{provider}/model-costs" }],
    flags: [
      { name: "--input", value: "number", summary: "Input rate; required unless --auto is used." },
      { name: "--output", value: "number", summary: "Output rate; required unless --auto is used." },
      { name: "--cache-read", value: "number", summary: "Cache read rate; defaults to 0." },
      { name: "--cache-write", value: "number", summary: "Cache write rate; defaults to 0." },
      { name: "--auto", value: "boolean", summary: "Remove this model's override; cannot be combined with rates." },
      { name: "--json", value: "boolean", summary: "Emit the saved price or reset result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: ["Uses the exact upstream model ID after the first slash. Omitted cache rates default to zero; sibling model prices are preserved."],
  },
  {
    command: ["status"],
    summary: "Proxy status, injection state, and version skew between this CLI and the running proxy.",
    // No management route: `collectStatus` identity-probes `/healthz` through
    // `findLiveProxy` and reads local config. Declaring `GET /api/status` here was wrong
    // -- that route does not exist, and the registry cross-check caught it.
    routes: [],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the status envelope as JSON." }],
    mutates: false,
    json: "envelope",
    details: ["Reads /healthz plus local config; drives no management API route."],
  },
  {
    command: ["resolve"],
    summary: "One JSON document naming the config home, the effective port, and the identity-checked proxy liveness verdict.",
    // No management route, same split as status: discovery is the identity-checked
    // /healthz probe inside findLiveProxy plus local config and the home from
    // src/config/paths.ts.
    routes: [],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the resolve document as JSON (the shell contract)." }],
    mutates: false,
    json: "envelope",
    details: [
      "Exit 0 carries a trustworthy verdict (live or proven absent); exit 1 means the CLI could not resolve and a caller must refuse to guess — unknown liveness never reads as absent.",
      "Built for embedding shells (desktop app): the liveness budgets stay owned by src/server/proxy-liveness.ts.",
    ],
  },
  {
    command: ["hub", "invite"],
    summary: "Mint a single-use pairing code on a hub and print the exact `ocx connect` line for one more machine.",
    // Deliberately empty. The command DOES drive `POST /api/gui/pairing-grants` -- the attested
    // local mint route `ocx gui pair` uses, authorized by a capability HMAC'd with the running
    // proxy's own attestation secret rather than by the admin token, which is why it needs
    // nothing exported in the shell. That route is answered in the composition root, ahead of
    // `handleManagementAPI`, so it is not in MANAGEMENT_ROUTES; declaring it here would fail the
    // capability/registry reconciliation rather than inform anyone. Widening the registry's scope
    // to `src/server/index.ts` is its own change.
    routes: [],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit code, expiresAt, dataUrl, managementUrl, and command." },
      { name: "--data-url", value: "string", summary: "Advertise this data origin instead of hub.dataPublicOrigin or the bind address." },
      { name: "--management-url", value: "string", summary: "Confirm the management origin; it must equal hub.managementPublicOrigin." },
      { name: "--clients", value: "string", summary: "Pre-select codex and/or claude in the printed connect command." },
    ],
    mutates: true,
    json: "envelope",
    details: [
      "Hub only: refuses when runtimeRole is not hub, and requires a running attested proxy.",
      "The code is secret, single-use and short-lived; it is bound to hub.managementPublicOrigin and to the connecting machine's loopback browser origin.",
      "The bound browser origin is always printed; when it is not http://localhost:10100 the warning names the port the connecting machine must use.",
      "Refuses when the advertised data origin would be loopback (a loopback or wildcard bind with no hub.dataPublicOrigin and no --data-url) rather than printing a line that dials the other machine itself.",
      "Prints no data-plane token. Remote machines receive their own revocable per-client key from the exchange.",
      "Mints through the attested local pairing-grant route, the same one ocx gui pair uses; no admin token is read.",
    ],
  },
  {
    command: ["connect", "rotate"],
    summary: "Rotate the connected client's data key against the hub, with commit and abort.",
    // One command drives all three: start returns the new secret once, commit promotes it,
    // and abort unwinds a rotation that could not be confirmed. They are not separate verbs
    // because a half-rotation is not a state an operator should be able to leave behind.
    routes: [
      { method: "POST", path: "/api/keys/rotate" },
      { method: "POST", path: "/api/keys/rotate/commit" },
      { method: "DELETE", path: "/api/keys/rotate" },
    ],
    flags: [
      { name: "--pairing-code-stdin", value: "boolean", summary: "Read a one-time pairing code from stdin as the rotation authority." },
      { name: "--admin-token-stdin", value: "boolean", summary: "Read the hub admin token from stdin as the rotation authority." },
      { name: "--json", value: "boolean", summary: "Emit the rotation result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "Requires transient authority on stdin; the credential is never persisted or echoed.",
      "A rotation left pending by a crash is resumed here — startup and status stop rather than guess which key generation is live.",
    ],
  },
  {
    command: ["capabilities"],
    summary: "List the declared CLI capabilities and the management routes they drive.",
    routes: [],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit the full capability table as JSON." },
      { name: "--mutating-only", value: "boolean", summary: "Restrict output to capabilities that mutate state." },
      { name: "--route", value: "string", summary: "Show which capabilities drive a management route." },
    ],
    mutates: false,
    json: "envelope",
    details: ["Start here when driving ocx programmatically: it is the declared surface index, not a complete verb list."],
  },
  {
    command: ["provider", "list"],
    summary: "Configured providers with connectivity and selected models.",
    // Local config + PROVIDER_REGISTRY. Does not call GET /api/providers.
    routes: [],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit the provider list as JSON." },
      { name: "--jsonl", value: "boolean", summary: "Emit one configured provider per JSON line." },
    ],
    mutates: false,
    json: "envelope",
    details: ["Reads local config; drives no management API route."],
  },
  {
    command: ["provider", "resets"],
    summary: "Recently detected quota resets and whether reset notifications are enabled.",
    routes: [{ method: "GET", path: "/api/quota-resets" }],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit reset events as JSON." },
      { name: "--limit", value: "number", summary: "Limit returned events; defaults to 20, capped at 100." },
    ],
    mutates: false,
    json: "payload",
  },
  {
    command: ["provider", "keychain"],
    summary: "Move a provider's API key into the OS keychain, restore it, or report where it lives.",
    routes: [
      { method: "GET", path: "/api/providers/keychain" },
      { method: "POST", path: "/api/providers/keychain" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the keychain status or result as JSON." }],
    mutates: true,
    json: "payload",
    details: [
      "`store` verifies every keychain write by read-back before config.json is rewritten with keychain: references; an unavailable keychain refuses with 503 and leaves the file untouched.",
      "Headless services usually have no unlocked keychain session; prefer ${ENV_VAR} references there.",
    ],
  },
  {
    command: ["companion"],
    summary: "Inspect and configure menu-bar and widget companion usage settings.",
    routes: [
      { method: "GET", path: "/api/companion/settings" },
      { method: "GET", path: "/api/usage/timeline" },
      { method: "PUT", path: "/api/companion/settings" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit companion settings as JSON." }],
    mutates: true,
    json: "payload",
    details: [
      "`show` (the default) reads settings; `set key=value ...` updates selected settings; `reset` restores defaults.",
      "Values accepted by `set` are parsed as JSON when valid, so booleans, numbers, arrays, objects, and null can be passed directly.",
    ],
  },
  {
    command: ["account", "history"],
    summary: "Cached quota observations for one stored Codex pool account.",
    routes: [{ method: "GET", path: "/api/codex-auth/quota/history" }],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit the bounded observation history." },
      { name: "--limit", value: "number", summary: "Return the newest 1 to 200 observations." },
    ],
    mutates: false,
    json: "payload",
    details: ["Use account history openai <pool-account-id>. Reads cached observations only; no refresh or warmup. Native main is not included."],
  },
  {
    command: ["account", "main", "reauth"],
    summary: "Reauthenticate the native main Codex login with a device code (#3898); headless hubs need no Codex App or keyring.",
    routes: [
      { method: "POST", path: "/api/codex-auth/main/reauth-device" },
      { method: "GET", path: "/api/codex-auth/main/reauth-device" },
      { method: "DELETE", path: "/api/codex-auth/main/reauth-device" },
    ],
    flags: [
      { name: "--device", value: "boolean", summary: "Run the device-code flow (the only reauth mode)." },
      { name: "--no-wait", value: "boolean", summary: "Print the flow handle and code without waiting for completion." },
      { name: "--flow", value: "string", summary: "Flow id for status and cancel." },
      { name: "--json", value: "boolean", summary: "Emit the flow status as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "Same-identity reauth only: the device login must complete for the ChatGPT account that already holds the native main slot, and the commit is fenced by the exclusive claim plus a path/hash/inode snapshot.",
      "/api/codex-auth/login stays pool-only and keeps rejecting __main__; this namespace is the only device-reauth surface for the native main slot.",
      "Payloads carry only flowId, status, the verification URL, the device code, and a closed set of failure codes -- never tokens, emails, or raw account ids.",
    ],
  },
  {
    command: ["account", "list"],
    summary: "Codex OAuth accounts with pool priority and pause state.",
    routes: [{ method: "GET", path: "/api/codex-auth/accounts" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the account list as JSON." }],
    mutates: false,
    json: "payload",
    details: [
      "STATUS names `paused` alongside `selected`: a paused-but-selected account still receives requests.",
      "`--quota` shows cached Codex windows (including 5h); `--refresh` bypasses the server TTL.",
    ],
  },
  {
    command: ["account", "import-orca"],
    summary: "Preview or register read-only links to Orca-managed Codex accounts without another login.",
    routes: [],
    flags: [
      { name: "--source", value: "string", required: true, summary: "Orca data directory containing codex-accounts." },
      { name: "--registry", value: "string", required: true, summary: "The chosen Orca profile's orca-data.json account registry." },
      { name: "--apply", value: "boolean", summary: "Register new accounts; requires a stopped proxy. Default is preview." },
      { name: "--json", value: "boolean", summary: "Emit counts and fixed invalid-reason codes without credentials or source paths." },
    ],
    mutates: true,
    json: "envelope",
    details: [
      "Local files only; never copies refresh tokens or changes Orca authentication files.",
      "Skips existing ChatGPT identities. New accounts remain pending until dashboard validation.",
      "Orca must keep the source login available and refreshed; a missing or expired source fails closed.",
      "Mixed eligible and invalid entries exit successfully; an all-invalid result exits nonzero.",
    ],
  },
  {
    command: ["account", "refresh"],
    summary: "Refresh account quotas without model validation; pending Codex accounts require dashboard consent.",
    routes: [
      { method: "POST", path: "/api/codex-auth/accounts/refresh" },
      { method: "GET", path: "/api/provider-quotas" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the refresh result as JSON." }],
    mutates: true,
    json: "payload",
    details: ["CLI/admin-token refreshes only observe usage. After quota recovery, a human must click Refresh quotas in the dashboard to authorize model validation. Do not mint a GUI session to work around this consent boundary."],
  },
  {
    command: ["account", "grok-reset-coupons"],
    summary: "Inspect or redeem Grok billing reset coupons; redemption is journaled and idempotent.",
    routes: [
      { method: "GET", path: "/api/grok/reset-coupons" },
      { method: "POST", path: "/api/grok/reset-coupons/consume" },
    ],
    flags: [
      { name: "--consume", value: "boolean", summary: "Redeem one reset coupon; requires --yes." },
      { name: "--yes", value: "boolean", summary: "Explicit confirmation required by --consume." },
      { name: "--token-id", value: "string", summary: "Redeem a specific reset token instead of the default selection." },
      { name: "--operation-id", value: "string", summary: "UUIDv4 making a redemption idempotent: retries replay the journaled outcome." },
      { name: "--json", value: "boolean", summary: "Emit the coupon list or redemption result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "Without --consume this is a read: remaining coupons and their validity windows.",
      "The operation is journaled before the upstream call, so retrying the same --operation-id replays the recorded outcome instead of spending a second coupon.",
    ],
  },
  {
    command: ["usage"],
    summary: "Token and estimated-cost report over a time range.",
    routes: [{ method: "GET", path: "/api/usage" }],
    flags: [
      { name: "--range", value: "string", summary: "today | 1d | 7d | 30d | all" },
      { name: "--since", value: "string", summary: "Inclusive start: epoch milliseconds or full ISO datetime with timezone; requires --until and overrides --range." },
      { name: "--until", value: "string", summary: "Inclusive end: epoch milliseconds or full ISO datetime with timezone; requires --since." },
      { name: "--provider", value: "string", summary: "Restrict to one provider." },
      { name: "--model", value: "string", summary: "Restrict to one model id." },
      { name: "--json", value: "boolean", summary: "Emit the usage report as JSON." },
    ],
    mutates: false,
    json: "payload",
    details: [
      "Per-account totals are withheld under `--provider` or `--model`: account rows cannot be honestly re-partitioned by provider, so the report says so rather than printing an empty table.",
      "An `(ambiguous)` account row aggregates several accounts; do not read it as one identity.",
    ],
  },
  {
    command: ["account", "pause"],
    summary: "Stop routing new requests to one account in the Codex pool.",
    // One route, both directions: `resume` is the same PUT with `paused: false`.
    routes: [{ method: "PUT", path: "/api/codex-auth/accounts/pause" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the pause result as JSON." }],
    mutates: true,
    json: "envelope",
    details: [
      "Pausing also unbinds threads pinned to the account and selects a fallback if it was active -- side effects of the route, not of the word `pause`.",
      "The issue that requested this reported the route as POST; it is PUT.",
    ],
  },
  {
    command: ["account", "resume"],
    summary: "Return a paused account to the Codex pool.",
    routes: [{ method: "PUT", path: "/api/codex-auth/accounts/pause" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the resume result as JSON." }],
    mutates: true,
    json: "envelope",
  },
  {
    command: ["account", "pause-exhausted"],
    summary: "Pause every Codex account whose quota is spent.",
    routes: [{ method: "PUT", path: "/api/codex-auth/accounts/pause-exhausted" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit paused ids and the checked/failed counts as JSON." }],
    mutates: true,
    json: "envelope",
    details: [
      "The route refreshes quota per account and can partially fail; a non-zero failed count exits 1 and sets ok:false, because silence would read as `none were exhausted`.",
    ],
  },
  {
    command: ["account", "strategy"],
    summary: "Show or set how an account pool picks the next account.",
    // Both pools, because both have the setting. The Codex pool reads its applied values
    // from the active payload; the Anthropic pool has its own GET.
    routes: [
      { method: "GET", path: "/api/pool/settings" },
      { method: "PUT", path: "/api/pool/settings" },
      { method: "PATCH", path: "/api/pool/settings" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the applied strategy and sticky limit as JSON." }],
    mutates: true,
    json: "envelope",
    details: [
      "A bare invocation reads and never writes.",
      "The APPLIED value is echoed, not the requested one, so a server-side normalization stays visible.",
      "Values are not re-validated in the CLI: the server owns the strategy names and the 1-100 sticky bound.",
      "One route answers for every pool kind and declares which fields that kind honours in `supported`, so an unsupported field is a stated null rather than an absence. `anthropic` alone carries `quotaWindow`. Generic-provider settings steer selection only while `pool.kernel` is on. The legacy per-pool paths still work and are unchanged.",
    ],
  },
  {
    command: ["account", "sticky"],
    summary: "Show or set how many consecutive requests stay on one account.",
    routes: [
      { method: "GET", path: "/api/pool/settings" },
      { method: "PUT", path: "/api/pool/settings" },
      { method: "PATCH", path: "/api/pool/settings" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the applied strategy and sticky limit as JSON." }],
    mutates: true,
    json: "envelope",
    details: ["Only meaningful under the sticky-capable strategies; the pool strategy is the other half of this setting."],
  },
  {
    command: ["account", "auto-switch"],
    summary: "Show or set the usage percentage at which a pool moves to another account.",
    // Declared here rather than riding on `account strategy`, which is what it did before the
    // unified route existed. `auto-switch` genuinely drives these three: the Codex pool reads
    // its applied threshold from the active payload and writes through its own route, and a
    // generic OAuth pool reads and writes the per-provider pool settings.
    routes: [
      { method: "GET", path: "/api/codex-auth/active" },
      { method: "PUT", path: "/api/codex-auth/auto-switch" },
      { method: "GET", path: "/api/oauth/accounts/pool" },
      { method: "PUT", path: "/api/oauth/accounts/pool" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the stored threshold and whether it is applied." }],
    mutates: true,
    json: "envelope",
    details: [
      "A bare invocation reads and never writes.",
      "`on` stores 80%, `off` stores 0%, and `threshold <n>` accepts 0-100.",
      "For a generic OAuth pool, `inert: true` means the threshold is stored but not applied, `inert: false` means the pool is applying it, and an absent `inert` is an unknown capability.",
    ],
  },

  {
    command: ["logs"],
    summary: "Recent request log rows, filterable by provider, model, conversation, account, and status.",
    routes: [{ method: "GET", path: "/api/logs" }],
    flags: [
      { name: "--provider", value: "string", summary: "Restrict to one provider, matching failover attempts too." },
      { name: "--model", value: "string", summary: "Restrict to one model id, matching failover attempts too." },
      { name: "--conversation", value: "string", summary: "Restrict to one conversation id (`--conversationId` is accepted too)." },
      { name: "--account", value: "string", summary: "Restrict to one account log label (`main`, `p<hex6>`, `o<hex6>`), matching failover attempts too." },
      { name: "--status", value: "string", summary: "An exact code (429) or a class (5xx)." },
      { name: "--limit", value: "number", summary: "Row cap; defaults to 200." },
      { name: "--follow", value: "boolean", summary: "Poll for new rows; add --jsonl to emit JSONL." },
      { name: "--json", value: "boolean", summary: "Emit the server payload as JSON." },
      { name: "--jsonl", value: "boolean", summary: "Emit one row per line." },
    ],
    mutates: false,
    json: "payload",
    details: [
      "`--provider` and `--model` both match a failover attempt, so a request is findable by what actually served it, not only by what was asked for.",
      "Rows print `conv=<id>` when the entry carries one, so a conversation filter can be told apart from an empty result.",
      "Rows print `acct=<label>` when the account is known, so an `--account` filter can be told apart from an empty result.",
      "`--follow` deduplicates by row id and cannot be combined with `--json`.",
    ],
  },
  {
    command: ["storage", "report"],
    summary: "Disk usage under CODEX_HOME, with the log-guard protection report.",
    routes: [{ method: "GET", path: "/api/storage" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the storage report as JSON." }],
    mutates: false,
    json: "payload",
    bannerLines: ["ocx storage                 Storage report (default subcommand)"],
  },
  {
    command: ["storage", "cleanup"],
    summary: "Preview or delete the oldest archived sessions by percentage.",
    // Both routes, because the verb always previews: the mutating route requires the digest the
    // preview returns and rejects a stale one, so the two are one operation.
    routes: [
      { method: "POST", path: "/api/storage/cleanup/preview" },
      { method: "POST", path: "/api/storage/cleanup" },
    ],
    flags: [
      { name: "--percent", value: "number", summary: "Portion of the oldest archived sessions to target (0-100)." },
      { name: "--mode", value: "string", summary: "quarantine (recoverable from trash) or permanent." },
      { name: "--yes", value: "boolean", summary: "Required to actually delete; without it this is a preview." },
      { name: "--json", value: "boolean", summary: "Emit the preview or result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "Without `--yes` it prints what WOULD be freed and exits 0 having changed nothing.",
      "There is no interactive confirmation: a prompt an agent can answer is not a safety boundary.",
      "`--mode quarantine` moves files to trash, so `storage trash restore` can undo it; `permanent` cannot be undone.",
    ],
  },
  {
    command: ["storage", "trash"],
    summary: "List quarantined cleanup batches, or restore one.",
    routes: [
      { method: "GET", path: "/api/storage/trash" },
      { method: "POST", path: "/api/storage/trash/restore" },
    ],
    flags: [
      { name: "--yes", value: "boolean", summary: "Required for restore, which moves files and reconciles database rows." },
      { name: "--json", value: "boolean", summary: "Emit the trash list or restore result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: ["Restore fails with a named 409 when the destination already exists, rather than overwriting it."],
  },
  {
    command: ["storage", "policy"],
    summary: "Show, change, or run the automatic archived-session cleanup policy.",
    routes: [
      { method: "GET", path: "/api/storage/cleanup-policy" },
      { method: "PUT", path: "/api/storage/cleanup-policy" },
      { method: "POST", path: "/api/storage/cleanup-policy/run" },
    ],
    flags: [
      { name: "--enabled", value: "string", summary: "true or false." },
      { name: "--percent", value: "number", summary: "Portion of oldest archived sessions each run targets." },
      { name: "--mode", value: "string", summary: "quarantine or permanent." },
      { name: "--schedule", value: "string", summary: "startup, daily, weekly, or manual." },
      { name: "--yes", value: "boolean", summary: "Required for `policy run`, which deletes immediately." },
      { name: "--json", value: "boolean", summary: "Emit the policy or run state as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "`policy set` never enables implicitly: omitting `--enabled` keeps the stored value.",
      "`policy run` forces a run regardless of schedule, so it needs `--yes`.",
    ],
  },
  {
    command: ["inspect", "config"],
    summary: "The effective merged configuration the proxy is running.",
    routes: [{ method: "GET", path: "/api/config" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the config as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "catalog"],
    summary: "The generated model catalog served to clients.",
    routes: [{ method: "GET", path: "/api/catalog" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the catalog as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "routing-analytics"],
    summary: "Aggregate routing outcomes per provider and model.",
    routes: [{ method: "GET", path: "/api/routing-analytics" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the analytics payload as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "pacing"],
    summary: "Request-pacing state for one provider or all of them.",
    routes: [{ method: "GET", path: "/api/provider-request-pacing" }],
    flags: [
      { name: "--name", value: "string", summary: "Restrict to one provider; omitted means every provider." },
      { name: "--json", value: "boolean", summary: "Emit the pacing state as JSON." },
    ],
    mutates: false,
    json: "payload",
    details: ["An unknown provider name is a 404 rather than an empty result."],
  },
  {
    command: ["inspect", "key-providers"],
    summary: "Providers that authenticate with an API key rather than OAuth.",
    routes: [{ method: "GET", path: "/api/key-providers" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the provider list as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "codex-prompt"],
    summary: "The Codex system prompt state, or the prompt text itself.",
    routes: [
      { method: "GET", path: "/api/codex-prompt" },
      { method: "GET", path: "/api/codex-prompt/text" },
    ],
    flags: [
      { name: "--text", value: "boolean", summary: "Print the prompt body verbatim instead of its metadata." },
      { name: "--json", value: "boolean", summary: "Emit the prompt metadata as JSON." },
    ],
    mutates: false,
    json: "payload",
    details: ["Read-only by design: the six mutating prompt routes require a dashboard session."],
  },
  {
    command: ["inspect", "client-config"],
    summary: "The generated configuration snippet for a supported client.",
    routes: [{ method: "GET", path: "/api/client-config" }],
    flags: [
      { name: "--client", value: "string", summary: "Required client id; the route names every accepted value on error." },
      { name: "--json", value: "boolean", summary: "Emit the snippet payload as JSON." },
    ],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "star"],
    summary: "Whether this repository is starred by the signed-in GitHub account.",
    // GET only, permanently. The POST spends the operator identity and requires a dashboard
    // session precisely so an agent cannot answer that question for them.
    routes: [{ method: "GET", path: "/api/github/star" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the star status as JSON." }],
    mutates: false,
    json: "payload",
    details: ["Starring is never available from the CLI; the verb says so rather than offering a flag that cannot work."],
  },
  {
    command: ["inspect", "windows-tray"],
    summary: "Windows tray helper state.",
    routes: [{ method: "GET", path: "/api/windows-tray" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the tray state as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["system", "codex-app-server"],
    summary: "Codex app-server reachability and process state, as the dashboard sees it.",
    routes: [{ method: "GET", path: "/api/system/codex-app-server" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the app-server state as JSON." }],
    mutates: false,
    json: "payload",
    details: [
      "The GUI reads this state directly; without a verb an agent could not tell whether the Codex app-server was reachable at all.",
    ],
  },
  {
    command: ["system", "codex-cli-update", "check"],
    summary: "Inspect a configured Codex CLI candidate and its ownership provenance.",
    routes: [],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the redacted provenance report as JSON." }],
    mutates: false,
    json: "envelope",
    details: [
      "Proof-bound published-launcher context authenticates the configured candidate snapshot, not successful Codex execution; this check does not attest or admit a selected runtime.",
      "On Windows this first slice performs no candidate or configuration filesystem I/O: only a proof-captured absolute environment candidate can receive lexical app-bundle or version-manager labels; every other Windows candidate fails closed.",
      "Makes no package-registry request.",
      "Does not execute Codex or npm, install or repair software, control a process, or write configuration or cache state.",
    ],
  },
  {
    command: ["system", "codex-cli-update", "attest"],
    summary: "Observe the selected or explicitly named Windows npm Codex installation files without enabling updates.",
    routes: [],
    flags: [
      { name: "--candidate", value: "string", summary: "Absolute npm codex.cmd or package bin/codex.js path; all four paths are all-or-none." },
      { name: "--npm-prefix", value: "string", summary: "Absolute prefix containing node_modules/@openai/codex." },
      { name: "--npm-cli", value: "string", summary: "Absolute node_modules/npm/bin/npm-cli.js path." },
      { name: "--node", value: "string", summary: "Absolute node.exe path; observed, never executed." },
      { name: "--json", value: "boolean", summary: "Emit the path-free installation identity observation." },
    ],
    mutates: false,
    json: "envelope",
    details: [
      "Opt-in Windows x64 local-volume inspection using held native file handles; refuses reparse points, active writers and unsupported layouts.",
      "Without explicit paths, the proof-bound launcher snapshot identifies the selected candidate: the configured CODEX_CLI_PATH or the first codex on the captured PATH, with an OpenCodex wrapper resolving to its codex.opencodex-real backing. Discovery only proposes paths; the held-handle observation remains the authority.",
      "Success binds observed file identities and bytes, not selected-runtime admission or installer ownership.",
      "selectionAttested, managed and applyAllowed remain false. The digest is an observation, not a durable update permit.",
      "Does not run the named Codex/npm/Node files, query a registry, install software, control processes or persist state.",
    ],
  },
  {
    command: ["system", "codex-restart"],
    summary: "Restart the Codex desktop app and app-servers.",
    routes: [{ method: "POST", path: "/api/system/codex-restart" }],
    flags: [
      { name: "--yes", value: "boolean", summary: "Required: fully quits and relaunches the operator's Codex desktop app, which may discard unsaved composer drafts, model-picker selections, and pending approval prompts; also restarts its app-servers." },
      { name: "--json", value: "boolean", summary: "Emit the restart result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "`sync --restart-codex` is not a substitute: it restarts only as a side effect after a catalog or cache write, so it cannot restart a healthy install on request.",
      "Restarts the Codex desktop app as well as the app-servers, through the same module the CLI uses. When the proxy itself runs inside the Codex app it refuses instead, because restarting the app would kill the request.",
      "--yes is mandatory because this interrupts a running editor session and may discard unsaved composer drafts, model-picker selections, and pending approval prompts; it must never happen because an agent guessed a subcommand.",
    ],
  },
  {
    command: ["claude", "config"],
    summary: "Read or update Claude Code settings, including independent CLI first-party routing.",
    routes: [{ method: "GET", path: "/api/claude-code" }, { method: "PUT", path: "/api/claude-code" }],
    flags: [
      { name: "--first-party", value: "string", summary: "For `set`, on or off; route standalone Claude CLI subscription requests through the intercept." },
      { name: "--json", value: "boolean", summary: "Emit the management response as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: ["`status` reads the route; `set` writes only submitted fields. Enabling first-party requires a running Claude intercept."],
  },
  {
    command: ["claude", "desktop", "status"],
    summary: "Applied-vs-desired Claude Desktop state, including staleness, drift, and health.",
    routes: [{ method: "GET", path: "/api/claude-desktop/status" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the live status as JSON." }],
    mutates: false,
    json: "payload",
    details: [
      "Distinct from `claude desktop show`, which reports what this machine WOULD write; this reports what is actually in effect, which only the running proxy knows.",
    ],
  },
  {
    command: ["claude", "desktop", "bind"],
    summary: "First-party: serve a Claude Desktop Code tab picker model with an opencodex route.",
    routes: [{ method: "PUT", path: "/api/claude-desktop/first-party-bindings" }],
    flags: [],
    mutates: true,
    json: "none",
    details: [
      "Takes a picker model id (claude-sonnet-4-6) and a route in the Desktop route vocabulary (provider/model or native/<slug>); the route must be one the Desktop profile can offer.",
      "Only Claude Code traffic that reaches the proxy through the first-party intercept (Desktop's Code tab, the claude CLI) honours it; ocx claude and the public Messages endpoint are unaffected.",
      "The Desktop picker keeps Anthropic's label; the binding changes which model answers, starting with the next request.",
    ],
  },
  {
    command: ["claude", "desktop", "unbind"],
    summary: "Remove a first-party Claude Desktop Code tab picker binding.",
    routes: [{ method: "PUT", path: "/api/claude-desktop/first-party-bindings" }],
    flags: [],
    mutates: true,
    json: "none",
    details: [
      "Removing an id that is not bound is a no-op; the remaining bindings are printed.",
    ],
  },
  {
    command: ["claude", "desktop", "picker", "status"],
    summary: "First-party picker mode: whether Claude Desktop's Code tab lists opencodex models, and what is missing if not.",
    routes: [{ method: "GET", path: "/api/claude-desktop/picker" }],
    flags: [],
    mutates: false,
    json: "none",
    details: [
      "Reports desired, effective, keychain trust, the Desktop egress profile, the model count and a reason with the next command to run.",
    ],
  },
  {
    command: ["claude", "desktop", "picker", "on"],
    summary: "Turn first-party picker mode on and remember the choice.",
    routes: [{ method: "PUT", path: "/api/claude-desktop/picker" }],
    flags: [],
    mutates: true,
    json: "none",
    details: [
      "Needs a running proxy, first-party mode and macOS. The first time, macOS asks to trust a local certificate authority limited to claude.ai; when the server cannot show that prompt the command runs the trust step in this terminal.",
      "Claude Desktop then reaches the network through opencodex; fully quit and reopen Desktop afterwards.",
    ],
  },
  {
    command: ["claude", "desktop", "picker", "off"],
    summary: "Turn first-party picker mode off, remove its Desktop egress profile and certificate trust, and remember the choice.",
    routes: [{ method: "PUT", path: "/api/claude-desktop/picker" }],
    flags: [],
    mutates: true,
    json: "none",
    details: [
      "Works without a running proxy: the preference is saved and the picker profile and trust are removed locally.",
    ],
  },
  {
    command: ["claude", "desktop", "picker", "trust"],
    summary: "Run the macOS keychain step for picker mode in this terminal, then ask the server to finish enabling it.",
    routes: [{ method: "PUT", path: "/api/claude-desktop/picker" }],
    flags: [],
    mutates: true,
    json: "none",
    details: [
      "The server removes trust this command added if the enable is refused; if the request is lost, trust is left alone and picker status tells what happened.",
    ],
  },
  {
    command: ["integration", "native"],
    summary: "Show or toggle the native Claude, Claude Desktop, Codex, and Grok integrations, and read the Cursor status (which builds are installed, gateway values, last request seen).",
    routes: [
      { method: "GET", path: "/api/native-integrations" },
      { method: "PUT", path: "/api/native-integrations/claude" },
      { method: "PUT", path: "/api/native-integrations/claude-desktop" },
      { method: "PUT", path: "/api/native-integrations/codex" },
      { method: "PUT", path: "/api/native-integrations/grok" },
      { method: "GET", path: "/api/native-integrations/cursor" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the client rows or toggle result as JSON." }],
    mutates: true,
    json: "payload",
    details: [
      "The list renders per-client state, installed, and desired columns; a blocked disable is named rather than left silent.",
      "Each client has its own route because a toggle rewrites that client's own config file.",
    ],
  },
  {
    command: ["integration", "client"],
    summary: "Inspect and toggle Aside profile catalogs, read their history, and restore a selected profile operation.",
    routes: [
      { method: "GET", path: "/api/client-integrations/aside/profiles" },
      { method: "PUT", path: "/api/client-integrations/aside/profiles" },
      { method: "GET", path: "/api/client-integrations/aside/profiles/{profileId}" },
      { method: "PUT", path: "/api/client-integrations/aside/profiles/{profileId}" },
      { method: "GET", path: "/api/client-integrations/aside/profiles/journal" },
      { method: "GET", path: "/api/client-integrations/aside/profiles/{profileId}/journal" },
      { method: "POST", path: "/api/client-integrations/aside/profiles/{profileId}/restore" },
    ],
    flags: [
      { name: "--client", value: "string", summary: "Select the file integration; use aside for profile controls." },
      { name: "--profile", value: "number", summary: "Select one registered Aside account; omitted toggles affect all profiles." },
      { name: "--op", value: "string", summary: "Operation ID for restore." },
      { name: "--confirm-drift", value: "boolean", summary: "Explicitly allow restore to replace subsequent edits." },
      { name: "--overwrite-conflict", value: "boolean", summary: "Explicitly allow enable to replace a conflicting provider block." },
      { name: "--json", value: "boolean", summary: "Emit the profile state, history, or mutation result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "Use status/show/list, history/journal, enable/disable, or restore after integration client.",
      "These declarations cover the dedicated Aside profile paths; existing generic client routes retain their separate parity inventory.",
    ],
  },
  {
    command: ["sync"],
    summary: "Synchronize client catalogs, including Aside profiles through the running server's mutation owner.",
    routes: [{ method: "POST", path: "/api/client-integrations/aside/sync" }],
    flags: [
      { name: "--restart-codex", value: "boolean", summary: "Restart the Codex app-servers and fully quit and relaunch the Codex desktop app after a catalog or cache write, on macOS, Linux and Windows." },
      { name: "--restart-app-server-only", value: "boolean", summary: "Restart only the Codex app-servers and leave the desktop app running; wins over --restart-codex when both are given." },
      { name: "--restart-desktop-app", value: "boolean", summary: "Deprecated alias of --restart-codex." },
    ],
    mutates: true,
    json: "none",
    details: ["The Aside refresh uses the live server; other catalog synchronization also performs local work."],
  },
  {
    command: ["agent", "request-user-input"],
    summary: "Show or set whether default mode may ask the operator a question mid-task.",
    routes: [
      { method: "GET", path: "/api/codex-auth/features/default-mode-request-user-input" },
      { method: "PUT", path: "/api/codex-auth/features/default-mode-request-user-input" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the feature state as JSON." }],
    mutates: true,
    json: "payload",
    details: ["A bare invocation reads and never writes."],
  },
  {
    command: ["api", "protocols"],
    summary: "Read the protocol contract version, API surfaces, protocol settings and feature vocabulary.",
    routes: [{ method: "GET", path: "/api/protocols" }],
    flags: [
      { name: "--provider", value: "string", summary: "Add one configured provider's upstream wire and who decided it." },
      { name: "--json", value: "boolean", summary: "Emit the GET /api/protocols body." },
    ],
    mutates: false,
    json: "payload",
  },
  {
    command: ["api", "explain"],
    summary: "Preview the request path a model would take from one inbound API, computed from config.",
    routes: [{ method: "POST", path: "/api/protocols/plan" }],
    flags: [
      { name: "--model", value: "string", required: true, summary: "Model selector as a client would send it." },
      { name: "--inbound", value: "string", required: true, summary: "Inbound API: responses, chat or messages." },
      { name: "--feature", value: "string", summary: "Request feature key to judge; repeatable or comma-separated." },
      { name: "--json", value: "boolean", summary: "Emit the ProtocolPlanV1 preview." },
    ],
    mutates: false,
    json: "payload",
    details: ["A read-only POST: nothing is sent upstream, no combo state advances and the input is not logged."],
  },
  {
    command: ["api", "policy"],
    summary: "Read the protocol policy, or change the Messages surface, unrepresentable policy and rollout switches.",
    routes: [
      { method: "GET", path: "/api/protocols" },
      { method: "PATCH", path: "/api/protocols/settings" },
    ],
    flags: [
      { name: "--messages", value: "string", summary: "Open or close the Messages API: on or off. Off also turns the Claude integration off." },
      { name: "--unrepresentable", value: "string", summary: "legacy keeps today's behavior; reject refuses a request its path cannot carry." },
      { name: "--rollout", value: "string", summary: "One switch as name=on or name=off; repeatable. Every switch defaults off." },
      { name: "--json", value: "boolean", summary: "Emit the resulting GET /api/protocols body." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "A bare invocation reads and never writes.",
      "A setting flag changes the operator's config; run it only when the operator asks for that change.",
    ],
  },
];

/** Capabilities that drive `route`, for `ocx capabilities --route`. */
export function capabilitiesForRoute(path: string): Capability[] {
  return CAPABILITIES.filter(cap => cap.routes.some(r => r.path === path));
}

/** Every `(method, path)` pair any capability drives. */
export function capabilityRouteKeys(): Set<string> {
  const keys = new Set<string>();
  for (const cap of CAPABILITIES) {
    for (const route of cap.routes) keys.add(`${route.method} ${route.path}`);
  }
  return keys;
}

/** Rendered command path, e.g. `ocx account pause`. */
export function capabilityInvocation(cap: Capability): string {
  return `ocx ${cap.command.join(" ")}`;
}
